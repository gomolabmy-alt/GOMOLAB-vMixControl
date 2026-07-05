import { useRef, useContext, useEffect } from 'react';
import { useVmixStore } from '../../stores/vmixStore';
import { useCanvasStore } from '../../stores/canvasStore';
import { CanvasActionContext } from '../../lib/canvasContext';

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

export function FilePathWidget({ widgetId, config }: Props) {
  const { getClient, vmixState, vmixSyncVersion } = useVmixStore();
  const connVmixState = vmixState;
  const store = useCanvasStore();
  const ctx = useContext(CanvasActionContext);
  const updateWidgetConfig = ctx?.updateWidgetConfig ?? store.updateWidgetConfig;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentPath: string = config.currentPath ?? '';
  const configured = !!(config.inputKey && config.fieldName);

  const send = (path: string) => {
    if (!configured || !path) return;
    getClient()?.setTextField(config.inputKey, config.fieldName, path);
  };

  // Re-send the currently-selected path on reconnect (vmixSyncVersion bump) —
  // otherwise vMix stays on whatever it last had until the operator picks a
  // new file, even though the app already shows a different path as current.
  useEffect(() => {
    if (config.autoSend && currentPath) send(currentPath);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vmixSyncVersion]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Electron exposes the real filesystem path via the non-standard .path property
    const path = (file as any).path || file.name;

    updateWidgetConfig(widgetId, { currentPath: path });

    if (config.autoSend) {
      send(path);
    }

    // Reset so the same file can be re-selected
    e.target.value = '';
  };

  const fileName = currentPath ? currentPath.split(/[\\/]/).pop() : '';
  const inputMeta = connVmixState?.inputs.find(i => i.key === config.inputKey);

  return (
    <div className="wgt-filepath">
      {/* Hidden real file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={config.accept || undefined}
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {/* Browse button */}
      <button
        className="wgt-filepath-browse"
        onClick={() => fileInputRef.current?.click()}
      >
        📁 Browse
      </button>

      {/* Path display / manual edit */}
      <div className="wgt-filepath-path" title={currentPath}>
        {currentPath ? (
          <>
            <span className="wgt-filepath-filename">{fileName}</span>
            <span className="wgt-filepath-dir">{currentPath}</span>
          </>
        ) : (
          <span className="wgt-filepath-empty">No file selected</span>
        )}
      </div>

      {/* Send bar */}
      <div className="wgt-filepath-footer">
        <span className="wgt-filepath-target">
          {inputMeta ? `→ ${inputMeta.number}. ${inputMeta.title} · ${config.fieldName}` : '⚙ Set target in settings'}
        </span>
        {!config.autoSend && (
          <button
            className="wgt-filepath-send"
            onClick={() => send(currentPath)}
            disabled={!configured || !currentPath}
          >
            Send ↵
          </button>
        )}
        {config.autoSend && currentPath && (
          <span className="wgt-filepath-auto-badge">AUTO</span>
        )}
      </div>
    </div>
  );
}
