import { useVmixStore } from '../../stores/vmixStore';
import { INPUT_TYPE_LABELS } from '../../types/vmix';

interface Props {
  config: Record<string, any>;
  w: number;
  h: number;
}

export function InputTallyWidget({ config }: Props) {
  const { vmixState, connections } = useVmixStore();
  const connVmixState = config.vmixClientId
    ? connections.find(c => c.id === config.vmixClientId)?.vmixState ?? vmixState
    : vmixState;

  const input = connVmixState?.inputs.find((i) => i.key === config.inputKey);
  const isPgm = connVmixState?.active === input?.number;
  const isPrv = connVmixState?.preview === input?.number;

  let tallyClass = '';
  if (isPgm) tallyClass = 'tally--pgm';
  else if (isPrv) tallyClass = 'tally--prv';

  return (
    <div className={`wgt-tally ${tallyClass}`}>
      <div className="wgt-tally-num">{input ? `#${input.number}` : '—'}</div>
      {config.showType !== false && input && (
        <div className="wgt-tally-type">{INPUT_TYPE_LABELS[input.type] ?? input.type}</div>
      )}
      {config.showTitle !== false && (
        <div className="wgt-tally-title">{input ? input.title : config.inputKey ? 'Not found' : 'Set input in ⚙'}</div>
      )}
      <div className="wgt-tally-state">
        {isPgm && <span className="tally-badge tally-badge--pgm">PGM</span>}
        {isPrv && <span className="tally-badge tally-badge--prv">PRV</span>}
      </div>
    </div>
  );
}
