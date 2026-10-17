// Narrow local component proof, NOT a Supabase CLI/managed-role/Kong pass.
// Real GoTrue sessions and PostgREST 16.4, with mock API-role bootstrap on PG 17.
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { randomUUID, randomBytes, createHmac } from 'node:crypto'
import { rosterEditingGate } from '../supabase/integration/roster-editing.mjs'

const suffix = randomUUID(), network = `roster-gate-${suffix}`
const db = `roster-db-${suffix}`, auth = `roster-auth-${suffix}`, rest = `roster-rest-${suffix}`
const env = { ...process.env }
let failureCode = 'unavailable'
for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key]
function docker(args, input) {
  const r = spawnSync('docker', ['--host=unix:///var/run/docker.sock', ...args], { env, input, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
  if (r.error || r.status !== 0) {
    failureCode = /ERROR:\s+([0-9A-Z]{5})\b/.exec(r.stderr ?? '')?.[1] ?? 'unavailable'
    throw new Error(`Local component Docker ${args[0]} failed; vendor output withheld.`)
  }
  return r.stdout.trim()
}
const sql = input => docker(['exec', '-i', db, 'psql', '-X', '-qAt', '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=sqlstate', '-U', 'postgres'], input)
const nativeFetch = globalThis.fetch
const pause = () => new Promise(resolve => setTimeout(resolve, 500))
const created = []
let madeNetwork = false
let stage = 'local Docker setup'
function cleanup() {
  globalThis.fetch = nativeFetch
  let failed = false
  for (const name of created.reverse()) try { docker(['rm', '-f', name]) } catch { failed = true }
  if (madeNetwork) try { docker(['network', 'rm', network]) } catch { failed = true }
  if (failed) { console.error('Local component cleanup failed; inspect this disposable local run privately.'); process.exitCode = 1 }
}
for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143]]) process.on(signal, () => { cleanup(); process.exit(status) })
async function ready(url) {
  for (let i = 0; i < 120; i++) {
    try { if ((await nativeFetch(url, { signal: AbortSignal.timeout(1000) })).ok) return } catch { /* bounded local startup */ }
    await pause()
  }
  throw new Error('Component readiness deadline exceeded.')
}
function port(name, key) {
  const ports = JSON.parse(docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name]))
  const mapping = ports[key]?.[0]
  if (mapping?.HostIp !== '127.0.0.1' || !/^\d+$/.test(mapping.HostPort)) throw new Error('Only loopback bindings permitted.')
  return `http://127.0.0.1:${mapping.HostPort}`
}
try {
  docker(['info'])
  docker(['network', 'create', network]); madeNetwork = true
  docker(['run', '-d', '--rm', '--name', db, '--network', network, '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_PASSWORD=disposable-local-only', 'postgres:17-bookworm']); created.push(db)
  stage = 'PostgreSQL readiness'
  let available = false
  for (let i = 0; i < 120; i++) {
    try { sql('SELECT 1;'); available = true; break } catch { /* initial bootstrap */ }
    await pause()
  }
  if (!available) throw new Error('Database readiness deadline exceeded.')
  sql('CREATE SCHEMA auth;')
  const secret = randomBytes(48).toString('base64url')
  stage = 'real local GoTrue startup'
  docker(['run', '-d', '--rm', '--name', auth, '--network', network, '-p', '127.0.0.1::9999',
    '-e', 'GOTRUE_API_HOST=0.0.0.0', '-e', 'GOTRUE_API_PORT=9999', '-e', 'API_EXTERNAL_URL=http://127.0.0.1:9999',
    '-e', 'GOTRUE_SITE_URL=http://127.0.0.1:5173', '-e', 'GOTRUE_DB_DRIVER=postgres',
    '-e', `GOTRUE_DB_DATABASE_URL=postgres://postgres:disposable-local-only@${db}:5432/postgres?search_path=auth`,
    '-e', `GOTRUE_JWT_SECRET=${secret}`, '-e', 'GOTRUE_JWT_EXP=3600', '-e', 'GOTRUE_JWT_AUD=authenticated',
    '-e', 'GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated', '-e', 'GOTRUE_EXTERNAL_EMAIL_ENABLED=true',
    '-e', 'GOTRUE_MAILER_AUTOCONFIRM=true', '-e', 'GOTRUE_RATE_LIMIT_EMAIL_SENT=100', '-e', 'GOTRUE_LOG_LEVEL=error',
    'ghcr.io/supabase/gotrue:v2.197.0']); created.push(auth)
  const authUrl = port(auth, '9999/tcp')
  await ready(`${authUrl}/health`)
  stage = 'mock API-role bootstrap after real GoTrue migrations'
  // GoTrue creates auth.users and auth.uid itself. Retain those actual objects;
  // only provision the mock API roles/grants from the independent SQL fixture.
  const bootstrap = readFileSync('supabase/tests/bootstrap.sql', 'utf8')
  if (!bootstrap.includes('CREATE SCHEMA auth;\nCREATE TABLE auth.users (id uuid PRIMARY KEY);')) throw new Error('Unexpected mock bootstrap.')
  if (sql("SELECT to_regprocedure('auth.uid()') IS NOT NULL;") !== 't') throw new Error('GoTrue auth.uid missing.')
  sql(bootstrap.replace('CREATE SCHEMA auth;\nCREATE TABLE auth.users (id uuid PRIMARY KEY);', '')
    .replace(/CREATE FUNCTION auth\.uid\(\) RETURNS uuid[\s\S]*?\$\$;\n/, ''))
  stage = 'unchanged application migrations'
  for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort()) sql(readFileSync(`supabase/migrations/${file}`, 'utf8'))
  sql("CREATE ROLE component_gateway LOGIN NOINHERIT PASSWORD 'disposable-local-only'; GRANT anon, authenticated TO component_gateway;")
  stage = 'real local PostgREST startup'
  docker(['run', '-d', '--rm', '--name', rest, '--network', network, '-p', '127.0.0.1::3000',
    '-e', `PGRST_DB_URI=postgres://component_gateway:disposable-local-only@${db}:5432/postgres`,
    '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${secret}`,
    'ghcr.io/supabase/postgrest:v16.4']); created.push(rest)
  const restUrl = port(rest, '3000/tcp')
  await ready(restUrl)
  // Only route local service prefixes; actual JSON requests/responses are untouched.
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input))
    if (url.origin !== restUrl) throw new Error('Nonlocal component request refused.')
    const isAuth = url.pathname.startsWith('/auth/v1/')
    if (!isAuth && !url.pathname.startsWith('/rest/v1/')) throw new Error('Unknown component request refused.')
    return nativeFetch(`${isAuth ? authUrl : restUrl}${url.pathname.slice(8)}${url.search}`, init)
  }
  // Only the anonymous API key is synthetic; every user JWT is GoTrue-issued.
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const parts = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role: 'anon', exp: Math.floor(Date.now() / 1000) + 3600 })}`
  const key = `${parts}.${createHmac('sha256', secret).update(parts).digest('base64url')}`
  stage = 'real Auth/PostgREST/SDK transport and concurrency assertions'
  console.log('Local component gate: PostgreSQL 17, GoTrue v2.197.0 and PostgREST v16.4; mock API roles, no Kong or CLI ledger.')
  await rosterEditingGate({ credentials: () => ({ API_URL: restUrl, ANON_KEY: key }), sql })
  console.log('Local component gate passed; full Supabase CLI and managed-role checks remain separate.')
} catch {
  console.error(`Local component gate failed during ${stage} (SQLSTATE ${failureCode}); details withheld. No full-stack or hosted pass claimed.`)
  process.exitCode = 1
} finally { cleanup() }
