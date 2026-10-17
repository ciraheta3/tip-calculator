import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadEditingRoster, RosterEditError, saveRosterDraft } from './sharedRosterEditingData';
import type { EditEmployee, EditRole, EditSnapshot, RosterDraft } from './sharedRosterEditingData';
import { sharedWeightInput } from './sharedRosterWeights';

const button = 'rounded border border-blue-700 text-blue-800 px-3 py-2 disabled:opacity-50';
type Editor = { kind: 'role'; row?: EditRole } | { kind: 'employee'; row?: EditEmployee };
type State = { loading: boolean; snapshot?: EditSnapshot; error?: string; saving?: boolean; message?: string };

export default function ManageSharedRoster({ client, userId, organizationId, onClose }: {
  client: SupabaseClient; userId: string; organizationId: string; onClose: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<State>({ loading: true });
  const [editor, setEditor] = useState<Editor>();
  const controller = useRef<AbortController | undefined>(undefined);
  const pending = useRef(false);
  const reset = useCallback(() => {
    controller.current?.abort();
    pending.current = false;
    setEditor(undefined);
    setState({ loading: true });
    setRevision(value => value + 1);
  }, []);
  useEffect(() => {
    // Cancel immediately inside the event, including token refresh. New table
    // operations wait for their own server identity verification after the event.
    const { data: { subscription } } = client.auth.onAuthStateChange(reset);
    return () => subscription.unsubscribe();
  }, [client, reset]);
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    const expiry = setTimeout(reset, 60_000);
    void loadEditingRoster(client, userId, organizationId, active.signal).then(snapshot => {
      if (!active.signal.aborted) setState({ loading: false, snapshot });
    }).catch(error => {
      if (!active.signal.aborted) setState({ loading: false, error: error instanceof RosterEditError ? error.message : 'Unable to verify shared roster access. Refresh access to retry.' });
    });
    return () => { active.abort(); clearTimeout(expiry); };
  }, [client, userId, organizationId, revision, reset]);

  const save = async (draft: RosterDraft, id?: string) => {
    const active = controller.current;
    const snapshot = state.snapshot;
    if (pending.current || !active || active.signal.aborted || !snapshot) return;
    pending.current = true;
    setState(previous => ({ ...previous, saving: true, error: undefined, message: undefined }));
    try {
      await saveRosterDraft(client, userId, organizationId, active.signal, snapshot, draft, id);
      const fresh = await loadEditingRoster(client, userId, organizationId, active.signal);
      if (!active.signal.aborted) {
        setEditor(undefined);
        setState({ loading: false, snapshot: fresh, message: 'Save confirmed. Shared roster refreshed.' });
      }
    } catch (error) {
      if (!active.signal.aborted) {
        const retry = error instanceof RosterEditError && !error.reload;
        if (!retry) setEditor(undefined);
        setState({ loading: false, snapshot: retry ? snapshot : undefined,
          error: error instanceof RosterEditError ? error.message : 'Save could not be confirmed. Refresh the roster and inspect it before another save.' });
      }
    } finally { if (controller.current === active) pending.current = false; }
  };
  const snapshot = state.snapshot;
  return <section aria-label="Manage shared roster · DEV" className="space-y-4">
    <h3 className="text-lg font-bold">Manage shared roster · DEV</h3>
    <p>Permanent default share weights, not fixed percentages or today’s shift participation. Shared records never enter the browser-local calculator.</p>
    <p className="text-sm">Editing snapshots expire after one minute. Refresh, focus, offline, access or account changes discard drafts. An uncertain addition must be inspected before adding it again.</p>
    <div className="flex flex-wrap gap-2">
      <button className={button} onClick={reset}>Reload management / discard draft</button>
      <button className={button} onClick={onClose}>Close management</button>
    </div>
    {state.loading && <p role="status">Verifying access and exact shared defaults…</p>}
    {state.saving && <p role="status">Saving shared roster…</p>}
    {state.message && <p role="status">{state.message}</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {snapshot && <>
      <div className="grid sm:grid-cols-2 gap-6">
        <div className="space-y-3"><h4 className="font-semibold">Manage job roles</h4>
          <button className={button} disabled={state.saving} onClick={() => setEditor({ kind: 'role' })}>Add shared job role</button>
          {!snapshot.roles.length && <p>No shared job roles.</p>}
          <ul className="space-y-3">{snapshot.roles.map(row => <li key={row.id} className="break-words border rounded p-3">
            <p>{row.name} · {row.is_active ? 'Active' : 'Inactive'}</p><p>Default share weight: {row.default_weight}</p>
            <button className={button} disabled={state.saving} aria-label={`Edit shared role ${row.name}`} onClick={() => setEditor({ kind: 'role', row })}>Edit / activate / deactivate</button>
          </li>)}</ul>
        </div>
        <div className="space-y-3"><h4 className="font-semibold">Manage employees</h4>
          <button className={button} disabled={state.saving || !snapshot.roles.some(row => row.is_active)} onClick={() => setEditor({ kind: 'employee' })}>Add shared employee</button>
          {!snapshot.roles.some(row => row.is_active) && <p>Add or activate a role before adding an employee.</p>}
          {!snapshot.employees.length && <p>No shared employees.</p>}
          <ul className="space-y-3">{snapshot.employees.map(row => {
            const role = snapshot.roles.find(role => role.id === row.default_role_id)!;
            const source = row.default_weight_override === null ? 'Inherited from role'
              : sharedWeightInput(row.default_weight_override) === '0.00' ? 'Explicit zero override' : 'Employee override';
            return <li key={row.id} className="break-words border rounded p-3">
              <p>{row.name} · {row.is_active ? 'Active' : 'Inactive'}</p>
              <p>Default role: {role.name} · {role.is_active ? 'Active' : 'Inactive'}</p>
              <p>Effective default share weight: {row.default_weight_override ?? role.default_weight} · {source}</p>
              <button className={button} disabled={state.saving} aria-label={`Edit shared employee ${row.name}`} onClick={() => setEditor({ kind: 'employee', row })}>Edit / activate / deactivate</button>
            </li>;
          })}</ul>
        </div>
      </div>
      {editor && <RosterForm key={`${editor.kind}:${editor.row?.id ?? 'new'}`} editor={editor} snapshot={snapshot} busy={!!state.saving}
        onSave={(draft, id) => void save(draft, id)} onCancel={() => setEditor(undefined)} />}
    </>}
  </section>;
}

