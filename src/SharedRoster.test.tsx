// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { AuthChangeEvent, Session, SupabaseClient, User } from '@supabase/supabase-js';
import SharedRoster from './SharedRoster';
import AuthGate from './AuthGate';
import { accountRosterKey } from './supabase';
import { readOrganizations } from './sharedRosterData';

const userA = { id: 'fictional-user-a', email: 'preview-a@example.test' } as User;
const userB = { id: 'fictional-user-b', email: 'preview-b@example.test' } as User;
const project = 'https://fictional.example.test';
const orgA = { id: 'fictional-org-a', name: 'Fictional Juniper' };
const orgB = { id: 'fictional-org-b', name: 'Fictional Moonbeam' };
const membership = (org = orgA, user = userA) => ({ organization_id: org.id, user_id: user.id, is_active: true });
const role = (org = orgA) => ({ id: `role-${org.id}`, organization_id: org.id, name: `Server ${org.name}`, is_active: false });
const employee = (org = orgA) => ({ id: `employee-${org.id}`, organization_id: org.id, name: `Avery ${org.name}`, default_role_id: role(org).id, is_active: true });
type Table = 'organization_memberships' | 'organizations' | 'job_roles' | 'employees';
let tables: Record<Table, Record<string, unknown>[]>;
let intercept: (table: Table, url: URL, init: RequestInit) => Response | Promise<Response> | undefined;
let requests: { table: Table; url: URL; init: RequestInit }[];
let client: SupabaseClient;
let emit: (event: AuthChangeEvent, session: Session | null) => void;
let auth: { getSession: ReturnType<typeof vi.fn>; getUser: ReturnType<typeof vi.fn>; signOut: ReturnType<typeof vi.fn>; onAuthStateChange: ReturnType<typeof vi.fn> };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function response(rows: unknown[], count = rows.length) {
  return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': `0-${Math.max(rows.length - 1, 0)}/${count}` } });
}
function queryResponse(table: Table, url: URL) {
  const filtered = tables[table].filter(row => [...url.searchParams].every(([key, value]) => {
    if (value.startsWith('eq.')) return String(row[key]) === value.slice(3);
    if (value.startsWith('in.(')) return value.slice(4, -1).split(',').includes(String(row[key]));
    return true;
  }));
  const columns = url.searchParams.get('select')!.split(',');
  return response(filtered.slice(0, 1000).map(row => Object.fromEntries(columns.map(column => [column, row[column]]))), filtered.length);
}
function session(user = userA, expires = 3600): Session {
  return { user, access_token: `fictional-${user.id}`, refresh_token: 'fictional-refresh', expires_in: expires,
    expires_at: Date.now() / 1000 + expires, token_type: 'bearer' };
}
function gate() {
  return <AuthGate runtime={{ mode: 'configured', project, client }} />;
}
const region = () => screen.getByRole('region', { name: 'Shared roster · DEV' });
const refresh = () => fireEvent.click(screen.getByRole('button', { name: 'Refresh access / retry' }));
async function loaded(org = orgA) { return screen.findByText(`${employee(org).name} · Active`); }

