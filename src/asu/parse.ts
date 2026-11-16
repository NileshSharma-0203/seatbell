export interface SectionSnapshot {
  classNbr: string;
  title: string | null;
  instructors: string | null;
  days: string | null;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  sessionCode: string | null;
  enrolled: number;
  capacity: number;
  openSeats: number;
}

/** The upstream response did not look the way we expect. Never treated as "no seats". */
export class ContractError extends Error {}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function firstOf(sources: Obj[], names: string[]): unknown {
  for (const source of sources) {
    for (const name of names) {
      const value = source[name];
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return undefined;
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function toText(value: unknown): string | null {
  if (Array.isArray(value)) {
    const parts = value.map(toText).filter((v): v is string => Boolean(v));
    return parts.length ? [...new Set(parts)].join(', ') : null;
  }
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  return null;
}

function parseRecord(record: unknown): SectionSnapshot | null {
  if (!isObj(record)) return null;
  const clas = isObj(record.CLAS) ? record.CLAS : {};
  const seat = isObj(record.seatInfo) ? record.seatInfo : {};
  const sources = [clas, record];

  const classNbr = toText(firstOf(sources, ['CLASSNBR', 'classNbr', 'classNumber']));
  const capacity = toInt(firstOf([seat, ...sources], ['ENRL_CAP', 'ENRLCAP', 'enrollmentCapacity']));
  const enrolled = toInt(firstOf([seat, ...sources], ['ENRL_TOT', 'ENRLTOT', 'enrollmentTotal']));
  if (!classNbr || capacity === null || enrolled === null) return null;

  return {
    classNbr,
    title: toText(firstOf(sources, ['TITLE', 'COURSETITLELONG', 'DESCR', 'title'])),
    instructors: toText(firstOf(sources, ['INSTRUCTORSLIST', 'instructors'])),
    days: toText(firstOf(sources, ['DAYLIST', 'DAYS', 'days'])),
    startTime: toText(firstOf(sources, ['STARTTIME', 'STARTDATETIME', 'startTime'])),
    endTime: toText(firstOf(sources, ['ENDTIME', 'ENDDATETIME', 'endTime'])),
    location: toText(firstOf(sources, ['LOCATIONBUILDING', 'LOCATION', 'CAMPUS', 'location'])),
    sessionCode: toText(firstOf(sources, ['SESSIONCODE', 'sessionCode'])),
    enrolled,
    capacity,
    openSeats: Math.max(capacity - enrolled, 0),
  };
}

/**
 * Normalizes a class search response. All-or-nothing: if any record is
 * unreadable the snapshot is rejected, because a partial read could look like
 * a section that closed and reopened and send false alerts.
 */
export function parseClassSearch(body: unknown): SectionSnapshot[] {
  if (!isObj(body) || !Array.isArray(body.classes)) {
    throw new ContractError('response has no classes array');
  }
  const sections = new Map<string, SectionSnapshot>();
  for (const record of body.classes) {
    const parsed = parseRecord(record);
    if (!parsed) {
      const keys = isObj(record) ? Object.keys(record).slice(0, 12).join(',') : typeof record;
      throw new ContractError(`unreadable class record (keys: ${keys})`);
    }
    sections.set(parsed.classNbr, parsed);
  }
  return [...sections.values()];
}
