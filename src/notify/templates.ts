import type { Config } from '../config.ts';
import { esc } from '../web/html.ts';
import type { EmailMessage, PushMessage } from './send.ts';

export const MY_ASU_URL = 'https://my.asu.edu';

export interface AlertInfo {
  subject: string;
  catalogNbr: string;
  title: string | null;
  classNbr: string;
  openSeats: number;
  termLabel: string;
  days: string | null;
  startTime: string | null;
  instructors: string | null;
  anySection: boolean;
  unsubscribeUrl: string;
}

const seats = (n: number): string => (n === 1 ? '1 seat' : `${n} seats`);

function shell(config: Config, inner: string, footer: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#eef0ff;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#15163d">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;padding:28px">
<div style="font-weight:800;font-size:17px;color:#2b2bd4;margin-bottom:18px">${esc(config.appName)}</div>
${inner}
<p style="font-size:12px;line-height:1.5;color:#5b5d85;margin:26px 0 0">${footer}</p>
</div></body></html>`;
}

export function alertEmail(config: Config, a: AlertInfo): Omit<EmailMessage, 'to'> {
  const course = `${a.subject} ${a.catalogNbr}`;
  const when = [a.days, a.startTime].filter(Boolean).join(' at ');
  const details = [when, a.instructors].filter(Boolean).join(', ');
  const anyNote = a.anySection ? 'You are watching every section of this course, so other sections may have opened too. ' : '';
  const disclaimer = `Some open seats are reserved for specific majors or groups, so My ASU has the final say. ${config.appName} is an independent student project, not affiliated with Arizona State University.`;

  return {
    subject: `Seat open: ${course} (class ${a.classNbr})`,
    text: [
      `${course}${a.title ? `: ${a.title}` : ''} has ${seats(a.openSeats)} open as of this check.`,
      `Class number: ${a.classNbr}`,
      `Term: ${a.termLabel}`,
      details,
      '',
      `Register in My ASU: ${MY_ASU_URL}`,
      '',
      `${anyNote}${disclaimer}`,
      `Stop this alert: ${a.unsubscribeUrl}`,
    ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n'),
    html: shell(config, `
<h1 style="font-size:24px;line-height:1.25;margin:0 0 6px">${esc(course)} has ${esc(seats(a.openSeats))} open</h1>
<p style="margin:0 0 18px;font-size:15px;color:#3c3e6b">${esc(a.title ?? '')}</p>
<p style="margin:0 0 4px;font-size:15px">Class number <strong style="font-size:20px">${esc(a.classNbr)}</strong></p>
<p style="margin:0 0 20px;font-size:14px;color:#3c3e6b">${esc([a.termLabel, details].filter(Boolean).join('. '))}</p>
<a href="${MY_ASU_URL}" style="display:inline-block;background:#2b2bd4;color:#fff;font-weight:700;text-decoration:none;padding:13px 20px;border-radius:9px">Register in My ASU</a>`,
      `${esc(anyNote)}${esc(disclaimer)}<br><br><a href="${esc(a.unsubscribeUrl)}" style="color:#5b5d85">Stop this alert</a>`),
    headers: {
      'List-Unsubscribe': `<${a.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

export function alertPush(a: AlertInfo, tag: string): PushMessage {
  return {
    title: `${a.subject} ${a.catalogNbr}: ${seats(a.openSeats)} open`,
    body: `Class ${a.classNbr}. Tap to open My ASU.`,
    url: MY_ASU_URL,
    tag,
  };
}

export function loginEmail(config: Config, code: string): Omit<EmailMessage, 'to'> {
  return {
    subject: `${code} is your ${config.appName} code`,
    text: `Your ${config.appName} sign-in code is ${code}. It expires in 10 minutes.\n\nIf you didn't request it, you can ignore this email.`,
    html: shell(config, `
<p style="margin:0 0 10px;font-size:15px">Your sign-in code:</p>
<p style="margin:0 0 14px;font-size:36px;font-weight:800;letter-spacing:6px">${esc(code)}</p>
<p style="margin:0;font-size:14px;color:#3c3e6b">It expires in 10 minutes.</p>`,
      `If you didn't request this code, you can ignore this email.`),
  };
}

export function testEmail(config: Config): Omit<EmailMessage, 'to'> {
  return {
    subject: `Test alert from ${config.appName}`,
    text: `Alerts are reaching this inbox. Real alerts have the subject "Seat open: ...". Add this address to your contacts so they aren't filtered.`,
    html: shell(config, `
<h1 style="font-size:22px;margin:0 0 10px">Alerts are reaching this inbox</h1>
<p style="margin:0;font-size:15px;line-height:1.5">Real alerts have the subject “Seat open: …”. Add this address to your contacts so they aren’t filtered.</p>`, ''),
  };
}