beforeEach(() => {
  tables = { organization_memberships: [membership()], organizations: [orgA], job_roles: [role()], employees: [employee()] };
  requests = [];
  intercept = () => undefined;
  const transport = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const table = url.pathname.split('/').at(-1) as Table;
    requests.push({ table, url, init });
    expect(init.method ?? 'GET').toBe('GET');
    expect(Object.keys(tables)).toContain(table);
    expect(url.pathname).toBe(`/rest/v1/${table}`);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fictional-session');
    expect(new Headers(init.headers).get('Prefer')).toBe('count=exact');
    expect(url.searchParams.get('offset')).toBe('0');
    expect(url.searchParams.get('limit')).toBe('1000');
    expect(url.searchParams.get('select')).not.toMatch(/\*|weight/);
    return await (intercept(table, url, init) ?? queryResponse(table, url));
  });
  const sdk = createClient(project, 'sb_publishable_fictional_placeholder', {
    accessToken: async () => 'fictional-session',
    global: { fetch: transport },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  emit = () => {};
  auth = {
    getSession: vi.fn(async () => ({ data: { session: session() }, error: null })),
    getUser: vi.fn(async (token: string) => ({ data: { user: token.includes(userB.id) ? userB : userA }, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
    onAuthStateChange: vi.fn(callback => {
      emit = callback;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    }),
  };
  client = { auth, from: sdk.from.bind(sdk) } as unknown as SupabaseClient;
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear(); });

it('makes no application requests while signed out or until identity verification completes', async () => {
  auth.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
  const view = render(gate());
  await screen.findByRole('button', { name: 'Sign in' });
  expect(requests).toHaveLength(0);
  view.unmount();
  const identity = deferred<{ data: { user: User }; error: null }>();
  auth.getUser.mockReturnValueOnce(identity.promise);
  render(gate());
  await waitFor(() => expect(auth.getUser).toHaveBeenCalled());
  expect(requests).toHaveLength(0);
  await act(async () => identity.resolve({ data: { user: userA }, error: null }));
  expect(await loaded()).toBeVisible();
});

it('rejects unverified identity without querying tables', async () => {
  auth.getUser.mockResolvedValueOnce({ data: { user: userB }, error: null });
  render(gate());
  await screen.findByRole('button', { name: 'Sign in' });
  expect(requests).toHaveLength(0);
});

it('reads a single active membership with exact projections, filters and same-tenant defaults; preserves local storage and payouts', async () => {
  const legacy = JSON.stringify([{ id: 'legacy', name: 'Legacy Fiction', jobTitle: 'Local', weight: 100 }]);
  const own = JSON.stringify([{ id: 'local', name: 'Local Fiction', jobTitle: 'Local', weight: 100 }]);
  localStorage.setItem('employees', legacy);
  localStorage.setItem(accountRosterKey(project, userA.id), own);
  const write = vi.spyOn(Storage.prototype, 'setItem');
  render(gate());
  expect(await loaded()).toBeVisible();
  expect(within(region()).getByText(`Server ${orgA.name} · Inactive`)).toBeVisible();
  expect(within(region()).getByText(`Default role: Server ${orgA.name} · Inactive`)).toBeVisible();
  expect(screen.getByRole('group', { name: 'Employee Local Fiction' })).toBeVisible();
  expect(screen.queryByText('Legacy Fiction')).not.toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('Cash Tips ($)'), '100');
  expect(screen.getByRole('group', { name: 'Employee Local Fiction' })).toHaveTextContent('$100.00');
  expect(write).not.toHaveBeenCalled();
  expect(localStorage.getItem('employees')).toBe(legacy);
  expect(localStorage.getItem(accountRosterKey(project, userA.id))).toBe(own);
  expect(within(region()).getAllByRole('button')).toHaveLength(2);
  const projections = { organization_memberships: 'organization_id,user_id,is_active', organizations: 'id,name', job_roles: 'id,organization_id,name,is_active', employees: 'id,organization_id,name,default_role_id,is_active' };
  for (const { table, url } of requests) {
    expect(url.searchParams.get('select')).toBe(projections[table]);
    if (table === 'organization_memberships') {
      expect(url.searchParams.get('user_id')).toBe(`eq.${userA.id}`);
      expect(url.searchParams.get('is_active')).toBe('eq.true');
    } else if (table === 'organizations') expect(url.searchParams.get('id')).toBe(`in.(${orgA.id})`);
    else expect(url.searchParams.get('organization_id')).toBe(`eq.${orgA.id}`);
  }
});

it('shows no access for nonmembers and revoked memberships without roster queries or privileged controls', async () => {
  tables.organization_memberships = [{ ...membership(), is_active: false }];
  render(gate());
  expect(await screen.findByText('No restaurant access assigned')).toBeVisible();
  expect(requests.every(request => request.table === 'organization_memberships')).toBe(true);
  expect(screen.getByRole('heading', { name: 'Tip Calculator Dashboard' })).toBeVisible();
  expect(screen.queryByText(/invite|create restaurant|add member/i)).not.toBeInTheDocument();
});

it('requires explicit selection for multiple memberships and clears A while B loads, ignoring delayed A responses', async () => {
  tables = { organization_memberships: [membership(), membership(orgB)], organizations: [orgA, orgB], job_roles: [role(), role(orgB)], employees: [employee(), employee(orgB)] };
  render(gate());
  const selector = await screen.findByLabelText('Restaurant');
  expect(requests.some(request => request.table === 'employees')).toBe(false);
  await userEvent.selectOptions(selector, orgA.id);
  await loaded();
  const lateA = deferred<Response>();
  intercept = (table, url) => table === 'employees' && url.searchParams.get('organization_id') === `eq.${orgA.id}` ? lateA.promise : undefined;
  refresh();
  await screen.findByLabelText('Restaurant');
  expect(screen.queryByText(`${employee().name} · Active`)).not.toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText('Restaurant'), orgB.id);
  expect(screen.queryByText(`${employee().name} · Active`)).not.toBeInTheDocument();
  await loaded(orgB);
  await act(async () => lateA.resolve(response([employee()])));
  expect(screen.queryByText(`${employee().name} · Active`)).not.toBeInTheDocument();
  expect(await loaded(orgB)).toBeVisible();
});

it('shows an authorized empty roster only after membership is rechecked', async () => {
  tables.job_roles = []; tables.employees = [];
  render(gate());
  expect(await screen.findByText('No shared employees.')).toBeVisible();
  expect(screen.getByText('No shared job roles.')).toBeVisible();
  expect(requests.filter(request => request.table === 'organization_memberships')).toHaveLength(2);
});

it('displays inactive employees and active default roles without treating either as calculator participants', async () => {
  tables.job_roles = [{ ...role(), is_active: true }];
  tables.employees = [{ ...employee(), is_active: false }];
  render(gate());
  expect(await screen.findByText(`${employee().name} · Inactive`)).toBeVisible();
  expect(screen.getByText(`Default role: ${role().name} · Active`)).toBeVisible();
  expect(screen.getByText('No employees added. Roster is empty.')).toBeVisible();
});

it('allows a remaining tenant to be selected after the explicitly selected membership is revoked', async () => {
  tables = { organization_memberships: [membership(), membership(orgB)], organizations: [orgA, orgB], job_roles: [role(), role(orgB)], employees: [employee(), employee(orgB)] };
  render(gate());
  await userEvent.selectOptions(await screen.findByLabelText('Restaurant'), orgA.id);
  await loaded();
  tables.organization_memberships = [membership(orgB)];
  refresh();
  expect(await screen.findByRole('alert')).toHaveTextContent('Restaurant access changed');
  expect(screen.queryByText(`${employee().name} · Active`)).not.toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText('Restaurant'), orgB.id);
  expect(await loaded(orgB)).toBeVisible();
});

