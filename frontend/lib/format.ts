// Formats a rolling-window quota reset timestamp as a short relative
// string ("in 42 min", "in 3h 10m") for display in the chat limit modal
// and the Settings "Usage" widget. The quota window frees up budget
// gradually as old events age out (see backend lib/quota.ts,
// QUOTA_WINDOW_HOURS) rather than resetting all at once at a fixed clock
// time, so there's no single "resets at midnight" string to show anymore.
// Formats a message's createdAt timestamp as a short "date time" string
// for the small caption shown under each chat bubble, e.g. "Jul 27, 14:32".
// Falls back to just the time for messages from today.
export function formatMessageTimestamp(createdAt: string): string {
  const date = new Date(createdAt);
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) return time;
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day}, ${time}`;
}

export function formatResetRelative(resetAt: string): string {
  const ms = new Date(resetAt).getTime() - Date.now();
  if (ms <= 0) return "shortly";
  const totalMinutes = Math.ceil(ms / 60000);
  if (totalMinutes < 60) return `in ${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `in ${hours}h ${minutes}m` : `in ${hours}h`;
}
