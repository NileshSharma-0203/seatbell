import type { Config } from '../config.ts';
import { ContractError, parseClassSearch } from './parse.ts';
import type { SectionSnapshot } from './parse.ts';

export interface CourseKey {
  term: string;
  subject: string;
  catalogNbr: string;
}

export class UpstreamError extends Error {
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(message: string, status: number | null, retryAfterMs: number | null = null) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export type SeatSource = (key: CourseKey) => Promise<SectionSnapshot[]>;

export function classSearchUrl(baseUrl: string, key: CourseKey): string {
  const query = new URLSearchParams({
    refine: 'Y',
    subject: key.subject,
    catalogNbr: key.catalogNbr,
    term: key.term,
  });
  return `${baseUrl}/search/classes?${query}`;
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const when = Date.parse(header);
  return Number.isNaN(when) ? null : Math.max(when - Date.now(), 0);
}

export function createSeatSource(config: Config): SeatSource {
  return async (key) => {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': `${config.appName}/1.0 (+${config.baseUrl}/about; ${config.contactEmail})`,
    };
    if (config.asu.authorization) headers.authorization = config.asu.authorization;

    let response: Response;
    try {
      response = await fetch(classSearchUrl(config.asu.baseUrl, key), {
        headers,
        signal: AbortSignal.timeout(config.asu.timeoutMs),
      });
    } catch (err) {
      throw new UpstreamError(`network error: ${(err as Error).message}`, null);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new UpstreamError(`upstream returned ${response.status}`, response.status, parseRetryAfter(response.headers.get('retry-after')));
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ContractError('response was not JSON');
    }
    return parseClassSearch(body);
  };
}