it.each(['denied', 'network', 'server'])('clears a successful snapshot on %s failure and supports retry without leaking details', async kind => {
  render(gate()); await loaded();
  intercept = () => {
    if (kind === 'network') throw new Error('private transport detail');
    return new Response(JSON.stringify({ code: kind === 'denied' ? '42501' : 'XX000', message: 'private server detail' }), { status: kind === 'denied' ? 403 : 500 });
  };
  refresh();
  expect(screen.queryByText(`${employee().name} · Active`)).not.toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent(kind === 'denied' ? /access denied/ : /Check your connection/);
  expect(screen.queryByText(/private .* detail/)).not.toBeInTheDocument();
  expect(screen.queryByText('No shared employees.')).not.toBeInTheDocument();
  intercept = () => undefined;
  refresh(); expect(await loaded()).toBeVisible();
});

it('clears the roster immediately when offline and refreshes on reconnect', async () => {
  render(gate()); await loaded();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  fireEvent(window, new Event('offline'));
  expect(screen.queryByText(`${employee().name} · Active`)).not.toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent('You are offline');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  fireEvent(window, new Event('online'));
  expect(await loaded()).toBeVisible();
});

it('detects revocation on focus and never reports RLS-hidden reads as an empty roster', async () => {
  render(gate()); await loaded();
  tables.organization_memberships = [];
  fireEvent(window, new Event('focus'));
  expect(screen.queryByText(`${employee().name} · Active`)).not.toBeInTheDocument();
  expect(await screen.findByText('No restaurant access assigned')).toBeVisible();
  expect(screen.queryByText('No shared employees.')).not.toBeInTheDocument();
});

it('detects revocation between context and roster reads', async () => {
  intercept = (table, url) => {
    if (table === 'employees') {
      tables.organization_memberships = [];
      return response([]);
    }
    return queryResponse(table, url);
  };
  render(gate());
  expect(await screen.findByRole('alert')).toHaveTextContent('Restaurant access changed');
  expect(screen.queryByText('No shared employees.')).not.toBeInTheDocument();
});

