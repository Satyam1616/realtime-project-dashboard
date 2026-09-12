import { initials } from '../../lib/labels';

interface AvatarProps {
  name: string;
  /** Hex assigned per user in the database, so a person's colour is stable. */
  color?: string;
  size?: 'sm' | 'md' | 'lg';
  title?: string;
}

export const Avatar = ({ name, color = '#64748b', size = 'md', title }: AvatarProps): React.JSX.Element => (
  <span
    className={`avatar${size === 'sm' ? ' avatar-sm' : size === 'lg' ? ' avatar-lg' : ''}`}
    style={{ background: color }}
    title={title ?? name}
    aria-hidden="true"
  >
    {initials(name)}
  </span>
);

/** Avatar + name, the pairing used in every table row and card footer. */
export const UserChip = ({
  name,
  color,
  size = 'sm',
  secondary,
}: {
  name: string;
  color?: string;
  size?: 'sm' | 'md';
  secondary?: string;
}): React.JSX.Element => (
  <span className="row gap-2" style={{ minWidth: 0 }}>
    <Avatar name={name} {...(color ? { color } : {})} size={size} />
    <span className="truncate">
      {name}
      {secondary ? <span className="dim small"> · {secondary}</span> : null}
    </span>
  </span>
);
