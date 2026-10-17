import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { accessChanged, readOrganizations, readSharedRoster, SharedRosterError } from './sharedRosterData';
import type { Organization, SharedRosterData } from './sharedRosterData';
import ManageSharedRoster from './ManageSharedRoster';

const buttonClass = 'rounded border border-blue-700 text-blue-800 px-4 py-2 disabled:opacity-50';
type Props = { client: SupabaseClient; userId: string };
type State = {
  organizations: Organization[];
  selected: string;
  loading: boolean;
  error?: string;
  roster?: SharedRosterData;
};

// Mounted only below the verified Auth gate and keyed there by project/account.
export default function SharedRoster({ client, userId }: Props) {
  const [selection, setSelection] = useState('');
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision(value => value + 1);
  useEffect(() => {
    const refreshAccess = () => setRevision(value => value + 1);
    const visible = () => { if (document.visibilityState === 'visible') refreshAccess(); };
    const timer = setInterval(refreshAccess, 60_000);
    window.addEventListener('focus', refreshAccess);
    window.addEventListener('online', refreshAccess);
    window.addEventListener('offline', refreshAccess);
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refreshAccess);
      window.removeEventListener('online', refreshAccess);
      window.removeEventListener('offline', refreshAccess);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  return <section aria-labelledby="shared-roster-title" className="max-w-6xl mx-auto my-6 p-4 sm:p-6 bg-white border rounded-xl space-y-4">
    <h2 id="shared-roster-title" className="text-xl font-bold">Shared roster · DEV</h2>
    <p className="text-sm text-gray-700">Shared restaurant records are separate from your browser-local calculator roster. Neither roster is synchronized; shared rows never affect payouts.</p>
    <p className="text-sm text-gray-600">Open management to inspect exact default share weights. The summary shows names and status.</p>
    <button className={buttonClass} onClick={refresh}>Refresh access / retry</button>
    <RosterRequest key={`${selection}:${revision}`} client={client} userId={userId} selection={selection} onSelect={setSelection} />
  </section>;
}

function RosterRequest({ client, userId, selection, onSelect }: Props & { selection: string; onSelect: (id: string) => void }) {
  const [state, setState] = useState<State>({ organizations: [], selected: '', loading: true });
  const [manage, setManage] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    void (async () => {
      try {
        if (!navigator.onLine) throw new SharedRosterError('You are offline. Reconnect and retry shared roster access.');
        const organizations = await readOrganizations(client, userId, controller.signal);
        if (!current) return;
        const selected = selection || (organizations.length === 1 ? organizations[0].id : '');
        if (selection && !organizations.some(org => org.id === selection)) {
          setState({ organizations, selected: '', loading: false, error: accessChanged });
          return;
        }
        if (!selected) {
          setState({ organizations, selected, loading: false });
          return;
        }
        setState({ organizations, selected, loading: true });
        const roster = await readSharedRoster(client, userId, selected, controller.signal);
        if (current) setState({ organizations, selected, loading: false, roster });
      } catch (error) {
        if (current) setState(previous => ({ ...previous, loading: false, roster: undefined,
          error: error instanceof SharedRosterError
            ? error.message : 'Unable to load shared data. Check your connection and retry.' }));
      }
    })();
    return () => { current = false; controller.abort(); };
  }, [client, userId, selection, reload]);

  const roleById = new Map(state.roster?.roles.map(role => [role.id, role]));
  return <div className="space-y-4">
    {state.organizations.length > 1 || (state.error && state.organizations.length > 0) ? <div>
      <label htmlFor="shared-organization" className="block font-semibold">Restaurant</label>
      <select id="shared-organization" className="w-full sm:w-auto max-w-full border rounded p-2" value={state.selected} onChange={event => onSelect(event.target.value)}>
        {!state.selected && <option value="" disabled>Select a restaurant</option>}
        {state.organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}
      </select>
    </div> : state.selected && <p className="font-semibold break-words">Restaurant: {state.organizations.find(org => org.id === state.selected)?.name}</p>}
    {state.loading && <p role="status">Checking restaurant access and loading shared roster…</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {!state.loading && !state.error && state.organizations.length > 1 && !state.selected && <p>Select a restaurant to view its shared roster.</p>}
    {!state.loading && !state.error && !state.organizations.length && <div>
      <h3 className="font-semibold">No restaurant access assigned</h3>
      <p>Contact the project owner for access. You can continue using the browser-local calculator.</p>
    </div>}
    {state.roster && manage ? <ManageSharedRoster client={client} userId={userId} organizationId={state.selected} onClose={() => {
      setManage(false);
      setState({ organizations: [], selected: '', loading: true });
      setReload(value => value + 1);
    }} /> : state.roster && <>
      <p className="text-sm text-gray-600">Snapshot only. Access is rechecked on refresh, focus, reconnect and every minute; this is not a live subscription.</p>
      <button className={buttonClass} onClick={() => setManage(true)}>Manage shared roster · DEV</button>
      <div className="grid sm:grid-cols-2 gap-6">
        <div><h3 className="font-semibold">Shared job roles</h3>
          {!state.roster.roles.length ? <p>No shared job roles.</p> : <ul className="space-y-2 mt-2">
            {state.roster.roles.map(role => <li key={role.id} className="break-words">{role.name} · {role.is_active ? 'Active' : 'Inactive'}</li>)}
          </ul>}
        </div>
        <div><h3 className="font-semibold">Shared employees</h3>
          {!state.roster.employees.length ? <p>No shared employees.</p> : <ul className="space-y-2 mt-2">
            {state.roster.employees.map(employee => <li key={employee.id} className="break-words">
              {employee.name} · {employee.is_active ? 'Active' : 'Inactive'}
              <span className="block text-sm">Default role: {roleById.get(employee.default_role_id)!.name} · {roleById.get(employee.default_role_id)!.is_active ? 'Active' : 'Inactive'}</span>
            </li>)}
          </ul>}
        </div>
      </div>
    </>}
  </div>;
}