function RosterForm({ editor, snapshot, busy, onSave, onCancel }: {
  editor: Editor; snapshot: EditSnapshot; busy: boolean; onSave: (draft: RosterDraft, id?: string) => void; onCancel: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(editor.row?.name ?? '');
  const [active, setActive] = useState(editor.row?.is_active ?? true);
  const [weight, setWeight] = useState(editor.kind === 'role' ? editor.row?.default_weight ?? '' : editor.row?.default_weight_override ?? '');
  const [roleId, setRoleId] = useState(editor.kind === 'employee' ? editor.row?.default_role_id ?? '' : '');
  const existingRole = editor.kind === 'employee' ? editor.row?.default_role_id : undefined;
  return <form aria-label={`${editor.row ? 'Edit' : 'Add'} shared ${editor.kind === 'role' ? 'job role' : 'employee'}`} className="border rounded p-4 space-y-4" onSubmit={event => {
    event.preventDefault();
    onSave(editor.kind === 'role' ? { kind: 'role', name, weight, active } : { kind: 'employee', name, weight, active, roleId }, editor.row?.id);
  }}>
    <h4 className="font-semibold">{editor.row ? 'Edit' : 'Add'} shared {editor.kind === 'role' ? 'job role' : 'employee'}</h4>
    <fieldset disabled={busy} className="space-y-3">
      <div><label htmlFor={`${id}-name`} className="block">Shared {editor.kind} name</label>
        <input id={`${id}-name`} className="border rounded p-2 w-full" required value={name} onChange={event => setName(event.target.value)} />
        <p className="text-sm">Up to {editor.kind === 'role' ? 100 : 160} characters.</p>
      </div>
      {editor.kind === 'employee' && <div><label htmlFor={`${id}-role`} className="block">Default shared job role</label>
        <select id={`${id}-role`} className="border rounded p-2 w-full" required value={roleId} onChange={event => setRoleId(event.target.value)}>
          <option value="" disabled>Choose an active role</option>
          {snapshot.roles.map(row => <option key={row.id} value={row.id} disabled={!row.is_active && row.id !== existingRole}>{row.name}{row.is_active ? '' : ' (Inactive; existing link only)'}</option>)}
        </select>
        <p className="text-sm">Inactive roles keep existing links. New assignments require an active role. Changing a role retains the override you submit.</p>
      </div>}
      <div><label htmlFor={`${id}-weight`} className="block">{editor.kind === 'role' ? 'Default share weight' : 'Default share weight override (blank inherits role)'}</label>
        <input id={`${id}-weight`} className="border rounded p-2 w-full" type="text" inputMode="decimal" required={editor.kind === 'role'} value={weight} onChange={event => setWeight(event.target.value)} />
        <p className="text-sm">Nonnegative shares, at most two decimal places. Zero is explicit zero; an empty employee override inherits the role default.</p>
      </div>
      <label className="flex items-center gap-2"><input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)} />Active shared {editor.kind}</label>
      <div className="flex gap-2"><button className={button} type="submit">{busy ? 'Saving…' : 'Save shared roster'}</button><button className={button} type="button" onClick={onCancel}>Cancel draft</button></div>
    </fieldset>
  </form>;
}
