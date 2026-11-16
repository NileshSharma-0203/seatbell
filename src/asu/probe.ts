// One-shot contract check. Makes exactly one request:
//   npm run probe -- CSE 310 2271
import { writeFile } from 'node:fs/promises';
import { loadConfig } from '../config.ts';
import { classSearchUrl } from './client.ts';
import { parseClassSearch } from './parse.ts';

const [subject = 'CSE', catalogNbr = '310', term = '2271'] = process.argv.slice(2);
const config = loadConfig({ ...process.env, NODE_ENV: 'development' });
const url = classSearchUrl(config.asu.baseUrl, { term, subject: subject.toUpperCase(), catalogNbr });
const headers: Record<string, string> = { accept: 'application/json' };
if (config.asu.authorization) headers.authorization = config.asu.authorization;

console.log(`GET ${url}`);
const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
console.log(`HTTP ${response.status}`);
const text = await response.text();
if (!response.ok) {
  console.error(text.slice(0, 500));
  console.error('\nThe endpoint refused this request. See docs/DEPLOY.md step 1 before going further.');
  process.exit(1);
}

await writeFile('test/fixtures/live-sample.json', text);
console.log('Saved the raw response to test/fixtures/live-sample.json');

const body = JSON.parse(text) as { classes?: Array<Record<string, unknown>> };
const first = body.classes?.[0];
if (first) {
  console.log('\nTop-level record keys:', Object.keys(first).join(', '));
  for (const [name, value] of Object.entries(first)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      console.log(`Keys in ${name}:`, Object.keys(value).join(', '));
    }
  }
}

const sections = parseClassSearch(body);
console.log(`\nParsed ${sections.length} sections:`);
console.table(sections.map((s) => ({
  class: s.classNbr,
  seats: `${s.openSeats} open (${s.enrolled}/${s.capacity})`,
  days: s.days,
  start: s.startTime,
  end: s.endTime,
  instructors: s.instructors,
  location: s.location,
})));
console.log('\nCompare these numbers with the same course on the public class search page.');
