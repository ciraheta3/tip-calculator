// Actual local Auth-issued sessions + pinned gateway + real SDK. No hosted path.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { registerHooks } from 'node:module'
import { credentials as localCredentials, sql as localSql } from '../../scripts/supabase-local.mjs'

const roleProjection = 'id,organization_id,name,is_active,default_weight::text,updated_at,xmin::text'
const employeeProjection = 'id,organization_id,name,is_active,default_role_id,default_weight_override::text,updated_at,xmin::text'
const q = value => {
  assert.match(value, /^[0-9a-f-]{36}$/)
  return `'${value}'::uuid`
}
const same = (actual, expected, label) => assert.ok(JSON.stringify(actual) === JSON.stringify(expected), label)
const noError = result => assert.ok(!result.error, 'SDK request must succeed; details withheld')
const one = result => {
  noError(result)
  assert.ok(Array.isArray(result.data) && result.data.length === 1, 'exactly one returned row required')
  return result.data[0]
}
const code = (result, expected) => assert.ok(result.error?.code === expected, 'expected database denial code; details withheld')

export async function rosterEditingGate({ credentials = localCredentials, sql = localSql } = {}) {
  const config = credentials() // Guarded local CLI status, never environment keys.
  assert.match(config.API_URL, /^http:\/\/127\.0\.0\.1:\d+$/)
  same(sql('SELECT (SELECT count(*) FROM auth.users) + (SELECT count(*) FROM public.organizations);'), '0', 'fresh local fixture required')
  const organizations = [randomUUID(), randomUUID()]
  const authRequest = async (path, body, token) => {
    const response = await fetch(`${config.API_URL}/auth/v1/${path}`, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { apikey: config.ANON_KEY, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    assert.ok(response.status === 200, 'local Auth request must succeed')
    return response.json()
  }
  const users = []
  for (let n = 0; n < 4; n++) {
    const email = `roster-gate-${randomUUID()}@example.test`
    const password = randomBytes(32).toString('base64url')
    const signup = await authRequest('signup', { email, password })
    const session = await authRequest('token?grant_type=password', { email, password })
    const verified = await authRequest('user', undefined, session.access_token)
    assert.ok(verified.id === session.user.id && verified.id === signup.user.id, 'real Auth identity must match')
    users.push({ id: verified.id, token: session.access_token, refresh: session.refresh_token })
  }
  // Only this disposable database's trusted setup; no Auth SQL writes/grant changes.
  sql(`BEGIN;
    INSERT INTO public.organizations (id,name) VALUES (${q(organizations[0])},'Fictional editing gate A'),(${q(organizations[1])},'Fictional editing gate B');
    INSERT INTO public.organization_memberships (organization_id,user_id,role) VALUES
      (${q(organizations[0])},${q(users[0].id)},'admin'),
      (${q(organizations[0])},${q(users[1].id)},'closer'),
      (${q(organizations[1])},${q(users[2].id)},'admin');
    COMMIT;`)
  const wire = []
  function client(user) {
    return createClient(config.API_URL, config.ANON_KEY, {
      accessToken: async () => user?.token ?? null,
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async (input, init = {}) => {
        const url = new URL(String(input))
        assert.ok(url.origin === config.API_URL && /^\/rest\/v1\/(job_roles|employees|organization_memberships)$/.test(url.pathname), 'SDK restricted to local roster tables')
        assert.ok(['GET', 'POST', 'PATCH'].includes(init.method ?? 'GET'), 'only scoped reads/inserts/patches')
        if (init.body) {
          const body = JSON.parse(init.body)
          for (const field of ['default_weight', 'default_weight_override']) {
            if (Object.hasOwn(body, field)) assert.ok(body[field] === null || typeof body[field] === 'string', 'outgoing decimal must be a string or actual NULL')
          }
          wire.push({ method: init.method, body })
        }
        return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) })
      } },
    })
  }
  const [admin, closer, foreign, nonmember] = users.map(client)
  const anon = client()
  const org = organizations[0]
  const snapshot = () => sql(`SELECT jsonb_build_array(${['organizations', 'organization_memberships', 'job_roles', 'employees'].map(t => `(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM public.${t} t)`).join(',')});`)
  const read = (sdk, table, projection, id) => sdk.from(table).select(projection).eq('organization_id', org).eq('id', id).retry(false)
  const patch = (sdk, table, projection, row, body) => sdk.from(table).update(body).eq('organization_id', org).eq('id', row.id).eq('xmin', row.xmin).select(projection).retry(false)
  const roleRows = []
  const employeeRows = []
  console.log('Local gate: real Auth identities and active admin/closer/foreign/nonmember contexts verified.')
  for (const [index, weight] of ['0', '0.01', '1', '100.50', '90071992547409.91'].entries()) {
    const sdk = index % 2 ? closer : admin
    const role = one(await sdk.from('job_roles').insert({ organization_id: org, name: `Fictional gate role ${index}`, default_weight: weight, is_active: true }).select(roleProjection).retry(false))
    assert.ok(role.organization_id === org && typeof role.default_weight === 'string', 'role exact text and selected org required')
    same(role.default_weight, weight, 'INSERT returning cast must preserve exact decimal text/scale')
    same(one(await read(sdk, 'job_roles', roleProjection, role.id)), role, 'GET cast must equal INSERT returning')
    same(sql(`SELECT default_weight::text FROM public.job_roles WHERE id=${q(role.id)};`), weight, 'independent persisted numeric text')
    roleRows.push(role)
    for (const override of [null, weight]) {
      const employee = one(await sdk.from('employees').insert({ organization_id: org, name: 'Fictional duplicate employee', default_role_id: role.id, default_weight_override: override, is_active: true }).select(employeeProjection).retry(false))
      assert.ok(employee.organization_id === org, 'employee selected org required')
      same(employee.default_weight_override, override, 'override exact string or actual NULL required')
      same(one(await read(sdk, 'employees', employeeProjection, employee.id)), employee, 'GET preserves NULL and decimal text')
      same(sql(`SELECT coalesce(default_weight_override::text,'INHERIT') FROM public.employees WHERE id=${q(employee.id)};`), override ?? 'INHERIT', 'independent override numeric text/NULL')
      employeeRows.push(employee)
    }
  }
  assert.ok(wire.every(request => request.method === 'POST'), 'transport inserts explicitly initiated only once')
  console.log('Local gate: numeric ::text GET/INSERT returning, decimal string writes, NULL and explicit zero passed, including the maximum.')
  for (const [table, projection, row, field] of [
    ['job_roles', roleProjection, roleRows[3], 'default_weight'],
    ['employees', employeeProjection, employeeRows[7], 'default_weight_override'],
  ]) {
    let current = row
    for (const value of ['90071992547409.91', '0.01', '100.50', '0', ...(table === 'employees' ? [null] : [])]) {
      const result = one(await patch(closer, table, projection, current, { [field]: value, is_active: false }))
      same(result[field], value, 'PATCH returning preserves exact weight or NULL')
      assert.ok(typeof result.xmin === 'string' && result.xmin !== current.xmin, 'committed update changes transaction token')
      const stale = await patch(admin, table, projection, current, { name: 'Fictional stale edit' })
      noError(stale)
      same(stale.data, [], 'old transaction token must affect zero rows, never success')
      current = result
    }
    const concurrent = await Promise.all([
      patch(admin, table, projection, current, { name: 'Fictional concurrent admin' }),
      patch(closer, table, projection, current, { name: 'Fictional concurrent closer' }),
    ])
    concurrent.forEach(noError)
    same(concurrent.map(result => result.data.length).sort(), [0, 1], 'observed concurrent updates: exactly one winner and one conflict')
    const winner = concurrent.find(result => result.data.length === 1).data[0]
    same(one(await read(admin, table, projection, current.id)), winner, 'fresh reload matches committed winner')
    current = one(await patch(admin, table, projection, winner, { is_active: true }))
    assert.ok(current.is_active, 'reactivation preserves associations')
  }
  console.log('Local gate: PATCH casts/NULL, xmin returning/filtering, stale zero-row conflicts and observed two-operator races passed.')
  for (const value of ['-1', 'NaN', 'Infinity', '1.001', '1.000', '90071992547409.92', 'malformed']) {
    const before = snapshot()
    const role = await admin.from('job_roles').insert({ organization_id: org, name: 'Fictional invalid', default_weight: value }).select(roleProjection).retry(false)
    assert.ok(role.error, 'database must reject invalid weight without rounding')
    const employee = await closer.from('employees').insert({ organization_id: org, name: 'Fictional invalid', default_role_id: roleRows[0].id, default_weight_override: value }).select(employeeProjection).retry(false)
    assert.ok(employee.error, 'database must reject invalid override without rounding')
    same(snapshot(), before, 'invalid strings change no application rows')
  }
  // Lexical exponent rejection belongs in the input codec: PostgreSQL numeric
  // accepts some exponent strings. Do not misrepresent that as a DB constraint.
  const forbidden = async (sdk, table, projection, row, body) => {
    const before = snapshot()
    code(await sdk.from(table).insert(body).select(projection).retry(false), '42501')
    const result = await sdk.from(table).update({ name: 'Fictional denied' }).eq('organization_id', org).eq('id', row.id).select(projection).retry(false)
    if (sdk === anon) code(result, '42501')
    else { noError(result); same(result.data, [], 'RLS-hidden update is zero rows') }
    same(snapshot(), before, 'denied insert/update changes no rows')
  }
  for (const [table, projection, row, body] of [
    ['job_roles', roleProjection, roleRows[0], { organization_id: org, name: 'Fictional denied', default_weight: '1.00' }],
    ['employees', employeeProjection, employeeRows[0], { organization_id: org, name: 'Fictional denied', default_role_id: roleRows[0].id, default_weight_override: null }],
  ]) {
    for (const sdk of [anon, foreign, nonmember]) await forbidden(sdk, table, projection, row, body)
    for (const field of ['id', 'created_at', 'updated_at']) {
      const value = field === 'id' ? randomUUID() : '2100-01-01T00:00:00Z'
      const before = snapshot()
      code(await admin.from(table).insert({ ...body, [field]: value }).select(projection).retry(false), '42501')
      code(await closer.from(table).update({ [field]: value }).eq('organization_id', org).eq('id', row.id).select(projection).retry(false), '42501')
      same(snapshot(), before, 'protected columns remain immutable')
    }
    const before = snapshot()
    code(await admin.from(table).update({ organization_id: organizations[1] }).eq('organization_id', org).eq('id', row.id).select(projection).retry(false), '42501')
    same(snapshot(), before, 'tenant move denied')
  }
  const beforeDuplicate = snapshot()
  code(await admin.from('job_roles').insert({ organization_id: org, name: roleRows[0].name.toUpperCase(), default_weight: '1' }).select(roleProjection).retry(false), '23505')
  code(await closer.from('employees').insert({ organization_id: organizations[1], name: 'Fictional wrong role', default_role_id: roleRows[0].id }).select(employeeProjection).retry(false), '42501')
  same(snapshot(), beforeDuplicate, 'duplicate and foreign inserts change no rows')
  const otherRole = one(await foreign.from('job_roles').insert({ organization_id: organizations[1], name: 'Fictional foreign role', default_weight: '1.00' }).select(roleProjection).retry(false))
  const beforeForeignRole = snapshot()
  code(await admin.from('employees').insert({ organization_id: org, name: 'Fictional wrong role', default_role_id: otherRole.id, default_weight_override: null }).select(employeeProjection).retry(false), '23503')
  same(snapshot(), beforeForeignRole, 'cross-tenant FK denial persists nothing')
  // Exercise the actual TypeScript application adapter, including exact-count
  // handling, through real SDK Auth state and server-verification calls. Node 24
  // strips types; this scoped resolver only supplies local source extensions.
  const sourceRoot = new URL('../../src/', import.meta.url).href
  const hook = registerHooks({ resolve(specifier, context, next) {
    return next(specifier.startsWith('./') && context.parentURL?.startsWith(sourceRoot) && !/\.[a-z]+$/.test(specifier)
      ? `${specifier}.ts` : specifier, context)
  } })
  let app
  try { app = await import('../../src/sharedRosterEditingData.ts') } finally { hook.deregister() }
  const online = Object.getOwnPropertyDescriptor(navigator, 'onLine')
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
  const actual = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  try {
    const signedIn = await actual.auth.setSession({ access_token: users[0].token, refresh_token: users[0].refresh })
    assert.ok(!signedIn.error && signedIn.data.user.id === users[0].id, 'SDK holds real verified Auth identity')
    const signal = new AbortController().signal
    let current = await app.loadEditingRoster(actual, users[0].id, org, signal)
    const added = await app.saveRosterDraft(actual, users[0].id, org, signal, current, { kind: 'role', name: '  Fictional app adapter  ', weight: '90071992547409.91', active: true })
    assert.ok(added.default_weight === '90071992547409.91', 'actual adapter confirms exact maximum and affected count')
    current = await app.loadEditingRoster(actual, users[0].id, org, signal)
    const changed = await app.saveRosterDraft(actual, users[0].id, org, signal, current, { kind: 'role', name: added.name, weight: '0.01', active: false }, added.id)
    assert.ok(changed.default_weight === '0.01' && changed.xmin !== added.xmin, 'actual adapter confirms exact PATCH and new token')
    await assert.rejects(() => app.saveRosterDraft(actual, users[0].id, org, signal, current, { kind: 'role', name: 'Fictional stale app edit', weight: '1', active: true }, added.id), error => error instanceof app.RosterEditError && error.reload)
    current = await app.loadEditingRoster(actual, users[0].id, org, signal)
    const target = current.employees[0]
    for (const weight of ['0', '']) {
      const saved = await app.saveRosterDraft(actual, users[0].id, org, signal, current, { kind: 'employee', name: target.name, roleId: target.default_role_id, weight, active: true }, target.id)
      assert.ok(saved.default_weight_override === (weight === '' ? null : '0.00'), 'actual adapter preserves NULL versus zero')
      current = await app.loadEditingRoster(actual, users[0].id, org, signal)
    }
    console.log('Local gate: actual application adapter, real SDK Auth verification, exact affected counts, string/NULL transport and stale-edit rejection passed.')
  } finally {
    if (online) Object.defineProperty(navigator, 'onLine', online)
    else delete navigator.onLine
    actual.auth.stopAutoRefresh()
  }
  for (const user of users.slice(0, 2)) {
    sql(`UPDATE public.organization_memberships SET is_active=false WHERE organization_id=${q(org)} AND user_id=${q(user.id)};`)
    const verified = await authRequest('user', undefined, user.token)
    assert.ok(verified.id === user.id, 'original Auth session still valid after database revocation')
    const sdk = user === users[0] ? admin : closer
    await forbidden(sdk, 'job_roles', roleProjection, roleRows[0], { organization_id: org, name: 'Fictional revoked', default_weight: '0' })
    await forbidden(sdk, 'employees', employeeProjection, employeeRows[0], { organization_id: org, name: 'Fictional revoked', default_role_id: roleRows[0].id, default_weight_override: null })
  }
  console.log('Local gate: admin/closer, foreign/nonmember/anonymous/revoked denial, protected ACLs, uniqueness, invalid weights and tenant FK checks passed.')
}
