import { useState } from 'react';
import type { Tournament, Player } from '../types/tournament';
import { useTournamentStore } from '../stores/tournamentStore';
import { useTeamDbStore } from '../stores/teamDbStore';
import {
  resolveExternalRosterLink, fetchExternalTeams, fetchExternalPlayers, rankExternalTeams,
  type ExternalTeamSummary,
} from '../lib/externalRoster';
import { ConfirmModal } from './ConfirmModal';

const isTauriApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// ── Tournament-level: link/unlink the external roster API ───────────────────
// Lives once per tournament (Tournament.externalRoster) — every team's own
// "Pull from API" button (below) reads this same link, so it only needs to
// be set up once per tournament, not per team.
export function ExternalRosterLinkBar({ tournament }: { tournament: Tournament }) {
  const { updateTournament } = useTournamentStore();
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);

  if (!isTauriApp) return null;

  const link = tournament.externalRoster;

  const connect = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const source = await resolveExternalRosterLink(url);
      updateTournament(tournament.id, { externalRoster: source });
      setEditing(false);
      setUrl('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div className="tm-ext-roster-bar">
        <input
          className="input"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="Paste a team or tournament link from the roster site…"
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') connect(); if (e.key === 'Escape') { setEditing(false); setError(''); } }}
          autoFocus
        />
        <button className="tm-io-btn tm-io-btn--ok" onClick={connect} disabled={busy || !url.trim()}>
          {busy ? 'Checking…' : 'Connect'}
        </button>
        <button className="tm-io-btn" onClick={() => { setEditing(false); setError(''); }}>Cancel</button>
        {error && <span className="tm-ext-roster-error">{error}</span>}
      </div>
    );
  }

  if (!link) {
    return (
      <div className="tm-ext-roster-bar">
        <button className="tm-io-btn" onClick={() => setEditing(true)}>🔗 Link roster API</button>
      </div>
    );
  }

  return (
    <div className="tm-ext-roster-bar">
      <span className="tm-ext-roster-linked" title={`${link.baseUrl}/api/public/tournaments/${link.tournamentId}`}>
        🔗 Linked: <strong>{link.tournamentName ?? link.tournamentId}</strong>
      </span>
      <button className="tm-io-btn" onClick={() => { setEditing(true); setUrl(''); }}>Change</button>
      <button className="tm-io-btn tm-io-btn--danger" onClick={() => setConfirmingUnlink(true)}>Unlink</button>
      {confirmingUnlink && (
        <ConfirmModal
          title="Unlink roster API"
          message={`Stop pulling player names from "${link.tournamentName ?? link.tournamentId}" for this tournament? You can link it again later.`}
          confirmLabel="Unlink"
          danger
          onConfirm={() => { updateTournament(tournament.id, { externalRoster: undefined }); setConfirmingUnlink(false); }}
          onCancel={() => setConfirmingUnlink(false)}
        />
      )}
    </div>
  );
}

// ── Team-level: pull player names from the linked API into this team ────────
// Hands the resolved names back via onPulled rather than writing to the team
// itself — the caller (PlayersPanel) already has a Replace-all/Append/Cancel
// preview flow for CSV imports; routing API pulls through the exact same
// preview keeps one consistent "review before it lands on the roster" UX
// instead of a second, differently-behaved import path.
export function PullPlayersButton({
  tournament, teamId, teamName, teamCategory, onPulled,
}: {
  tournament: Tournament;
  teamId: string;
  teamName: string;
  teamCategory?: string;
  onPulled: (players: Omit<Player, 'id'>[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [teams, setTeams] = useState<ExternalTeamSummary[]>([]);
  const [filter, setFilter] = useState('');
  const [pulling, setPulling] = useState<string | null>(null);

  const linkedSlug = useTeamDbStore(s => s.teams.find(t => t.id === teamId)?.externalTeamSlug);
  const source = tournament.externalRoster;
  if (!isTauriApp || !source) return null;

  const openPicker = async () => {
    setOpen(true);
    setError('');
    setFilter('');
    if (teams.length === 0) {
      setLoading(true);
      try {
        setTeams(await fetchExternalTeams(source));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }
  };

  const ranked = rankExternalTeams(teams, teamName, teamCategory).filter(t =>
    !filter.trim() || t.name.toLowerCase().includes(filter.trim().toLowerCase())
  );

  // Two teams sharing a name across categories (e.g. "SARAWAK" entered in
  // both Boys and Girls) are otherwise indistinguishable in this dialog —
  // spell out which one you're about to overwrite/append to.
  const displayName = teamCategory ? `${teamName} - ${teamCategory}` : teamName;

  const pull = async (ext: ExternalTeamSummary) => {
    if (pulling) return;
    setPulling(ext.slug);
    setError('');
    try {
      const players = await fetchExternalPlayers(source, ext.slug);
      if (players.length === 0) {
        setError(`"${ext.name}" has no players listed yet on the source site.`);
        return;
      }
      onPulled(players.map(p => ({
        name: p.name,
        jerseyNo: p.jerseyNumber !== undefined ? String(p.jerseyNumber) : '',
        position: p.position ?? '',
        tries: p.tries, conversions: p.conversions, penalties: p.penalties, dropGoals: p.dropGoals,
        yellowCards: p.yellowCards, redCards: p.redCards, appearances: p.appearances,
      })));
      // Remembers this exact external team so the periodic auto-sync (see
      // externalRoster.ts's startRosterAutoSync) knows what to keep
      // re-pulling for this team without a human re-picking it every cycle.
      useTeamDbStore.getState().updateTeam(teamId, { externalTeamSlug: ext.slug });
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPulling(null);
    }
  };

  return (
    <>
      <button className="tm-io-btn" onClick={openPicker} title={linkedSlug
        ? `Auto-syncing from the roster API every couple of minutes — click to re-pick, or pull now`
        : `Pull player names from the linked roster API into "${displayName}"`}>
        {linkedSlug ? '🔄 Auto-syncing' : '🔗 Pull from API'}
      </button>
      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div className="modal" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div className="modal-title">Pull players into "{displayName}"</div>
            <input
              className="input"
              placeholder="Filter teams…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              autoFocus
            />
            {error && <div className="tm-ext-roster-error">{error}</div>}
            {loading ? (
              <div className="tm-pl-empty">Loading teams…</div>
            ) : (
              <div className="tm-ext-roster-team-list">
                {ranked.map(t => (
                  <div key={t.id} className="tm-ext-roster-team-row" onClick={() => pull(t)}>
                    {t.logoUrl && <img src={t.logoUrl} alt="" className="tm-ext-roster-team-logo" />}
                    <span className="tm-ext-roster-team-name">
                      {t.name}
                      {t.slug === linkedSlug && <span title="Currently auto-syncing from this team"> 🔄</span>}
                    </span>
                    <span className="tm-io-btn tm-io-btn--ok">{pulling === t.slug ? 'Pulling…' : 'Pull'}</span>
                  </div>
                ))}
                {ranked.length === 0 && <div className="tm-pl-empty">No matching teams.</div>}
              </div>
            )}
            <div className="modal-actions">
              <button className="btn btn--ghost btn--small" onClick={() => setOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
