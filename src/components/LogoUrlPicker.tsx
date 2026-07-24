import { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTeamDbStore } from '../stores/teamDbStore';
import { resolveImageUrl, transparentLogoUrl } from '../lib/imageUrl';
import { ConfirmModal } from './ConfirmModal';

const isTauriApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface ImageInfo { name: string; url: string; tournamentId?: string }

// Double-click a library filename to rename it in place.
function RenamableName({ name, onRename }: { name: string; onRename: (newName: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) requestAnimationFrame(() => { ref.current?.focus(); ref.current?.select(); });
  }, [editing]);

  const commit = () => { setEditing(false); if (draft.trim() && draft !== name) onRename(draft); };

  if (editing) {
    return (
      <input
        ref={ref}
        className="logo-library-name-input"
        value={draft}
        onClick={e => e.stopPropagation()}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') { setDraft(name); setEditing(false); }
        }}
      />
    );
  }

  return (
    <span
      className="logo-library-name"
      title={`${name} — double-click to rename`}
      onDoubleClick={e => { e.stopPropagation(); setDraft(name); setEditing(true); }}
    >
      {name}
    </span>
  );
}

interface Props {
  value: string;
  onChange: (url: string) => void;
  placeholder?: string;
  /** Compact mode: shows a thumbnail button instead of a text input row */
  compact?: boolean;
  /** Compact mode only: custom thumbnail content (e.g. a colored placeholder
   *  box matching a team's color) instead of the default image/icon. Click
   *  behavior (opens the picker) is unchanged. */
  thumbContent?: React.ReactNode;
  /** Compact mode only: size of the clickable thumbnail box, in px. */
  thumbSize?: { w: number; h: number };
  /** When set, the library opens scoped to this tournament's own team logos
   *  first (a much shorter, more relevant list) — the full server image
   *  library is still one click away via "Browse full library". */
  tournamentId?: string;
  /** Compact mode only: shows the thumbnail read-only — no click to open the
   *  library, no "remove logo" button. */
  disabled?: boolean;
}

