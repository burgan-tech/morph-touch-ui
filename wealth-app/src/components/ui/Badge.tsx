import { STATE_LABELS } from '../../lib/constants';
import { getStateBadgeColor } from '../../lib/utils';

interface BadgeProps {
  state: string;
  size?: 'sm' | 'md';
}

export function Badge({ state, size = 'sm' }: BadgeProps) {
  const color = getStateBadgeColor(state);
  return (
    <span
      className={`badge badge-${size}`}
      style={{ '--badge-color': color } as React.CSSProperties}
    >
      <span className="badge-dot" />
      {STATE_LABELS[state] || state}
    </span>
  );
}
