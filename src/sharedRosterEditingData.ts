import type { SupabaseClient } from '@supabase/supabase-js';
import { sharedOverrideInput, sharedOverrideText, sharedWeightInput, sharedWeightText } from './sharedRosterWeights';

export type EditRole = { id: string; organization_id: string; name: string; is_active: boolean; default_weight: string; xmin: string };
export type EditEmployee = Omit<EditRole, 'default_weight'> & { default_role_id: string; default_weight_override: string | null };
export type EditSnapshot = { roles: EditRole[]; employees: EditEmployee[]; loadedAt: number; wallAt: number };
export type RosterDraft = { kind: 'role'; name: string; weight: string; active: boolean }
  | { kind: 'employee'; name: string; roleId: string; weight: string; active: boolean };
export const roleProjection = 'id,organization_id,name,is_active,default_weight::text,xmin::text';
export const employeeProjection = 'id,organization_id,name,is_active,default_role_id,default_weight_override::text,xmin::text';
const lifetime = 60_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = 'Shared data could not be verified. Refresh access before editing.';
const denied = 'Restaurant access could not be verified. Refresh access before editing.';
const uncertain = 'Save could not be confirmed. Refresh the roster and inspect it before another save; do not resubmit an uncertain addition.';

export class RosterEditError extends Error {
  readonly reload: boolean;
  constructor(message: string, reload = true) { super(message); this.reload = reload; }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RosterEditError(invalid);
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new RosterEditError(invalid);
  return value;
}
function named(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || [...value].length > max) throw new RosterEditError(invalid);
  return value;
}
function base(value: unknown, org: string, max: number) {
  const row = record(value);
  if (row.organization_id !== org || typeof row.is_active !== 'boolean' || typeof row.xmin !== 'string'
    || !/^[1-9]\d{0,9}$/.test(row.xmin) || BigInt(row.xmin) > 4294967295n) throw new RosterEditError(invalid);
  return { id: uuid(row.id), organization_id: org, name: named(row.name, max), is_active: row.is_active, xmin: row.xmin };
}
function role(value: unknown, org: string): EditRole {
  return { ...base(value, org, 100), default_weight: sharedWeightText(record(value).default_weight) };
}
function employee(value: unknown, org: string): EditEmployee {
  return { ...base(value, org, 160), default_role_id: uuid(record(value).default_role_id), default_weight_override: sharedOverrideText(record(value).default_weight_override) };
}
function checkedRows(result: { data: unknown; count: number | null; error: unknown }): unknown[] {
  if (result.error) throw new RosterEditError('Unable to load shared data. Check your connection and refresh access.');
  if (!Array.isArray(result.data) || result.count !== result.data.length || result.data.length > 1000) throw new RosterEditError(invalid);
  return result.data;
}

// All operations require a freshly server-verified identity, rather than trusting
// cached session metadata. Auth events abort the manager's current generation.
async function verify(client: SupabaseClient, userId: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!navigator.onLine) throw new RosterEditError('You are offline. Reconnect and refresh access before editing.');
  const { data, error } = await client.auth.getSession();
  signal.throwIfAborted();
  const session = data.session;
  if (error || !session || session.user.id !== userId || !session.expires_at || session.expires_at * 1000 <= Date.now()) throw new RosterEditError(denied);
  const checked = await client.auth.getUser(session.access_token);
  signal.throwIfAborted();
  if (checked.error || checked.data.user?.id !== userId) throw new RosterEditError(denied);
  const current = await client.auth.getSession();
  signal.throwIfAborted();
  if (current.error || current.data.session?.access_token !== session.access_token || current.data.session?.user.id !== userId) throw new RosterEditError(denied);
}

async function access(client: SupabaseClient, userId: string, org: string, signal: AbortSignal) {
  await verify(client, userId, signal);
  uuid(org); uuid(userId);
  const rows = checkedRows(await client.from('organization_memberships')
    .select('organization_id,user_id,role,is_active', { count: 'exact' }).eq('organization_id', org)
    .eq('user_id', userId).eq('is_active', true).range(0, 999).abortSignal(signal).retry(false).returns<unknown[]>());
  signal.throwIfAborted();
  if (rows.length !== 1) throw new RosterEditError(denied);
  const row = record(rows[0]);
  if (row.organization_id !== org || row.user_id !== userId || row.is_active !== true || !['admin', 'closer'].includes(String(row.role))) throw new RosterEditError(denied);
}

export async function loadEditingRoster(client: SupabaseClient, userId: string, org: string, signal: AbortSignal): Promise<EditSnapshot> {
  const loadedAt = performance.now();
  const wallAt = Date.now();
  await access(client, userId, org, signal);
  const [roles, employees] = await Promise.all([
    client.from('job_roles').select(roleProjection, { count: 'exact' }).eq('organization_id', org).order('name').order('id').range(0, 999).abortSignal(signal).retry(false).returns<unknown[]>(),
    client.from('employees').select(employeeProjection, { count: 'exact' }).eq('organization_id', org).order('name').order('id').range(0, 999).abortSignal(signal).retry(false).returns<unknown[]>(),
  ]);
  signal.throwIfAborted();
  try {
    const result = { roles: checkedRows(roles).map(row => role(row, org)), employees: checkedRows(employees).map(row => employee(row, org)), loadedAt, wallAt };
    if (new Set(result.roles.map(row => row.id)).size !== result.roles.length
      || new Set(result.employees.map(row => row.id)).size !== result.employees.length
      || result.employees.some(row => !result.roles.some(r => r.id === row.default_role_id))) throw new RosterEditError(invalid);
    await access(client, userId, org, signal);
    return result;
  } catch (error) { throw error instanceof RosterEditError ? error : new RosterEditError(invalid); }
}