export function LogoUrlPicker({ value, onChange, placeholder, compact, thumbContent, thumbSize, tournamentId, disabled }: Props) {
  const [showLibrary, setShowLibrary] = useState(false);
  const [browseAll, setBrowseAll] = useState(false);
  const [libraryScope, setLibraryScope] = useState<'mine' | 'all'>('mine');
  const [libPos, setLibPos] = useState<{ left: number; bottom: number } | null>(null);
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const { teams: dbTeams } = useTeamDbStore();

  // This tournament's own team logos — de-duplicated by URL — shown first so
  // picking a logo doesn't require scrolling the entire global upload library.
  const teamLogos = useMemo(() => {
    if (!tournamentId) return [];
    const seen = new Set<string>();
    const out: { name: string; url: string }[] = [];
    for (const t of dbTeams) {
      if (t.tournamentId === tournamentId && t.logo && !seen.has(t.logo)) {
        seen.add(t.logo);
        out.push({ name: t.name, url: t.logo });
      }
    }
    return out;
  }, [dbTeams, tournamentId]);
  const showScoped = !!tournamentId && teamLogos.length > 0 && !browseAll;

  // Full-library filter: untagged images (uploaded before this feature, or
  // general/shared logos) always show in "mine" too — only images explicitly
  // tagged to a *different* tournament get hidden. This keeps the rollout
  // non-disruptive for existing libraries with no tags yet.
  const visibleImages = useMemo(() => {
    if (!tournamentId || libraryScope === 'all') return images;
    return images.filter(img => !img.tournamentId || img.tournamentId === tournamentId);
  }, [images, tournamentId, libraryScope]);
  const clearScoped = !!tournamentId && libraryScope === 'mine' && visibleImages.length !== images.length;

  const [confirmDeleteImg, setConfirmDeleteImg] = useState<ImageInfo | null>(null);
  const [confirmClearLibrary, setConfirmClearLibrary] = useState(false);

  useEffect(() => {
    if (!showLibrary) return;
    loadImages();
  }, [showLibrary]);

  useEffect(() => {
    if (!showLibrary) return;
    const handler = (e: MouseEvent) => {
      // ConfirmModal portals to document.body on its own, outside popupRef's
      // subtree — without this check, a mousedown on its Confirm/Cancel
      // button would read as "outside click", closing the library (and
      // unmounting the modal with it) before the button's own click fires.
      if (confirmDeleteImg || confirmClearLibrary) return;
      if (popupRef.current && !popupRef.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        setShowLibrary(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showLibrary, confirmDeleteImg, confirmClearLibrary]);

  // Opens via a portal into document.body, positioned above the anchor with
  // fixed coordinates: widgets and table rows commonly have overflow:hidden
  // (for rounded corners / clipping), which would silently clip an
  // absolutely-positioned popup nested inside them.
  const toggleLibrary = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!showLibrary && anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect();
      setLibPos({ left: r.left, bottom: window.innerHeight - r.top + 6 });
      setBrowseAll(false);
      setLibraryScope('mine');
    }
    setShowLibrary(v => !v);
  };

  async function loadImages() {
    setLoading(true);
    try {
      if (isTauriApp) {
        const { invoke } = await import('@tauri-apps/api/core');
        const list = await invoke<ImageInfo[]>('list_images');
        setImages(list);
      } else {
        const res = await fetch(`http://${window.location.host}/api/images`);
        setImages(await res.json());
      }
    } catch {
      setImages([]);
    } finally {
      setLoading(false);
    }
  }

  // In Tauri: use native file dialog → save_image command (file input path is not available)
  async function handleUploadClick() {
    if (isTauriApp) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const path = await invoke<string | null>('open_image_dialog');
        if (path) {
          const result = await invoke<{ name: string; url: string }>('save_image', { srcPath: path, tournamentId });
          onChange(result.url);
        }
      } catch { /* ignore */ }
      setShowLibrary(false);
    } else {
      fileInputRef.current?.click();
    }
  }

  // Browser-only: file input → POST multipart to server
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`http://${window.location.host}/api/images`, { method: 'POST', body: form });
      if (res.ok) onChange((await res.json()).url);
    } catch { /* ignore */ }
    setShowLibrary(false);
  }

  // Library management (Tauri only — the browser/remote preview path has no
  // mutation routes for this yet, only list/upload). Confirmation goes
  // through ConfirmModal rather than native confirm(), which has already
  // been found unreliable in the packaged Tauri webview elsewhere in this app.
  function handleDeleteImage(e: React.MouseEvent, img: ImageInfo) {
    e.stopPropagation();
    if (!isTauriApp) return;
    setConfirmDeleteImg(img);
  }

  async function performDeleteImage(img: ImageInfo) {
    setConfirmDeleteImg(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('delete_image', { name: img.name });
      if (value === img.url) onChange('');
      loadImages();
    } catch { /* ignore */ }
  }

  function handleClearLibrary(e: React.MouseEvent) {
    e.stopPropagation();
    if (!isTauriApp || visibleImages.length === 0) return;
    setConfirmClearLibrary(true);
  }

  async function performClearLibrary() {
    setConfirmClearLibrary(false);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      for (const img of visibleImages) await invoke('delete_image', { name: img.name });
      if (visibleImages.some(img => img.url === value)) onChange('');
      loadImages();
    } catch { /* ignore */ }
  }

  // Picking an existing (possibly untagged, or tagged-elsewhere) image from
  // the full library counts as "this logo is used by this tournament" —
  // silently (re)tag it so it shows up under "This Tournament" from now on.
  async function tagImageForTournament(imageName: string) {
    if (!isTauriApp || !tournamentId) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_image_tournament', { name: imageName, tournamentId });
    } catch { /* ignore */ }
  }

  async function handleRenameImage(img: ImageInfo, newName: string) {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === img.name) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<{ name: string; url: string }>('rename_image', { oldName: img.name, newName: trimmed });
      if (value === img.url) onChange(result.url);
      loadImages();
    } catch { /* ignore */ }
  }

  const library = libPos && (
    <>
    <div
      ref={popupRef}
      className="logo-library"
      onClick={e => e.stopPropagation()}
      style={{ position: 'fixed', left: libPos.left, bottom: libPos.bottom, zIndex: 10000,
        minWidth: 220, background: 'var(--bg-1)', maxHeight: 280, overflowY: 'auto',
        boxShadow: '0 -4px 16px rgba(0,0,0,.5)', borderRadius: 6 }}
    >
      <div className="logo-library-header">
        <span className="logo-library-title">{showScoped ? 'Team Logos' : 'Server Images'}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="btn btn--ghost btn--small" title="Use a blank/transparent image — clears any logo instead of leaving one set"
            onClick={() => { onChange(transparentLogoUrl()); setShowLibrary(false); }} style={{ fontSize: 10, padding: '1px 6px' }}>
            ⬜ Transparent
          </button>
          {showScoped ? (
            <button className="btn btn--ghost btn--small" onClick={() => setBrowseAll(true)} style={{ fontSize: 10, padding: '1px 6px' }}>
              Browse full library →
            </button>
          ) : (
            <>
              {tournamentId && teamLogos.length > 0 && (
                <button className="btn btn--ghost btn--small" onClick={() => setBrowseAll(false)} style={{ fontSize: 10, padding: '1px 6px' }}>
                  ← Team logos
                </button>
              )}
              {tournamentId && (
                <button className="btn btn--ghost btn--small"
                  title="Picking or uploading a logo here tags it to this tournament"
                  onClick={() => setLibraryScope(s => s === 'mine' ? 'all' : 'mine')} style={{ fontSize: 10, padding: '1px 6px' }}>
                  {libraryScope === 'mine' ? 'Show all →' : '← This tournament'}
                </button>
              )}
              <button className="btn btn--ghost btn--small" onClick={handleUploadClick} style={{ fontSize: 10, padding: '1px 6px' }}>↑ Upload</button>
              <button className="btn btn--ghost btn--small" onClick={loadImages} style={{ fontSize: 10, padding: '1px 5px' }}>↺</button>
              {isTauriApp && visibleImages.length > 0 && (
                <button className="btn btn--ghost btn--small" title={tournamentId && libraryScope === 'mine' ? 'Delete every image shown here' : 'Delete every image in the library'}
                  onClick={handleClearLibrary} style={{ fontSize: 10, padding: '1px 6px', color: 'var(--red)' }}>
                  🗑 Clear
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {showScoped ? (
        <div className="logo-library-grid">
          {teamLogos.map(t => (
            <div key={t.url} className="logo-library-item" style={{ cursor: 'pointer' }} title={t.name}
              onClick={() => { onChange(t.url); setShowLibrary(false); }}>
              <img src={resolveImageUrl(t.url)} alt={t.name} className="logo-library-thumb" />
              <span className="logo-library-name">{t.name}</span>
            </div>
          ))}
        </div>
      ) : loading ? (
        <div className="logo-library-empty">Loading…</div>
      ) : visibleImages.length === 0 ? (
        <div className="logo-library-empty">
          {tournamentId && libraryScope === 'mine' && images.length > 0
            ? 'No logos tagged to this tournament yet — click "Show all", or upload one'
            : 'No images yet — upload one'}
        </div>
      ) : (
        <div className="logo-library-grid">
          {visibleImages.map(img => (
            <div key={img.name} className="logo-library-item" style={{ cursor: 'pointer' }}
              title={tournamentId && img.tournamentId === tournamentId ? `${img.name} — tagged to this tournament` : img.name}
              onClick={() => {
                onChange(img.url);
                if (tournamentId && img.tournamentId !== tournamentId) tagImageForTournament(img.name);
                setShowLibrary(false);
              }}>
              {isTauriApp && (
                <button className="logo-library-del" title="Delete this image" onClick={e => handleDeleteImage(e, img)}>×</button>
              )}
              {tournamentId && img.tournamentId === tournamentId && (
                <span className="logo-library-tag" title="Tagged to this tournament">📌</span>
              )}
              <img src={resolveImageUrl(img.url)} alt={img.name} className="logo-library-thumb" />
              {isTauriApp ? (
                <RenamableName name={img.name} onRename={newName => handleRenameImage(img, newName)} />
              ) : (
                <span className="logo-library-name">{img.name}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
    {confirmDeleteImg && (
      <ConfirmModal
        title="Delete image"
        message={`Delete "${confirmDeleteImg.name}" from the library? This can't be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => performDeleteImage(confirmDeleteImg)}
        onCancel={() => setConfirmDeleteImg(null)}
      />
    )}
    {confirmClearLibrary && (
      <ConfirmModal
        title="Clear library"
        message={`Delete ${clearScoped ? "this tournament's" : 'all'} ${visibleImages.length} image${visibleImages.length !== 1 ? 's' : ''}${clearScoped ? ' shown here' : ' in the library'}? This can't be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={performClearLibrary}
        onCancel={() => setConfirmClearLibrary(false)}
      />
    )}
    </>
  );

  if (compact) {
    const w = thumbSize?.w ?? 48;
    const h = thumbSize?.h ?? 36;
    return (
      <div ref={anchorRef} style={{ position: 'relative', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
        <div
          className="tm-team-logo-thumb-wrap"
          onClick={disabled ? undefined : toggleLibrary}
          style={thumbContent ? { cursor: disabled ? 'default' : 'pointer', position: 'relative', width: w, height: h, overflow: 'hidden' } : {
            cursor: disabled ? 'default' : 'pointer', position: 'relative', width: w, height: h,
            border: '1px dashed var(--border)', borderRadius: 4, background: '#111',
            display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
          title={disabled ? undefined : (value ? 'Change logo' : 'Pick logo')}
        >
          {thumbContent ?? (value
            ? <img src={resolveImageUrl(value)} alt="logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            : <span style={{ fontSize: 18, opacity: 0.4 }}>🖼</span>
          )}
        </div>
        {value && !thumbContent && !disabled && (
          <button className="tm-team-logo-clear" title="Remove logo" onClick={() => onChange('')}>×</button>
        )}
        <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />
        {showLibrary && library && createPortal(library, document.body)}
      </div>
    );
  }

  return (
    <div ref={anchorRef} style={{ position: 'relative' }}>
      <div className="logo-url-row">
        {value && (
          <img src={resolveImageUrl(value)} alt="" style={{ width: 32, height: 24, objectFit: 'contain', borderRadius: 3,
            border: '1px solid var(--border)', background: '#111', flexShrink: 0 }} />
        )}
        <input
          className="input"
          type="text"
          placeholder={placeholder ?? 'http://… or path'}
          value={value}
          onChange={e => onChange(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button className="btn btn--ghost btn--small" title="Choose from server library" onClick={toggleLibrary}>⊞</button>
        {value && (
          <button className="btn btn--ghost btn--small" title="Clear" onClick={() => onChange('')} style={{ color: 'var(--text-muted)' }}>✕</button>
        )}
      </div>
      <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />
      {showLibrary && library && createPortal(library, document.body)}
    </div>
  );
}

// ── Logo picker that only shows URLs from the tournament database ─────────────
// Used in vMix logo URL fields — no upload, just pick existing team logos.

interface DbPickerProps {
  value: string;
  onChange: (url: string) => void;
  /** Also offer these quick URLs (e.g. current scoreboard's teamALogo/teamBLogo) */
  quickUrls?: Array<{ label: string; url: string }>;
}

export function LogoDbPicker({ value, onChange, quickUrls = [] }: DbPickerProps) {
  const { teams } = useTeamDbStore();
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Collect all team logos from the database
  const dbLogos: Array<{ label: string; url: string }> = [];
  for (const t of teams) {
    if (t.logo) dbLogos.push({ label: t.name, url: t.logo });
  }

  const allOptions = [
    ...quickUrls.filter(q => q.url),
    ...dbLogos.filter(d => !quickUrls.some(q => q.url === d.url)),
  ];

  return (
    <div ref={anchorRef} style={{ position: 'relative' }}>
      <div className="logo-url-row">
        {value && (
          <img src={resolveImageUrl(value)} alt="" style={{ width: 32, height: 24, objectFit: 'contain', borderRadius: 3,
            border: '1px solid var(--border)', background: '#111', flexShrink: 0 }} />
        )}
        <input className="input" type="text" placeholder="Pick from teams or type URL"
          value={value} onChange={e => onChange(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
        <button className="btn btn--ghost btn--small" title="Pick from team logos" onClick={() => setOpen(v => !v)}>▾</button>
        {value && (
          <button className="btn btn--ghost btn--small" title="Clear" onClick={() => onChange('')} style={{ color: 'var(--text-muted)' }}>✕</button>
        )}
      </div>
      {open && (
        <div ref={popupRef} style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 300,
          background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 6, marginTop: 4,
          maxHeight: 200, overflowY: 'auto', boxShadow: '0 4px 16px rgba(0,0,0,.5)' }}>
          {allOptions.length === 0 ? (
            <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
              No team logos saved — upload logos in Tournament Manager
            </div>
          ) : (
            allOptions.map((opt, i) => (
              <div key={i} onClick={() => { onChange(opt.url); setOpen(false); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                  cursor: 'pointer', borderBottom: '1px solid var(--border)' }}
                className="logo-db-option">
                <img src={resolveImageUrl(opt.url)} alt="" style={{ width: 32, height: 24, objectFit: 'contain',
                  border: '1px solid var(--border)', borderRadius: 3, background: '#111', flexShrink: 0 }} />
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{opt.label}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
