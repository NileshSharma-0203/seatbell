import type { Config } from '../config.ts';
import { esc } from './html.ts';

interface PageOptions {
  title: string;
  description?: string;
  body: string;
  bodyClass?: string;
  scripts?: string[];
  signedIn?: boolean;
  bare?: boolean;
}

export function layout(config: Config, o: PageOptions): string {
  const title = o.title === config.appName ? config.appName : `${o.title} | ${config.appName}`;
  const description = o.description ?? `Get an alert when a seat opens in a full ASU class.`;
  const nav = o.bare ? '' : `
<header class="site-head">
  <a class="wordmark" href="/">${esc(config.appName)}</a>
  <nav aria-label="Main">
    <a href="/status">Status</a>
    <a href="/feedback">Feedback</a>
    <a class="nav-action" href="${o.signedIn ? '/app' : '/login'}">${o.signedIn ? 'Your alerts' : 'Sign in'}</a>
  </nav>
</header>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#2b2bd4">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(config.baseUrl)}">
<meta property="og:image" content="${esc(config.baseUrl)}/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&display=swap">
<link rel="stylesheet" href="/styles.css">
${(o.scripts ?? []).map((s) => `<script src="${esc(s)}" defer></script>`).join('\n')}
</head>
<body class="${esc(o.bodyClass ?? '')}">
<a class="skip" href="#main">Skip to content</a>
${nav}
<main id="main">${o.body}</main>
<footer class="site-foot">
  <p>${esc(config.appName)} is an independent student project. It is not affiliated with or endorsed by Arizona State University.</p>
  <p class="foot-links"><a href="/status">Status</a><a href="/feedback">Feedback</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="mailto:${esc(config.contactEmail)}">Contact</a></p>
</footer>
</body>
</html>`;
}

/** Curved lecture-hall rows. Every seat is taken except one, which is the whole product. */
function seatingChart(): string {
  const rows = 9;
  const cx = 300;
  const cy = -120;
  const seats: string[] = [];
  const openRow = 5;
  for (let r = 0; r < rows; r += 1) {
    const radius = 190 + r * 36;
    const span = 1.02;
    const count = Math.floor((radius * 2 * span) / 25);
    const openIndex = Math.round(count * 0.64);
    for (let i = 0; i <= count; i += 1) {
      const a = -span + (2 * span * i) / count;
      const x = cx + radius * Math.sin(a);
      const y = cy + radius * Math.cos(a);
      if (x < -20 || x > 620) continue;
      const deg = (-a * 180) / Math.PI;
      const isOpen = r === openRow && i === openIndex;
      seats.push(`<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${deg.toFixed(1)})"${isOpen ? ' class="seat-open"' : ''}>${isOpen ? '<circle class="seat-ring" r="12"/>' : ''}<rect x="-9" y="-8" width="18" height="15" rx="4"/><rect x="-9" y="9" width="18" height="4" rx="2"/></g>`);
    }
  }
  return `<svg class="hall" viewBox="0 0 600 340" role="img" aria-label="A lecture hall seating chart with every seat taken except one, which lights up">${seats.join('')}</svg>`;
}