it.each(['foreign-role', 'foreign-employee', 'foreign-default', 'duplicate', 'malformed'])('fails closed for %s rows, with no employee disclosure', async kind => {
  intercept = table => {
    if (table === 'job_roles' && kind === 'foreign-role') return response([role(orgB)]);
    if (table === 'employees') {
      if (kind === 'foreign-employee') return response([employee(orgB)]);
      if (kind === 'foreign-default') return response([{ ...employee(), default_role_id: role(orgB).id }]);
      if (kind === 'duplicate') return response([employee(), employee()]);
      if (kind === 'malformed') return response([{ ...employee(), is_active: 'true' }]);
    }
  };
  render(gate());
  expect(await screen.findByRole('alert')).toHaveTextContent('Shared data could not be verified');
  expect(screen.queryByText(`${employee().name} · Active`)).not.toBeInTheDocument();
  expect(screen.queryByText(`${employee(orgB).name} · Active`)).not.toBeInTheDocument();
});

it.each(['wrong-user', 'inactive', 'duplicate', 'wrong-organization'])('rejects unexpected %s context even if a mock ignores filters', async kind => {
  intercept = table => {
    if (table === 'organization_memberships') {
      if (kind === 'wrong-user') return response([membership(orgA, userB)]);
      if (kind === 'inactive') return response([{ ...membership(), is_active: false }]);
      if (kind === 'duplicate') return response([membership(), membership()]);
    }
    if (table === 'organizations' && kind === 'wrong-organization') return response([orgB]);
  };
  render(gate());
  await screen.findByRole('alert');
  expect(requests.some(request => request.table === 'employees')).toBe(false);
});

it.each(['truncated', 'missing-count'])('rejects %s responses instead of implying a complete roster', async kind => {
  intercept = table => table === 'employees' ? kind === 'truncated'
    ? response([employee()], 1001)
    : new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }) : undefined;
  render(gate());
  expect(await screen.findByRole('alert')).toHaveTextContent('complete shared roster could not be loaded');
  expect(screen.queryByText('No shared employees.')).not.toBeInTheDocument();
});

it('clears account A synchronously on account switch and ignores its delayed response', async () => {
  const lateA = deferred<Response>();
  intercept = table => table === 'employees' ? lateA.promise : undefined;
  render(gate());
  await waitFor(() => expect(requests.some(request => request.table === 'employees')).toBe(true));
  await act(async () => emit('SIGNED_IN', session(userB)));
  expect(screen.queryByRole('region', { name: 'Shared roster · DEV' })).not.toBeInTheDocument();
  await screen.findByText('No restaurant access assigned');
  await act(async () => lateA.resolve(response([employee()])));
  expect(screen.queryByText(`${employee().name} · Active`)).not.toBeInTheDocument();
  expect(requests.filter(request => request.table === 'organization_memberships').at(-1)!.url.searchParams.get('user_id')).toBe(`eq.${userB.id}`);
});

it.each(['sign-out', 'cross-tab-sign-out'])('unmounts shared data on %s and ignores delayed responses', async kind => {
  render(gate()); await loaded();
  const pending = deferred<Response>();
  intercept = () => pending.promise;
  refresh();
  await waitFor(() => expect(requests.at(-1)!.init.signal?.aborted).toBe(false));
  if (kind === 'sign-out') fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  else await act(async () => emit('SIGNED_OUT', null));
  expect(screen.queryByRole('region', { name: 'Shared roster · DEV' })).not.toBeInTheDocument();
  await act(async () => pending.resolve(response([membership()])));
  expect(screen.queryByText(`${employee().name} · Active`)).not.toBeInTheDocument();
  await screen.findByRole('button', { name: 'Sign in' });
});

it('unmounts shared content at verified session expiry', async () => {
  vi.useFakeTimers();
  auth.getSession.mockResolvedValueOnce({ data: { session: session(userA, 2) }, error: null });
  render(gate());
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByText(`${employee().name} · Active`)).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.queryByRole('region', { name: 'Shared roster · DEV' })).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('session expired');
});

it('rechecks access every minute and cleans up timers, requests and listeners in StrictMode', async () => {
  vi.useFakeTimers();
  const view = render(<StrictMode><SharedRoster client={client} userId={userA.id} /></StrictMode>);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByText(`${employee().name} · Active`)).toBeVisible();
  tables.organization_memberships = [];
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(screen.getByText('No restaurant access assigned')).toBeVisible();
  const count = requests.length;
  view.unmount();
  fireEvent(window, new Event('focus'));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(requests).toHaveLength(count);
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds membership reads and rejects a truncated membership set', async () => {
  intercept = () => response([membership()], 1001);
  await expect(readOrganizations(client, userA.id, new AbortController().signal)).rejects.toThrow('complete shared roster');
  expect(requests).toHaveLength(1);
});
