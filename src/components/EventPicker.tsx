import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAuthStore } from '../stores/authStore';

const API_BASE = 'https://event.gomonetwork.com';

export interface RemoteEvent {
  id: string;
  name: string;
  status: string;
  type: string;
  startDate: string;
  endDate: string;
  location: string;
}

export interface RemoteVendor {
  id: string;
  name: string;
  isCurrent?: boolean;
}

interface Props {
  onPick: (event: RemoteEvent) => void;
  /** Pre-fills the "Create New Event" form from data the controller already
   *  has for the current tournament, so the operator only has to fill in
   *  whatever's genuinely missing (there's no "location" concept locally,
   *  so that's always left blank/required). */
  defaultName?: string;
  defaultDateRange?: { start: string; end: string };
}

function fmtDate(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Lists this account's events from event.gomonetwork.com (the linked
// eventmanagementsystem site) so an operator can attach the current
// tournament to a real, shareable event — same portal-popup convention as
// TeamPicker/MatchSchedulePicker. Also offers creating a brand new event
// directly from here, for when nothing to load exists yet.
export function EventPicker({ onPick, defaultName, defaultDateRange }: Props) {
  const token = useAuthStore(s => s.token);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'list' | 'create'>('list');
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [events, setEvents] = useState<RemoteEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [vendors, setVendors] = useState<RemoteVendor[]>([]);
  const [form, setForm] = useState({ name: '', startDate: todayStr(), endDate: todayStr(), location: '', vendorId: '' });
  const popupRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const loadEvents = async () => {
    if (!token) { setError('Not signed in'); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/desktop/events`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error();
      const body = await res.json();
      setEvents(body.events ?? []);
    } catch {
      setError('Failed to load events');
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    if (!open) {
      if (anchorRef.current) {
        const r = anchorRef.current.getBoundingClientRect();
        setPos({ left: r.left, top: r.bottom + 6 });
      }
      setMode('list');
      loadEvents();
    }
    setOpen(v => !v);
  };

  const loadVendors = async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/api/desktop/vendors`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error();
      const body = await res.json();
      const list: RemoteVendor[] = body.vendors ?? [];
      setVendors(list);
      const current = list.find(v => v.isCurrent) ?? list[0];
      setForm(f => ({ ...f, vendorId: current?.id ?? '' }));
    } catch {
      // Silent — the server falls back to the token's own vendor if omitted.
      setVendors([]);
    }
  };

  const startCreate = () => {
    setForm({
      name: defaultName ?? '',
      startDate: defaultDateRange?.start ?? todayStr(),
      endDate: defaultDateRange?.end ?? todayStr(),
      location: '',
      vendorId: '',
    });
    setSaveError(null);
    setMode('create');
    loadVendors();
  };

  const canSave = form.name.trim() && form.startDate && form.endDate && form.location.trim();

  const submitCreate = async () => {
    if (!token || !canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`${API_BASE}/api/desktop/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(form),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || 'Failed to create event');
      onPick(body.event);
      setOpen(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to create event');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button ref={anchorRef} className="tm-btn" title="Link this tournament to a shared event from event.gomonetwork.com" onClick={toggle}>
        🔗 Load Shared Event
      </button>
      {open && pos && createPortal(
        <div ref={popupRef} className="event-picker-popup" style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 10000 }}>
          {mode === 'list' ? (
            <>
              <div className="event-picker-title">Load Shared Event</div>
              {loading && <div className="event-picker-empty">Loading…</div>}
              {!loading && error && <div className="event-picker-empty">{error}</div>}
              {!loading && !error && events.length === 0 && (
                <div className="event-picker-empty">No events found for your account.</div>
              )}
              {!loading && !error && events.map(ev => (
                <button key={ev.id} className="event-picker-row" onClick={() => { onPick(ev); setOpen(false); }}>
                  <span className="event-picker-row-name">{ev.name}</span>
                  <span className="event-picker-row-meta">
                    {fmtDate(ev.startDate)}{ev.location ? ` · ${ev.location}` : ''}
                  </span>
                </button>
              ))}
              <button className="event-picker-create-btn" onClick={startCreate}>☁ Push This Tournament as a New Event</button>
            </>
          ) : (
            <div className="event-picker-form">
              <div className="event-picker-title">Push This Tournament as a New Event</div>
              <p className="event-picker-form-hint">Name{defaultDateRange ? ' and dates are' : ' is'} filled in from this tournament — just add the location.</p>
              {vendors.length > 1 && (
                <label className="event-picker-field">
                  <span>Organisation *</span>
                  <select className="field-input" value={form.vendorId}
                    onChange={e => setForm(f => ({ ...f, vendorId: e.target.value }))}>
                    {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </label>
              )}
              <label className="event-picker-field">
                <span>Name *</span>
                <input className="field-input" value={form.name} placeholder="e.g. NRDP 2027"
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoFocus />
              </label>
              <div className="event-picker-field-row">
                <label className="event-picker-field">
                  <span>Start date *</span>
                  <input className="field-input" type="date" value={form.startDate}
                    onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} />
                </label>
                <label className="event-picker-field">
                  <span>End date *</span>
                  <input className="field-input" type="date" value={form.endDate}
                    onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} />
                </label>
              </div>
              <label className="event-picker-field">
                <span>Location *</span>
                <input className="field-input" value={form.location} placeholder="e.g. Kuala Lumpur"
                  onChange={e => setForm(f => ({ ...f, location: e.target.value }))} />
              </label>
              {saveError && <div className="event-picker-empty">{saveError}</div>}
              <div className="event-picker-form-actions">
                <button className="tm-btn" onClick={() => setMode('list')} disabled={saving}>← Back</button>
                <button className="tm-btn tm-btn--cloud-active" onClick={submitCreate} disabled={!canSave || saving}>
                  {saving ? 'Creating…' : 'Create & Link'}
                </button>
              </div>
            </div>
          )}
        </div>,
        document.body
      )}
    </>
  );
}
