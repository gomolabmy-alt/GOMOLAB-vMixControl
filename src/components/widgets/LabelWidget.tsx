interface Props {
  config: Record<string, any>;
  w: number;
  h: number;
}

export function LabelWidget({ config }: Props) {
  return (
    <div
      className="wgt-label"
      style={{
        fontSize: (config.fontSize ?? 14) + 'px',
        color: config.color ?? '#ffffff',
        background: config.bgColor ?? 'transparent',
        textAlign: config.align ?? 'center',
        fontWeight: config.bold ? 700 : 400,
      }}
    >
      {config.text ?? 'Label'}
    </div>
  );
}