function fresh(snapshot: EditSnapshot) {
  // Wall time also covers browsers whose monotonic clock pauses during OS sleep.
  const elapsed = performance.now() - snapshot.loadedAt;
  const wallElapsed = Date.now() - snapshot.wallAt;
  if (elapsed >= lifetime || elapsed < 0 || wallElapsed >= lifetime || wallElapsed < 0) throw new RosterEditError('This editing snapshot expired. Refresh the roster before saving.');
}

export async function saveRosterDraft(client: SupabaseClient, userId: string, org: string, signal: AbortSignal, snapshot: EditSnapshot, draft: RosterDraft, id?: string) {
  fresh(snapshot);
  const max = draft.kind === 'role' ? 100 : 160;
  const name = draft.name.trim();
  if (!name || [...name].length > max) throw new RosterEditError(`Name is required and must be at most ${max} characters.`, false);
  const target = id ? (draft.kind === 'role' ? snapshot.roles : snapshot.employees).find(row => row.id === id) : undefined;
  if (id && !target) throw new RosterEditError(invalid);
  let body: { name: string; is_active: boolean; default_weight: string } | { name: string; is_active: boolean; default_role_id: string; default_weight_override: string | null };
  try {
    body = draft.kind === 'role'
      ? { name, default_weight: sharedWeightInput(draft.weight), is_active: draft.active }
      : { name, default_role_id: uuid(draft.roleId), default_weight_override: sharedOverrideInput(draft.weight), is_active: draft.active };
  } catch { throw new RosterEditError('Use a nonnegative share weight up to 90071992547409.91 with at most two decimal places. Leave an employee override blank to inherit.', false); }
  await access(client, userId, org, signal);
  if (draft.kind === 'employee') {
    const selected = snapshot.roles.find(row => row.id === draft.roleId);
    const unchanged = target && 'default_role_id' in target && target.default_role_id === draft.roleId;
    if (!selected || (!selected.is_active && !unchanged)) throw new RosterEditError('Choose an active role for a new assignment.', false);
    if (!unchanged) {
      const current = checkedRows(await client.from('job_roles').select('id,organization_id,is_active', { count: 'exact' })
        .eq('organization_id', org).eq('id', draft.roleId).abortSignal(signal).retry(false).returns<unknown[]>());
      signal.throwIfAborted();
      if (current.length !== 1 || record(current[0]).id !== draft.roleId || record(current[0]).organization_id !== org || record(current[0]).is_active !== true) throw new RosterEditError('The selected role changed. Refresh the roster before assigning it.');
    }
  }
  signal.throwIfAborted(); fresh(snapshot);
  const table = draft.kind === 'role' ? 'job_roles' : 'employees';
  const projection = draft.kind === 'role' ? roleProjection : employeeProjection;
  let result;
  try {
    const request = target
      ? client.from(table).update(body, { count: 'exact' }).eq('organization_id', org).eq('id', target.id).eq('xmin', target.xmin)
      : client.from(table).insert({ organization_id: org, ...body }, { count: 'exact' });
    result = await request.select(projection).abortSignal(signal).retry(false).returns<unknown[]>();
  } catch { throw new RosterEditError(uncertain); }
  signal.throwIfAborted();
  if (result.error) {
    const code = result.error.code;
    if (code === '23505') throw new RosterEditError('A job role with that name already exists in this restaurant.', false);
    if (code === '23503') throw new RosterEditError('The default role is unavailable in this restaurant. Refresh the roster.');
    if (code === '23514' || code === '22P02') throw new RosterEditError('The server rejected these values. Check the name and share weight.', false);
    if (code === '42501' || result.status === 401 || result.status === 403) throw new RosterEditError(denied);
    throw new RosterEditError(uncertain);
  }
  if (target && Array.isArray(result.data) && result.data.length === 0 && result.count === 0) throw new RosterEditError('This row changed or access was revoked. Nothing was confirmed saved. Refresh the roster before editing again.');
  try {
    if (!Array.isArray(result.data) || result.data.length !== 1 || result.count !== 1) throw new Error();
    const saved = draft.kind === 'role' ? role(result.data[0], org) : employee(result.data[0], org);
    if ((target && (saved.id !== target.id || saved.xmin === target.xmin))
      || Object.entries(body).some(([key, value]) => record(result.data![0])[key] !== value)) throw new Error();
    await access(client, userId, org, signal);
    return saved;
  } catch { throw new RosterEditError(uncertain); }
}