export function landingPage(config: Config, ref: string | null, signedIn: boolean, liveLine: string | null): string {
  const cta = signedIn ? '/app' : `/login${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
  const body = `
<section class="hero">
  <div class="hero-copy">
    <h1>Someone always drops. Be the first to know.</h1>
    <p class="lede">Pick a full ASU class. ${esc(config.appName)} checks it for you and sends an alert to your phone or inbox when a seat opens.</p>
    <p><a class="btn btn-mint" href="${esc(cta)}">${signedIn ? 'Go to your alerts' : 'Set up a free alert'}</a></p>
    ${liveLine ? `<p class="live-line">${esc(liveLine)}</p>` : ''}
  </div>
  <div class="hero-art" aria-hidden="false">
    ${seatingChart()}
    <div class="alert-toast" aria-hidden="true">
      <strong>CSE 310 has 1 seat open</strong>
      <span>Example alert. Class number 12345</span>
    </div>
  </div>
</section>

<section class="steps wrap">
  <h2>How it works</h2>
  <ol>
    <li><h3>Sign in with your ASU email</h3><p>We send a six-digit code. There's no password, and we never ask for your ASU login.</p></li>
    <li><h3>Choose what you'd take</h3><p>Watch one section, or watch every section of a course if any of them works for you.</p></li>
    <li><h3>Move fast when it rings</h3><p>Your alert has the class number. Paste it into My ASU and register before someone else does.</p></li>
  </ol>
</section>

<section class="faq wrap">
  <h2>Before you sign up</h2>
  <dl>
    <dt>Does it register me for the class?</dt>
    <dd>No. It only tells you a seat opened. You register yourself in My ASU, so your account stays yours.</dd>
    <dt>Am I guaranteed the seat?</dt>
    <dd>No. Seats go to whoever registers first, and everyone watching gets the same alert from the same check. Paid tiers and head starts don't exist here.</dd>
    <dt>Why did an alert show a seat I can't take?</dt>
    <dd>Some seats are reserved for certain majors or groups, and prerequisites still apply. My ASU has the final say.</dd>
    <dt>How quickly will I hear about a seat?</dt>
    <dd>Each course is checked on a steady cycle that stays gentle on ASU's systems. The <a href="/status">status page</a> shows when the last check ran.</dd>
    <dt>What does it cost?</dt>
    <dd>Nothing. Tell us what's broken on the <a href="/feedback">feedback page</a> and that's plenty.</dd>
  </dl>
</section>`;
  return layout(config, { title: config.appName, body, bodyClass: 'landing', signedIn });
}

export function loginPage(config: Config, ref: string | null): string {
  const domain = config.allowedEmailDomains[0] ?? 'asu.edu';
  return layout(config, {
    title: 'Sign in',
    scripts: ['/login.js'],
    bodyClass: 'narrow-page',
    body: `
<div class="narrow">
  <h1>Sign in</h1>
  <form id="email-form" data-ref="${esc(ref ?? '')}" novalidate>
    <label for="email">ASU email</label>
    <input id="email" name="email" type="email" autocomplete="email" inputmode="email" required placeholder="sparky@${esc(domain)}">
    <p class="form-error" id="email-error" role="alert" hidden></p>
    <button class="btn btn-blue" type="submit">Email me a code</button>
  </form>
  <form id="code-form" hidden novalidate>
    <p id="code-sent" aria-live="polite"></p>
    <label for="code">Six-digit code</label>
    <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required>
    <p class="form-error" id="code-error" role="alert" hidden></p>
    <button class="btn btn-blue" type="submit">Sign in</button>
    <button class="btn-link" type="button" id="change-email">Use a different email</button>
  </form>
  <p class="small">By signing in you agree to the <a href="/terms">terms</a> and <a href="/privacy">privacy policy</a>. We only use your email to sign you in and send the alerts you ask for.</p>
</div>`,
  });
}

export function appPage(config: Config): string {
  const terms = config.terms.map((t) => `<option value="${esc(t.code)}">${esc(t.label)}</option>`).join('');
  return layout(config, {
    title: 'Your alerts',
    scripts: ['/app.js'],
    signedIn: true,
    bodyClass: 'dash',
    body: `
<div class="wrap dash-wrap" id="app" data-vapid="${esc(config.push.publicKey ?? '')}" data-limit="${config.watchLimit}">
  <section aria-labelledby="add-heading">
    <h1 id="add-heading">Watch a class</h1>
    <form id="lookup" class="lookup" novalidate>
      <div class="field"><label for="term">Term</label><select id="term">${terms}</select></div>
      <div class="field grow"><label for="course">Course</label><input id="course" autocomplete="off" autocapitalize="characters" placeholder="CSE 310" required></div>
      <button class="btn btn-blue" type="submit">Find sections</button>
    </form>
    <p class="form-error" id="lookup-error" role="alert" hidden></p>
    <div id="results" aria-live="polite"></div>
  </section>

  <section aria-labelledby="watch-heading">
    <h2 id="watch-heading">Your alerts</h2>
    <div id="watches"></div>
  </section>

  <section aria-labelledby="delivery-heading">
    <h2 id="delivery-heading">How you get alerts</h2>
    <div class="setting">
      <div><h3>Phone or browser push</h3><p id="push-status">Push is the fastest way to hear about a seat.</p></div>
      <button class="btn btn-outline" id="push-toggle" type="button">Turn on push</button>
    </div>
    <div class="setting">
      <div><h3>Email</h3><p id="email-address"></p></div>
      <label class="switch"><input type="checkbox" id="email-toggle"><span>Send email alerts</span></label>
    </div>
    <div class="setting">
      <div><h3>Check that alerts reach you</h3><p id="test-status">Do this once before you rely on it.</p></div>
      <button class="btn btn-outline" id="test-alert" type="button">Send a test alert</button>
    </div>
  </section>

  <section class="account" aria-label="Account">
    <button class="btn-link" id="sign-out" type="button">Sign out</button>
    <button class="btn-link danger" id="delete-account" type="button">Delete my account</button>
  </section>
</div>`,
  });
}

export interface StatusView {
  state: 'ok' | 'degraded' | 'idle' | 'paused';
  lastCheck: string;
  courses: number;
  watches: number;
  alerts: number;
  checks24h: number;
  failures24h: number;
}

export function statusPage(config: Config, s: StatusView, signedIn: boolean): string {
  const headline = {
    ok: 'Seat checks are running normally.',
    idle: 'Nothing to check yet. No one is watching a class.',
    degraded: 'Seat checks are behind schedule. Alerts may be late.',
    paused: 'Seat checks are paused. Alerts will resume automatically.',
  }[s.state];
  return layout(config, {
    title: 'Status',
    signedIn,
    bodyClass: 'narrow-page',
    body: `
<div class="narrow status status-${esc(s.state)}">
  <h1>${esc(headline)}</h1>
  <dl class="readout">
    <dt>Last successful check</dt><dd>${esc(s.lastCheck)}</dd>
    <dt>Courses being checked</dt><dd>${s.courses}</dd>
    <dt>Active alerts</dt><dd>${s.watches}</dd>
    <dt>Checks in the last 24 hours</dt><dd>${s.checks24h}</dd>
    <dt>Failed checks in the last 24 hours</dt><dd>${s.failures24h}</dd>
    <dt>Alerts sent all time</dt><dd>${s.alerts}</dd>
  </dl>
</div>`,
  });
}

export function feedbackPage(config: Config, signedIn: boolean): string {
  return layout(config, {
    title: 'Feedback',
    scripts: ['/feedback.js'],
    signedIn,
    bodyClass: 'narrow-page',
    body: `
<div class="narrow">
  <h1>Tell us what to fix</h1>
  <p>Missed an alert, got a wrong one, or want something added? A student reads every message.</p>
  <form id="feedback-form" novalidate>
    <label for="kind">What is this about?</label>
    <select id="kind"><option value="bug">Something's broken</option><option value="idea">An idea</option><option value="praise">It worked</option><option value="other">Something else</option></select>
    <label for="message">Your message</label>
    <textarea id="message" rows="6" maxlength="4000" required></textarea>
    ${signedIn ? '' : `<label for="contact">Email, if you'd like a reply</label><input id="contact" type="email" autocomplete="email">`}
    <p class="form-error" id="feedback-error" role="alert" hidden></p>
    <button class="btn btn-blue" type="submit">Send feedback</button>
  </form>
  <p id="feedback-done" hidden role="status"><strong>Feedback sent.</strong> Thanks for helping fix this.</p>
</div>`,
  });
}

export function unsubscribePage(config: Config, token: string, label: string, done: boolean): string {
  return layout(config, {
    title: 'Stop alert',
    bodyClass: 'narrow-page',
    body: `
<div class="narrow">
  ${done
    ? `<h1>Alert stopped</h1><p>You won't get more alerts for ${esc(label)}.</p><p><a href="/app">Manage your alerts</a></p>`
    : `<h1>Stop alerts for ${esc(label)}?</h1>
       <form method="post" action="/u/${esc(token)}"><button class="btn btn-blue" type="submit">Stop this alert</button></form>`}
</div>`,
  });
}

export function legalPage(config: Config, kind: 'privacy' | 'terms'): string {
  const app = esc(config.appName);
  const contact = esc(config.contactEmail);
  const privacy = `
<h1>Privacy</h1>
<p>${app} keeps only what it needs to send the alerts you ask for.</p>
<h2>What we store</h2>
<ul>
<li>Your email address, used to sign you in and send alerts.</li>
<li>The classes you watch and when alerts were sent.</li>
<li>A push subscription for each device where you turn on push.</li>
<li>The days you used the site, so we can count active users.</li>
<li>Anything you send through the feedback form.</li>
</ul>
<h2>What we never ask for</h2>
<p>Your ASU password, student ID, grades, or schedule. We don't sell data or show ads.</p>
<h2>Who processes it</h2>
<p>Resend delivers email. Apple, Google, Mozilla, or Microsoft deliver push messages, depending on your device, and the contents are encrypted so they can't read them. Google Fonts serves the typeface on this site.</p>
<h2>Deleting your data</h2>
<p>Use "Delete my account" on your alerts page. Your email, watches, and devices are removed right away. Only anonymous daily totals remain. Questions go to <a href="mailto:${contact}">${contact}</a>.</p>`;
  const terms = `
<h1>Terms</h1>
<p>${app} is a free student project, offered as is, with no guarantee that it will be available or correct.</p>
<h2>What it does</h2>
<p>It reads publicly available class information and tells you when a seat appears to open. It doesn't register you and can't guarantee a seat. Always confirm in My ASU. You're responsible for your own registration and deadlines.</p>
<h2>Fair use</h2>
<p>Each person gets ${config.watchLimit} active alerts. Don't try to overload or interfere with the service, and don't share alerts in a way that sells access to seats.</p>
<h2>Independence</h2>
<p>${app} is not affiliated with, endorsed by, or operated by Arizona State University. It may stop at any time, including at ASU's request.</p>
<h2>Contact</h2>
<p><a href="mailto:${contact}">${contact}</a></p>`;
  return layout(config, {
    title: kind === 'privacy' ? 'Privacy' : 'Terms',
    bodyClass: 'narrow-page',
    body: `<div class="narrow prose">${kind === 'privacy' ? privacy : terms}</div>`,
  });
}

export function notFoundPage(config: Config): string {
  return layout(config, {
    title: 'Page not found',
    bodyClass: 'narrow-page',
    body: `<div class="narrow"><h1>That page doesn't exist</h1><p><a href="/">Go to the home page</a></p></div>`,
  });
}
