/**
 * Time formatting.
 *
 * The brief specifies the feed reads `"… · 2 mins ago"`, so `relativeTime()`
 * produces exactly that vocabulary rather than `Intl.RelativeTimeFormat`'s
 * "2 minutes ago". Everything else (tooltips, due dates) uses `Intl` so it
 * follows the viewer's locale.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "just now" / "2 mins ago" / "3 hours ago" / "5 days ago", then an absolute
 * date once relative wording stops being useful.
 *
 * Clamps negative deltas to "just now": a clock a few seconds ahead of the
 * server should not render "in 4 seconds" on a live feed.
 */
export const relativeTime = (iso: string, now: number = Date.now()): string => {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';

  const delta = now - then;
  if (delta < 45_000) return 'just now';

  if (delta < HOUR) {
    const mins = Math.round(delta / MINUTE);
    return `${mins} ${mins === 1 ? 'min' : 'mins'} ago`;
  }
  if (delta < DAY) {
    const hours = Math.round(delta / HOUR);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }
  if (delta < 7 * DAY) {
    const days = Math.round(delta / DAY);
    return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  }

  return absoluteDate(iso);
};

const dateFormatter = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const shortDateFormatter = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export const absoluteDate = (iso: string | null): string => {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date);
};

/** Day + month only — for dense table cells where the year is noise. */
export const shortDate = (iso: string | null): string => {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : shortDateFormatter.format(date);
};

/** Full timestamp, used as the `title` tooltip behind every relative time. */
export const absoluteDateTime = (iso: string | null): string => {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : dateTimeFormatter.format(date);
};

/**
 * Whole days until a due date, counted from midnight to midnight so a task due
 * "tomorrow at 09:00" reads as 1 day rather than 0 at 23:00 tonight.
 */
export const daysUntil = (iso: string | null, now: Date = new Date()): number | null => {
  if (!iso) return null;
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return null;

  const startOfDue = Date.UTC(due.getFullYear(), due.getMonth(), due.getDate());
  const startOfNow = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((startOfDue - startOfNow) / DAY);
};

/** "Overdue by 3 days" / "Due today" / "Due in 2 days" / "Due 4 Oct 2026". */
export const dueLabel = (iso: string | null, now: Date = new Date()): string => {
  const days = daysUntil(iso, now);
  if (days === null) return 'No due date';
  if (days < -1) return `Overdue by ${Math.abs(days)} days`;
  if (days === -1) return 'Overdue by 1 day';
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days <= 7) return `Due in ${days} days`;
  return `Due ${absoluteDate(iso)}`;
};

/** ISO date (`YYYY-MM-DD`) for `<input type="date">` round-tripping. */
export const toDateInputValue = (iso: string | null): string => {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};
