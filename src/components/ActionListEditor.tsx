import { Field, VMIX_FUNCTIONS, VMIX_ALL_FNS, InputPickerDropdown } from './WidgetConfigPanel';
import type { CanvasPage, CanvasWidget } from '../types/canvas';
import type { VmixInput, GlobalVariable } from '../types/vmix';
import type { ActionItem } from '../lib/buttonActions';

export type { ActionItem };

interface ActionListEditorProps {
  actions: ActionItem[];
  onChange: (next: ActionItem[]) => void;
  sectionKey: string;
  pages: CanvasPage[];
  timerWidgets: CanvasWidget[];
  scoreboardWidgets: CanvasWidget[];
  globalVariables: GlobalVariable[];
  allInputs: VmixInput[];
}

// Editor for a list of {fn, params} action items — App.* functions (targeting
// a specific timer/scoreboard widget instance) or raw vMix functions. Shared
// by the Button widget's Press/Release/Side-Button action lists and any
// per-widget "Hotkeys" section that wants the same App/vMix function picker
// (extracted from WidgetConfigPanel so it isn't rebuilt for each use site).
export function ActionListEditor({ actions, onChange, sectionKey, pages, timerWidgets, scoreboardWidgets, globalVariables, allInputs }: ActionListEditorProps) {
  const renderFnEditor = (
    action: ActionItem,
    setFn: (fn: string) => void,
    setParam: (k: string, v: string) => void,
    idxKey: string,
  ) => {
    const { fn, params } = action;
    const isApp = fn.startsWith('App.');
    const vmixDef = VMIX_ALL_FNS.find(f => f.fn === fn);
    const isCustomVmix = !isApp && !vmixDef;
    const vmixSelectVal = vmixDef ? fn : '__custom__';

    return (
      <div key={idxKey} className="action-editor">
        <Field label="Type">
          <select className="field-input" value={isApp ? 'app' : 'vmix'} onChange={e => {
            if (e.target.value === 'app') setFn('App.GoToPage');
            else setFn('Cut');
          }}>
            <option value="vmix">vMix Function</option>
            <option value="app">App Function</option>
          </select>
        </Field>

        {isApp ? (
          <>
            <Field label="App Function">
              <select className="field-input" value={fn} onChange={e => setFn(e.target.value)}>
                <optgroup label="Navigation">
                  <option value="App.GoToPage">Go To Page</option>
                </optgroup>
                <optgroup label="Timer">
                  <option value="App.TimerStart">Timer: Start</option>
                  <option value="App.TimerPause">Timer: Pause</option>
                  <option value="App.TimerToggle">Timer: Toggle Start/Pause</option>
                  <option value="App.TimerReset">Timer: Reset</option>
                  <option value="App.TimerEndPeriod">Timer: End Period</option>
                  <option value="App.TimerSkipBreak">Timer: Skip Break</option>
                </optgroup>
                <optgroup label="Scoreboard">
                  <option value="App.ScoreA">Score: Add Team A</option>
                  <option value="App.ScoreB">Score: Add Team B</option>
                  <option value="App.ScoreReset">Score: Reset</option>
                </optgroup>
                <optgroup label="Variable">
                  <option value="App.SetVariable">Set Variable</option>
                </optgroup>
                <optgroup label="App">
                  <option value="App.ToggleEditMode">Toggle Edit Mode</option>
                </optgroup>
              </select>
            </Field>
            {fn === 'App.GoToPage' && (
              <Field label="Page">
                <select className="field-input" value={params.Page ?? ''} onChange={e => setParam('Page', e.target.value)}>
                  <option value="">— select page —</option>
                  {pages.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
                </select>
              </Field>
            )}
            {['App.TimerStart','App.TimerPause','App.TimerReset','App.TimerToggle','App.TimerEndPeriod','App.TimerSkipBreak'].includes(fn) && (
              <Field label="Timer Widget">
                <select className="field-input" value={params.Input ?? ''} onChange={e => setParam('Input', e.target.value)}>
                  <option value="">— select timer —</option>
                  {timerWidgets.map(w => <option key={w.id} value={w.id}>{w.config.name || 'Timer'}</option>)}
                </select>
              </Field>
            )}
            {(fn === 'App.ScoreReset') && (
              <Field label="Scoreboard Widget">
                <select className="field-input" value={params.Input ?? ''} onChange={e => setParam('Input', e.target.value)}>
                  <option value="">— select scoreboard —</option>
                  {scoreboardWidgets.map(w => <option key={w.id} value={w.id}>{w.config.teamAName} vs {w.config.teamBName}</option>)}
                </select>
              </Field>
            )}
            {(fn === 'App.ScoreA' || fn === 'App.ScoreB') && (
              <>
                <Field label="Scoreboard Widget">
                  <select className="field-input" value={params.Input ?? ''} onChange={e => setParam('Input', e.target.value)}>
                    <option value="">— select scoreboard —</option>
                    {scoreboardWidgets.map(w => <option key={w.id} value={w.id}>{w.config.teamAName} vs {w.config.teamBName}</option>)}
                  </select>
                </Field>
                <Field label="Points">
                  <input className="field-input" type="number" min={1} value={params.Value ?? '1'} onChange={e => setParam('Value', e.target.value)} />
                </Field>
                <Field label="Label (e.g. Try)">
                  <input className="field-input" value={params.Label ?? ''} placeholder="Try, Conv, Pen…" onChange={e => setParam('Label', e.target.value)} />
                </Field>
              </>
            )}
            {fn === 'App.SetVariable' && (
              <>
                <Field label="Variable">
                  <select className="field-input" value={params.Variable ?? ''} onChange={e => setParam('Variable', e.target.value)}>
                    <option value="">— select variable —</option>
                    {globalVariables.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
                  </select>
                </Field>
                <Field label="Value">
                  <input className="field-input" value={params.Value ?? ''} onChange={e => setParam('Value', e.target.value)} />
                </Field>
              </>
            )}
          </>
        ) : (
          <>
            <Field label="vMix Function">
              <select className="field-input" value={vmixSelectVal} onChange={e => {
                if (e.target.value === '__custom__') setFn('');
                else setFn(e.target.value);
              }}>
                {VMIX_FUNCTIONS.map(g => (
                  <optgroup key={g.group} label={g.group}>
                    {g.fns.map(f => <option key={f.fn} value={f.fn}>{f.label}</option>)}
                  </optgroup>
                ))}
              </select>
            </Field>
            {isCustomVmix && (
              <Field label="Custom Function">
                <input className="field-input" value={fn} onChange={e => setFn(e.target.value)} placeholder="e.g. SetFader" />
              </Field>
            )}
            {vmixDef && vmixDef.p.map(pk => pk === 'Input' ? (
              <Field key={pk} label="Input">
                <InputPickerDropdown
                  currentKey={params.Input ?? ''}
                  currentTitle={allInputs.find(i => i.key === (params.Input ?? ''))?.title}
                  allInputs={allInputs}
                  onSelect={(key) => setParam('Input', key)}
                />
              </Field>
            ) : (
              <Field key={pk} label={pk}>
                <input className="field-input" value={params[pk] ?? ''} onChange={e => setParam(pk, e.target.value)} />
              </Field>
            ))}
            {isCustomVmix && (
              <Field label="Params (Key=Value)">
                <textarea className="field-input" rows={3}
                  value={Object.entries(params).map(([k,v]) => `${k}=${v}`).join('\n')}
                  onChange={e => {
                    const p: Record<string,string> = {};
                    e.target.value.split('\n').forEach(line => {
                      const [k,...rest] = line.split('=');
                      if (k?.trim()) p[k.trim()] = rest.join('=').trim();
                    });
                    setParam('__bulk__', JSON.stringify(p));
                  }} placeholder="Input=1&#10;Value=Hello" />
              </Field>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <>
      {actions.map((action, i) => (
        <div key={`${sectionKey}-${i}`} className="action-row">
          <div className="action-row-header">
            <span className="action-row-num">#{i + 1}</span>
            <button className="action-row-del" title="Remove" onClick={() => onChange(actions.filter((_, j) => j !== i))}>×</button>
          </div>
          {renderFnEditor(
            action,
            (fn) => onChange(actions.map((a, j) => j === i ? { fn, params: {} } : a)),
            (k, v) => {
              if (k === '__bulk__') {
                onChange(actions.map((a, j) => j === i ? { ...a, params: JSON.parse(v) } : a));
              } else {
                onChange(actions.map((a, j) => j === i ? { ...a, params: { ...a.params, [k]: v } } : a));
              }
            },
            `${sectionKey}-${i}`,
          )}
        </div>
      ))}
      <button className="action-add-btn" onClick={() => onChange([...actions, { fn: 'Cut', params: {} }])}>
        + Add Action
      </button>
    </>
  );
}
