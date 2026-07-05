import { useState, useRef, useEffect } from 'react';
import { useTournamentStore } from '../stores/tournamentStore';
import { resolveImageUrl } from '../lib/imageUrl';

const isTauriApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface ImageInfo { name: string; url: string }

interface Props {
  value: string;
  onChange: (url: string) => void;
  placeholder?: string;
  /** Compact mode: shows a thumbnail button instead of a text input row */
  compact?: boolean;
}

export function LogoUrlPicker({ value, onChange, placeholder, compact }: Props) {
  const [showLibrary, setShowLibrary] = useState(false);
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showLibrary) return;
    loadImages();
  }, [showLibrary]);

  useEffect(() => {
    if (!showLibrary) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        setShowLibrary(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showLibrary]);

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
          const result = await invoke<{ name: string; url: string }>('save_image', { srcPath: path });
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

  const library = (
    <div
      ref={popupRef}
      className="logo-library"
      style={{ position: 'absolute', top: '100%', left: 0, zIndex: 300,
        minWidth: 220, background: 'var(--bg-1)', marginTop: 4, maxHeight: 240, overflowY: 'auto',
        boxShadow: '0 4px 16px rgba(0,0,0,.5)', borderRadius: 6 }}
    >
      <div className="logo-library-header">
        <span className="logo-library-title">Server Images</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="btn btn--ghost btn--small" onClick={handleUploadClick} style={{ fontSize: 10, padding: '1px 6px' }}>↑ Upload</button>
          <button className="btn btn--ghost btn--small" onClick={loadImages} style={{ fontSize: 10, padding: '1px 5px' }}>↺</button>
        </div>
      </div>
      {loading ? (
        <div className="logo-library-empty">Loading…</div>
      ) : images.length === 0 ? (
        <div className="logo-library-empty">No images yet — upload one</div>
      ) : (
        <div className="logo-library-grid">
          {images.map(img => (
            <div key={img.name} className="logo-library-item" style={{ cursor: 'pointer' }} title={img.name}
              onClick={() => { onChange(img.url); setShowLibrary(false); }}>
              <img src={resolveImageUrl(img.url)} alt={img.name} className="logo-library-thumb" />
            </div>
          ))}
        </div>
      )}
    </div>
  );

  if (compact) {
    return (
      <div ref={anchorRef} style={{ position: 'relative', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
        <div
          className="tm-team-logo-thumb-wrap"
          onClick={() => setShowLibrary(v => !v)}
          style={{ cursor: 'pointer', position: 'relative', width: 48, height: 36,
            border: '1px dashed var(--border)', borderRadius: 4, background: '#111',
            display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
          title={value ? 'Change logo' : 'Pick logo'}
        >
          {value
            ? <img src={resolveImageUrl(value)} alt="logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            : <span style={{ fontSize: 18, opacity: 0.4 }}>🖼</span>
          }
        </div>
        {value && (
          <button className="tm-team-logo-clear" title="Remove logo" onClick={() => onChange('')}>×</button>
        )}
        <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />
        {showLibrary && library}
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
        <button className="btn btn--ghost btn--small" title="Choose from server library" onClick={() => setShowLibrary(v => !v)}>⊞</button>
        {value && (
          <button className="btn btn--ghost btn--small" title="Clear" onClick={() => onChange('')} style={{ color: 'var(--text-muted)' }}>✕</button>
        )}
      </div>
      <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />
      {showLibrary && library}
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
  const { tournaments } = useTournamentStore();
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
  for (const t of tournaments) {
    if (t.teamA.logo) dbLogos.push({ label: `${t.teamA.name} (${t.name})`, url: t.teamA.logo });
    if (t.teamB.logo) dbLogos.push({ label: `${t.teamB.name} (${t.name})`, url: t.teamB.logo });
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
