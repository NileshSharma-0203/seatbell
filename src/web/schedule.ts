export interface Meeting {
  id: number;
  label: string;
  term: string;
  days: string | null;
  startTime: string | null;
  endTime: string | null;
}

export function parseDays(raw: string | null): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.match(/Th|Tu|Sa|Su|M|T|W|F/g) ?? []);
}

export function parseMinutes(raw: string | null): number | null {
  if (!raw) return null;
  const match = /^(\d{1,2}):?(\d{2})\s*([AP])\.?M?\.?$/i.exec(raw.trim()) ?? /^(\d{1,2}):?(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const period = match[3]?.toUpperCase();
  if (hours > 23 || minutes > 59) return null;
  if (period === 'P' && hours < 12) hours += 12;
  if (period === 'A' && hours === 12) hours = 0;
  return hours * 60 + minutes;
}

/** Maps each meeting id to the labels of meetings that overlap it. Unknown times never conflict. */
export function findConflicts(meetings: Meeting[]): Map<number, string[]> {
  const parsed = meetings.map((m) => ({
    ...m,
    dayset: parseDays(m.days),
    start: parseMinutes(m.startTime),
    end: parseMinutes(m.endTime),
  }));
  const conflicts = new Map<number, string[]>();
  for (const a of parsed) {
    for (const b of parsed) {
      // Two sections of one course are alternatives, not a clash.
      if (a.id === b.id || a.term !== b.term || a.label === b.label) continue;
      if (a.start === null || a.end === null || b.start === null || b.end === null) continue;
      if (![...a.dayset].some((d) => b.dayset.has(d))) continue;
      if (a.start < b.end && b.start < a.end) {
        conflicts.set(a.id, [...(conflicts.get(a.id) ?? []), b.label]);
      }
    }
  }
  return conflicts;
}
