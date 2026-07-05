import { resolveImageUrl } from '../../lib/imageUrl';

interface Props {
  config: Record<string, any>;
}

export function ImageDisplayWidget({ config }: Props) {
  const url = resolveImageUrl(config.imageUrl ?? '');
  const fit: React.CSSProperties['objectFit'] = config.objectFit ?? 'contain';
  const bg = config.bgColor ?? 'transparent';

  return (
    <div className="wgt-imgdisp" style={{ background: bg }}>
      {url ? (
        <img
          className="wgt-imgdisp-img"
          src={url}
          alt={config.caption ?? ''}
          style={{ objectFit: fit }}
          draggable={false}
        />
      ) : (
        <span className="wgt-imgdisp-placeholder">🖼 Select image in ⚙</span>
      )}
      {config.caption && url && (
        <div className="wgt-imgdisp-caption">{config.caption}</div>
      )}
    </div>
  );
}
