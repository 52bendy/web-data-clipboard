/**
 * Sender masking for admin-facing log output (PRD §8.2).
 *
 * Mainland mobile numbers keep their first three and last four digits
 * (`13800138000` → `138****8000`, `+8613800138000` → `+86138****8000`).
 * Other long phone-like numbers are masked the same way; short service codes
 * such as `10086` / `95555` and non-numeric senders are left untouched.
 */
export function maskSender(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed.length === 0) return trimmed;

  // Ignore common separators when deciding whether the sender is a number,
  // but always return a canonical masked form without them.
  const compact = trimmed.replace(/[\s-]/g, '');

  const mainland = compact.match(/^(\+?86)?(1\d{10})$/);
  if (mainland) {
    const prefix = mainland[1]
      ? mainland[1].startsWith('+')
        ? '+86'
        : '86'
      : '';
    const digits = mainland[2];
    return `${prefix}${digits.slice(0, 3)}****${digits.slice(7)}`;
  }

  const general = compact.match(/^(\+)?(\d{10,15})$/);
  if (general) {
    const digits = general[2];
    return `${general[1] ? '+' : ''}${digits.slice(0, 3)}****${digits.slice(-4)}`;
  }

  return trimmed;
}

/** Returns a copy of a log entry with its sender masked when enabled. */
export function maskLogEntry(entry, enabled = true) {
  if (!enabled) return { ...entry };
  return { ...entry, sender: maskSender(entry.sender) };
}
