import type { ReactNode } from 'react';

export const StatTile = ({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number | string;
  hint?: ReactNode;
  tone?: 'accent' | 'danger' | 'warn' | 'ok';
}): React.JSX.Element => (
  <div className={`stat${tone ? ` stat-${tone}` : ''}`}>
    <span className="stat-label">{label}</span>
    <span className="stat-value">{value}</span>
    {hint ? <span className="stat-hint">{hint}</span> : null}
  </div>
);

export interface BarDatum {
  label: string;
  value: number;
  /** CSS colour, usually a status/priority token. */
  color: string;
}

/**
 * Horizontal distribution. Scaled to the largest bar rather than the total, so
 * a 40/1/1/1 split is still readable — a percentage-of-total scale would
 * render three of those as invisible slivers.
 */
export const DistributionBars = ({ data }: { data: BarDatum[] }): React.JSX.Element => {
  const max = Math.max(1, ...data.map((datum) => datum.value));

  return (
    <div className="bars">
      {data.map((datum) => (
        <div className="bar-row" key={datum.label}>
          <span className="muted truncate">{datum.label}</span>
          <span className="bar-track">
            <span
              className="bar-fill"
              style={{ width: `${(datum.value / max) * 100}%`, background: datum.color }}
            />
          </span>
          <span className="bar-value">{datum.value}</span>
        </div>
      ))}
    </div>
  );
};
