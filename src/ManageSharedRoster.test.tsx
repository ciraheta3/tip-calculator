// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import ManageSharedRoster from './ManageSharedRoster';
import Calculator from './Calculator';
import SharedRoster from './SharedRoster';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const userId = id(1), org = id(2), foreign = id(3);
const session = { user: { id: userId }, access_token: 'fictional-session', expires_at: Date.now() / 1000 + 3600 } as Session;
type Table = 'job_roles' | 'employees' | 'organization_memberships' | 'organizations';
type Row = Record<string, unknown>;
let tables: Record<Table, Row[]>;
let client: SupabaseClient;
let requests: { table: Table; url: URL; init: RequestInit }[];
let intercept: (table: Table, url: URL, init: RequestInit) => Response | Promise<Response> | undefined;
let emit: () => void;
let auth: { getSession: ReturnType<typeof vi.fn>; getUser: ReturnType<typeof vi.fn>; onAuthStateChange: ReturnType<typeof vi.fn> };
function response(rows: unknown[], status = 200, count = rows.length) {
  return new Response(JSON.stringify(rows), { status, headers: { 'Content-Type': 'application/json', 'Content-Range': rows.length ? `0-${rows.length - 1}/${count}` : `*/${count}` } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function query(table: Table, url: URL, init: RequestInit) {
  const matches = (row: Row) => [...url.searchParams].every(([key, value]) => !value.startsWith('eq.') || String(row[key]) === value.slice(3));
  const method = init.method ?? 'GET';
  let rows = tables[table].filter(matches);
  if (method === 'PATCH') {
    const body = JSON.parse(String(init.body));
    rows.forEach(row => Object.assign(row, body, { xmin: String(BigInt(String(row.xmin)) + 1n) }));
  }
  if (method === 'POST') {
    const row = { ...JSON.parse(String(init.body)), id: id(100 + requests.length), xmin: '1000' };
    tables[table].push(row); rows = [row];
  }
  const fields = url.searchParams.get('select')!.split(',').map(column => column.replace('::text', ''));
  return response(rows.map(row => Object.fromEntries(fields.map(field => [field, row[field]]))), method === 'POST' ? 201 : 200);
}
beforeEach(() => {
  tables = {
    organizations: [{ id: org, name: 'Fictional restaurant A' }],
    organization_memberships: [{ organization_id: org, user_id: userId, role: 'admin', is_active: true }],
    job_roles: [
      { id: id(4), organization_id: org, name: 'Fictional server', is_active: true, default_weight: '100.50', xmin: '701' },
      { id: id(5), organization_id: org, name: 'Fictional retired role', is_active: false, default_weight: '50', xmin: '702' },
    ],
    employees: [{ id: id(6), organization_id: org, name: 'Fictional Avery', is_active: true, default_role_id: id(5), default_weight_override: null, xmin: '703' }],
  };
  requests = [];
  intercept = () => undefined;
  const sdk = createClient('https://fictional.example.test', 'sb_publishable_fictional_placeholder', {
    accessToken: async () => 'fictional-session', auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init = {}) => {
      const url = new URL(String(input)), table = url.pathname.split('/').at(-1) as Table;
      expect(['job_roles', 'employees', 'organization_memberships', 'organizations']).toContain(table);
      expect(['GET', 'POST', 'PATCH']).toContain(init.method ?? 'GET');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fictional-session');
      requests.push({ table, url, init });
      return await (intercept(table, url, init) ?? query(table, url, init));
    } },
  });
  emit = () => {};
  auth = {
    getSession: vi.fn(async () => ({ data: { session }, error: null })),
    getUser: vi.fn(async () => ({ data: { user: session.user }, error: null })),
    onAuthStateChange: vi.fn(callback => { emit = callback; return { data: { subscription: { unsubscribe: vi.fn() } } }; }),
  };
  client = { from: sdk.from.bind(sdk), auth } as unknown as SupabaseClient;
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear(); });
function manager() { return <ManageSharedRoster client={client} userId={userId} organizationId={org} onClose={() => {}} />; }
const mutations = () => requests.filter(request => ['POST', 'PATCH'].includes(request.init.method ?? 'GET'));
async function loaded() { return screen.findByRole('button', { name: 'Add shared job role' }); }
async function addRole(name = '  Fictional custom  ', weight = '90071992547409.91') {
  await userEvent.click(await loaded());
  await userEvent.type(screen.getByLabelText('Shared role name'), name);
  await userEvent.type(screen.getByLabelText('Default share weight'), weight);
  await userEvent.click(screen.getByRole('button', { name: 'Save shared roster' }));
}

it.each(['admin', 'closer'])('allows active %s exact-string inserts, rechecks access and reloads server state', async role => {
  tables.organization_memberships[0].role = role;
  render(manager());
  await addRole();
  expect(await screen.findByText('Save confirmed. Shared roster refreshed.')).toBeVisible();
  expect(screen.getByText('Fictional custom · Active')).toBeVisible();
  expect(screen.getByText('Default share weight: 90071992547409.91')).toBeVisible();
  expect(mutations()).toHaveLength(1);
  const request = mutations()[0];
  expect(JSON.parse(String(request.init.body))).toEqual({ organization_id: org, name: 'Fictional custom', default_weight: '90071992547409.91', is_active: true });
  expect(request.url.searchParams.get('select')).toBe('id,organization_id,name,is_active,default_weight::text,xmin::text');
  expect(new Headers(request.init.headers).get('Prefer')).toContain('count=exact');
  expect(new Headers(request.init.headers).get('Prefer')).toContain('return=representation');
  expect(auth.getUser.mock.calls.length).toBeGreaterThanOrEqual(6);
});

it('preserves inactive existing links and changes employee NULL to explicit zero and back with version filters', async () => {
  render(manager()); await loaded();
  expect(screen.getByText('Effective default share weight: 50 · Inherited from role')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Edit shared employee Fictional Avery' }));
  expect(screen.getByLabelText('Default shared job role')).toHaveValue(id(5));
  expect(screen.getByRole('option', { name: /Fictional retired role/ })).toBeEnabled();
  await userEvent.type(screen.getByLabelText('Default share weight override (blank inherits role)'), '0');
  await userEvent.click(screen.getByLabelText('Active shared employee'));
  await userEvent.click(screen.getByRole('button', { name: 'Save shared roster' }));
  await screen.findByText('Save confirmed. Shared roster refreshed.');
  expect(screen.getByText('Effective default share weight: 0.00 · Explicit zero override')).toBeVisible();
  expect(screen.getByText('Fictional Avery · Inactive')).toBeVisible();
  const patch = mutations()[0];
  expect(patch.url.searchParams.get('organization_id')).toBe(`eq.${org}`);
  expect(patch.url.searchParams.get('id')).toBe(`eq.${id(6)}`);
  expect(patch.url.searchParams.get('xmin')).toBe('eq.703');
  expect(JSON.parse(String(patch.init.body))).toEqual({ name: 'Fictional Avery', default_role_id: id(5), default_weight_override: '0.00', is_active: false });
  await userEvent.click(screen.getByRole('button', { name: 'Edit shared employee Fictional Avery' }));
  await userEvent.clear(screen.getByLabelText('Default share weight override (blank inherits role)'));
  await userEvent.click(screen.getByLabelText('Active shared employee'));
  await userEvent.click(screen.getByRole('button', { name: 'Save shared roster' }));
  await screen.findByText('Save confirmed. Shared roster refreshed.');
  expect(JSON.parse(String(mutations()[1].init.body)).default_weight_override).toBeNull();
  expect(mutations()[1].url.searchParams.get('xmin')).toBe('eq.704');
  expect(screen.getByText('Effective default share weight: 50 · Inherited from role')).toBeVisible();
});

it('disables new inactive-role assignments, allows duplicate employee names, and retains an explicit override when changing roles', async () => {
  tables.job_roles.push({ id: id(7), organization_id: org, name: 'Fictional second active', is_active: true, default_weight: '25', xmin: '704' });
  render(manager()); await loaded();
  await userEvent.click(screen.getByRole('button', { name: 'Add shared employee' }));
  expect(screen.getByRole('option', { name: /Fictional retired role/ })).toBeDisabled();
  await userEvent.type(screen.getByLabelText('Shared employee name'), 'Fictional Avery');
  await userEvent.selectOptions(screen.getByLabelText('Default shared job role'), id(4));
  await userEvent.type(screen.getByLabelText('Default share weight override (blank inherits role)'), '0.01');
  await userEvent.click(screen.getByRole('button', { name: 'Save shared roster' }));
  await screen.findByText('Save confirmed. Shared roster refreshed.');
  expect(screen.getAllByText('Fictional Avery · Active')).toHaveLength(2);
  expect(screen.getByText('Effective default share weight: 0.01 · Employee override')).toBeVisible();
  const form = screen.getAllByRole('button', { name: 'Edit shared employee Fictional Avery' })[1];
  await userEvent.click(form);
  expect(screen.getByLabelText('Default share weight override (blank inherits role)')).toHaveValue('0.01');
  await userEvent.selectOptions(screen.getByLabelText('Default shared job role'), id(7));
  await userEvent.click(screen.getByRole('button', { name: 'Save shared roster' }));
  await screen.findByText('Save confirmed. Shared roster refreshed.');
  expect(JSON.parse(String(mutations()[1].init.body))).toMatchObject({ default_role_id: id(7), default_weight_override: '0.01' });
});

it('requires an active role for new employees and allows role reactivation without changing links', async () => {
  tables.job_roles[0].is_active = false;
  render(manager()); await loaded();
  expect(screen.getByRole('button', { name: 'Add shared employee' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Edit shared role Fictional server' }));
  await userEvent.click(screen.getByLabelText('Active shared role'));
  await userEvent.click(screen.getByRole('button', { name: 'Save shared roster' }));
  await screen.findByText('Save confirmed. Shared roster refreshed.');
  expect(screen.getByRole('button', { name: 'Add shared employee' })).toBeEnabled();
  expect(tables.employees[0].default_role_id).toBe(id(5));
});

it('rechecks a new default role and blocks it if it became inactive', async () => {
  render(manager()); await loaded();
  await userEvent.click(screen.getByRole('button', { name: 'Add shared employee' }));
  await userEvent.type(screen.getByLabelText('Shared employee name'), 'Fictional new employee');
  await userEvent.selectOptions(screen.getByLabelText('Default shared job role'), id(4));
  tables.job_roles[0].is_active = false;
  await userEvent.click(screen.getByRole('button', { name: 'Save shared roster' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('selected role changed');
  expect(mutations()).toHaveLength(0);
});

it.each(['numeric', 'foreign', 'version', 'truncated', 'missing-role'])('fails closed for %s editing snapshots', async kind => {
  if (kind === 'numeric') tables.job_roles[0].default_weight = 100.5;
  if (kind === 'foreign') intercept = table => table === 'job_roles' ? response([{ ...tables.job_roles[0], organization_id: foreign }]) : undefined;
  if (kind === 'version') tables.job_roles[0].xmin = 701;
  if (kind === 'truncated') intercept = table => table === 'employees' ? response(tables.employees, 200, 1001) : undefined;
  if (kind === 'missing-role') tables.employees[0].default_role_id = id(99);
  render(manager());
  expect(await screen.findByRole('alert')).toHaveTextContent('Shared data could not be verified');
  expect(screen.queryByRole('button', { name: 'Add shared job role' })).not.toBeInTheDocument();
  expect(mutations()).toHaveLength(0);
});

it.each(['1e2', '1.001', '1.000', '90071992547409.92'])('rejects invalid share input %s before mutations', async weight => {
  render(manager()); await addRole('Fictional invalid', weight);
  expect(await screen.findByRole('alert')).toHaveTextContent('at most two decimal places');
  expect(mutations()).toHaveLength(0);
  expect(screen.getByLabelText('Default share weight')).toHaveValue(weight);
});

it.each([['role', 101], ['employee', 161]] as const)('enforces the %s name limit after trimming', async (kind, length) => {
  render(manager()); await loaded();
  await userEvent.click(screen.getByRole('button', { name: kind === 'role' ? 'Add shared job role' : 'Add shared employee' }));
  fireEvent.change(screen.getByLabelText(`Shared ${kind} name`), { target: { value: 'x'.repeat(length) } });
  if (kind === 'role') fireEvent.change(screen.getByLabelText('Default share weight'), { target: { value: '1' } });
  else await userEvent.selectOptions(screen.getByLabelText('Default shared job role'), id(4));
  await userEvent.click(screen.getByRole('button', { name: 'Save shared roster' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Name is required');
  expect(mutations()).toHaveLength(0);
});

it.each([
  ['23505', 'already exists'], ['23503', 'default role is unavailable'], ['23514', 'server rejected'], ['42501', 'access could not be verified'],
])('handles database %s safely without success or automatic retries', async (code, message) => {
  intercept = (_table, _url, init) => init.method === 'POST' ? new Response(JSON.stringify({ code, message: 'private SQL token detail' }), { status: code === '42501' ? 403 : 409 }) : undefined;
  render(manager()); await addRole();
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  expect(screen.queryByText('Save confirmed. Shared roster refreshed.')).not.toBeInTheDocument();
  expect(screen.queryByText(/private SQL/)).not.toBeInTheDocument();
  expect(mutations()).toHaveLength(1);
});

it('blocks stale edits on a zero-row compare and requires a fresh reload', async () => {
  render(manager()); await loaded();
  await userEvent.click(screen.getByRole('button', { name: 'Edit shared role Fictional server' }));
  tables.job_roles[0].xmin = '900'; tables.job_roles[0].name = 'Fictional other operator';
  await userEvent.click(screen.getByRole('button', { name: 'Save shared roster' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('row changed or access was revoked');
  expect(screen.queryByRole('button', { name: 'Save shared roster' })).not.toBeInTheDocument();
  expect(tables.job_roles[0].name).toBe('Fictional other operator');
  await userEvent.click(screen.getByRole('button', { name: 'Reload management / discard draft' }));
  expect(await screen.findByText('Fictional other operator · Active')).toBeVisible();
});

it.each(['network', 'multiple-rows', 'wrong-org', 'numeric-weight', 'missing-count'])('blocks uncertain %s insert results and discards the add draft', async kind => {
  intercept = (_table, _url, init) => {
    if (init.method !== 'POST') return;
    if (kind === 'network') throw new Error('private token');
    const result = { ...JSON.parse(String(init.body)), id: id(90), xmin: '900' };
    if (kind === 'multiple-rows') return response([result, { ...result, id: id(91) }]);
    if (kind === 'wrong-org') result.organization_id = foreign;
    if (kind === 'numeric-weight') result.default_weight = 0.01;
    if (kind === 'missing-count') return new Response(JSON.stringify([result]), { status: 201 });
    return response([result], 201);
  };
  render(manager()); await addRole();
  expect(await screen.findByRole('alert')).toHaveTextContent('Save could not be confirmed');
  expect(screen.queryByRole('form')).not.toBeInTheDocument();
  expect(mutations()).toHaveLength(1);
});

it.each(['no-session', 'wrong-user', 'unverified', 'nonmember', 'revoked', 'foreign', 'wrong-role'])('exposes no controls with %s context', async kind => {
  if (kind === 'no-session') auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  if (kind === 'wrong-user') auth.getSession.mockResolvedValue({ data: { session: { ...session, user: { id: id(99) } } }, error: null });
  if (kind === 'unverified') auth.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'private token' } });
  if (kind === 'nonmember') tables.organization_memberships = [];
  if (kind === 'revoked') tables.organization_memberships[0].is_active = false;
  if (kind === 'foreign') intercept = table => table === 'organization_memberships' ? response([{ ...tables.organization_memberships[0], organization_id: foreign }]) : undefined;
  if (kind === 'wrong-role') tables.organization_memberships[0].role = 'owner';
  render(manager());
  expect(await screen.findByRole('alert')).toHaveTextContent('access could not be verified');
  expect(screen.queryByRole('button', { name: 'Add shared job role' })).not.toBeInTheDocument();
  expect(mutations()).toHaveLength(0);
});

it('rechecks revoked membership immediately before saving', async () => {
  render(manager()); await loaded();
  await userEvent.click(screen.getByRole('button', { name: 'Add shared job role' }));
  await userEvent.type(screen.getByLabelText('Shared role name'), 'Fictional revoked');
  await userEvent.type(screen.getByLabelText('Default share weight'), '1');
  tables.organization_memberships = [];
  await userEvent.click(screen.getByRole('button', { name: 'Save shared roster' }));
  await screen.findByRole('alert');
  expect(mutations()).toHaveLength(0);
});

it('does not report a returned save as success after access is revoked', async () => {
  intercept = (table, url, init) => {
    if (init.method !== 'POST') return;
    const result = query(table, url, init); tables.organization_memberships = []; return result;
  };
  render(manager()); await addRole();
  expect(await screen.findByRole('alert')).toHaveTextContent('Save could not be confirmed');
  expect(screen.queryByText('Save confirmed. Shared roster refreshed.')).not.toBeInTheDocument();
});

it('handles offline loading and explicit retry with fresh access verification', async () => {
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  render(manager());
  expect(await screen.findByRole('alert')).toHaveTextContent('offline');
  expect(requests).toHaveLength(0);
  online.mockReturnValue(true);
  await userEvent.click(screen.getByRole('button', { name: 'Reload management / discard draft' }));
  expect(await loaded()).toBeVisible();
});

it.each(['unmount', 'auth-event', 'reload'])('ignores delayed saves after %s and never retries the insert', async kind => {
  const pending = deferred<Response>();
  intercept = (_table, _url, init) => init.method === 'POST' ? pending.promise : undefined;
  const view = render(manager()); await addRole();
  await waitFor(() => expect(mutations()).toHaveLength(1));
  const request = mutations()[0];
  expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  if (kind === 'unmount') view.unmount();
  if (kind === 'auth-event') { auth.getSession.mockResolvedValue({ data: { session: null }, error: null }); act(() => emit()); }
  if (kind === 'reload') fireEvent.click(screen.getByRole('button', { name: 'Reload management / discard draft' }));
  expect(request.init.signal?.aborted).toBe(true);
  await act(async () => pending.resolve(response([{ ...JSON.parse(String(request.init.body)), id: id(90), xmin: '900' }], 201)));
  expect(screen.queryByText('Save confirmed. Shared roster refreshed.')).not.toBeInTheDocument();
  expect(mutations()).toHaveLength(1);
});

it.each(['offline', 'tenant-switch'])('parent context aborts a pending mutation on %s without stale success or data disclosure', async kind => {
  tables.organizations.push({ id: foreign, name: 'Fictional restaurant B' });
  tables.organization_memberships.push({ organization_id: foreign, user_id: userId, role: 'closer', is_active: true });
  render(<SharedRoster client={client} userId={userId} />);
  await userEvent.selectOptions(await screen.findByLabelText('Restaurant'), org);
  await userEvent.click(await screen.findByRole('button', { name: 'Manage shared roster · DEV' }));
  const pending = deferred<Response>();
  intercept = (_table, _url, init) => init.method === 'POST' ? pending.promise : undefined;
  await addRole();
  expect(mutations()).toHaveLength(1);
  const request = mutations()[0];
  if (kind === 'offline') {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    fireEvent(window, new Event('offline'));
    await screen.findByRole('alert');
  } else {
    await userEvent.selectOptions(screen.getByLabelText('Restaurant'), foreign);
    await screen.findByText('No shared employees.');
  }
  expect(request.init.signal?.aborted).toBe(true);
  await act(async () => pending.resolve(response([{ ...JSON.parse(String(request.init.body)), id: id(90), xmin: '900' }], 201)));
  expect(screen.queryByText('Save confirmed. Shared roster refreshed.')).not.toBeInTheDocument();
  expect(screen.queryByText('Fictional custom · Active')).not.toBeInTheDocument();
  expect(mutations()).toHaveLength(1);
});

it('expires drafts and refreshes versions after a minute', async () => {
  vi.useFakeTimers();
  render(manager());
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  fireEvent.click(screen.getByRole('button', { name: 'Add shared job role' }));
  fireEvent.change(screen.getByLabelText('Shared role name'), { target: { value: 'Fictional unsent' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(screen.queryByRole('form')).not.toBeInTheDocument();
  expect(mutations()).toHaveLength(0);
});

it('rejects an expired snapshot after OS sleep even before a browser timer fires', async () => {
  render(manager()); await loaded();
  await userEvent.click(screen.getByRole('button', { name: 'Add shared job role' }));
  await userEvent.type(screen.getByLabelText('Shared role name'), 'Fictional sleeping draft');
  await userEvent.type(screen.getByLabelText('Default share weight'), '1');
  const resumedAt = Date.now() + 60_001;
  vi.spyOn(Date, 'now').mockReturnValue(resumedAt);
  fireEvent.click(screen.getByRole('button', { name: 'Save shared roster' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('editing snapshot expired');
  expect(mutations()).toHaveLength(0);
});

it('keeps local/account calculator storage and payouts isolated from shared writes', async () => {
  const own = JSON.stringify([{ id: 'local', name: 'Fictional local', jobTitle: 'Local', weight: 100 }]);
  localStorage.setItem('fictional-account', own); localStorage.setItem('employees', 'unrelated legacy');
  const write = vi.spyOn(Storage.prototype, 'setItem');
  render(<>{manager()}<Calculator storageKey="fictional-account" /></>);
  await userEvent.type(screen.getByLabelText('Cash Tips ($)'), '100');
  await addRole(); await screen.findByText('Save confirmed. Shared roster refreshed.');
  expect(within(screen.getByRole('group', { name: 'Employee Fictional local' })).getByText('$100.00')).toBeVisible();
  expect(localStorage.getItem('fictional-account')).toBe(own);
  expect(localStorage.getItem('employees')).toBe('unrelated legacy');
  expect(write).not.toHaveBeenCalled();
});
