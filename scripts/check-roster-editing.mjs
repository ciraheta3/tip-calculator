// Independent disposable LOCAL design gate; preserve the original security suite.
import { local, audit } from './supabase-local.mjs'
import { rosterEditingGate } from '../supabase/integration/roster-editing.mjs'

try {
  console.log('Starting independent local shared-roster editing design gate.')
  local('start')
  for (let pass = 1; pass <= 2; pass++) {
    console.log(`Shared-roster design gate: clean local migration replay ${pass}/2.`)
    local('reset')
    audit()
    await rosterEditingGate()
  }
  console.log('Local shared-roster transport/RLS/observed conflict checks passed on both replays.')
} catch {
  // Assertion/SDK errors may contain requests, sessions or raw vendor output.
  console.error('Local shared-roster design gate failed; editing must remain blocked. No hosted compatibility or concurrency guarantee is established.')
  process.exitCode = 1
} finally {
  try { local('clean') } catch {
    console.error('Local integration cleanup failed; inspect the disposable local project privately.')
    process.exitCode = 1
  }
}
