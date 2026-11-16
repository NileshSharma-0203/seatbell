type Labels = Record<string, string>;

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
    .join(',');
}

export class Counter {
  readonly name: string;
  readonly help: string;
  private values = new Map<string, number>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) lines.push(`${this.name}${k ? `{${k}}` : ''} ${v}`);
    return lines.join('\n');
  }
}

export class Gauge {
  readonly name: string;
  readonly help: string;
  private values = new Map<string, number>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  set(value: number, labels: Labels = {}): void {
    this.values.set(key(labels), value);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [k, v] of this.values) lines.push(`${this.name}${k ? `{${k}}` : ''} ${v}`);
    return lines.join('\n');
  }
}

export class Histogram {
  readonly name: string;
  readonly help: string;
  private readonly buckets: number[];
  private series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();

  constructor(name: string, help: string, buckets: number[]) {
    this.name = name;
    this.help = help;
    this.buckets = buckets;
  }

  observe(value: number, labels: Labels = {}): void {
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    this.buckets.forEach((b, i) => {
      if (value <= b) s.counts[i] = (s.counts[i] ?? 0) + 1;
    });
    s.sum += value;
    s.count += 1;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      this.buckets.forEach((b, i) => {
        lines.push(`${this.name}_bucket{${key({ ...s.labels, le: String(b) })}} ${s.counts[i]}`);
      });
      lines.push(`${this.name}_bucket{${key({ ...s.labels, le: '+Inf' })}} ${s.count}`);
      const k = key(s.labels);
      lines.push(`${this.name}_sum${k ? `{${k}}` : ''} ${s.sum}`);
      lines.push(`${this.name}_count${k ? `{${k}}` : ''} ${s.count}`);
    }
    return lines.join('\n');
  }
}

export const metrics = {
  httpRequests: new Counter('seatbell_http_requests_total', 'HTTP requests by route and status'),
  httpDuration: new Histogram('seatbell_http_request_seconds', 'HTTP request duration', [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]),
  polls: new Counter('seatbell_polls_total', 'Upstream seat checks by outcome'),
  pollDuration: new Histogram('seatbell_poll_seconds', 'Upstream seat check duration', [0.1, 0.25, 0.5, 1, 2, 5, 10]),
  openings: new Counter('seatbell_seat_openings_total', 'Closed-to-open transitions detected'),
  notifications: new Counter('seatbell_notifications_total', 'Notification attempts by channel and outcome'),
  alertLatency: new Histogram('seatbell_alert_latency_seconds', 'Seconds from detection to accepted delivery', [1, 2, 5, 10, 30, 60, 120, 300]),
  jobs: new Counter('seatbell_jobs_total', 'Jobs finished by kind and outcome'),
  queueDepth: new Gauge('seatbell_queue_depth', 'Jobs by status and kind'),
  queueOldest: new Gauge('seatbell_queue_oldest_seconds', 'Age of the oldest runnable job'),
  activeWatches: new Gauge('seatbell_active_watches', 'Active watches'),
  trackedCourses: new Gauge('seatbell_tracked_courses', 'Courses with at least one active watch'),
  lastPollSuccess: new Gauge('seatbell_last_poll_success_timestamp', 'Unix time of the last successful seat check'),
  breakerOpen: new Gauge('seatbell_breaker_open', '1 while upstream polling is paused'),
};

export function renderMetrics(): string {
  return `${Object.values(metrics).map((m) => m.render()).join('\n')}\n`;
}
