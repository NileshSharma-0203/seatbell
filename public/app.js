'use strict';

(function () {
  const root = document.getElementById('app');
  const $ = (id) => document.getElementById(id);

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (value !== false && value !== null && value !== undefined) el.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child !== null && child !== undefined && child !== false) el.append(child);
    }
    return el;
  }

  async function api(path, options = {}) {
    const init = { method: options.method || 'GET', headers: {} };
    if (options.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(path, init);
    if (response.status === 401) {
      window.location.assign('/login');
      throw new Error('Sign in to continue.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Something went wrong. Try again.');
    return data;
  }

  function setError(el, message) {
    el.textContent = message || '';
    el.hidden = !message;
  }

  const seats = (n) => (n === 1 ? '1 seat open' : `${n} seats open`);
  const meetingText = (s) => [s.days, s.start_time && s.end_time ? `${s.start_time} to ${s.end_time}` : s.start_time].filter(Boolean).join(', ');

  function ago(iso) {
    if (!iso) return 'not checked yet';
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (seconds < 90) return `checked ${seconds} seconds ago`;
    if (seconds < 5400) return `checked ${Math.round(seconds / 60)} minutes ago`;
    return `checked ${Math.round(seconds / 3600)} hours ago`;
  }

  // Finding a class -----------------------------------------------------------
  const results = $('results');
  const lookupError = $('lookup-error');
  let lookupRun = 0;

  async function addWatch(courseId, sectionId, button) {
    button.disabled = true;
    setError(lookupError, '');
    try {
      await api('/api/watches', { method: 'POST', body: { courseId, sectionId } });
      button.textContent = 'Alert added';
      await loadWatches();
    } catch (err) {
      button.disabled = false;
      setError(lookupError, err.message);
    }
  }

  function renderCourse(course) {
    results.replaceChildren();
    if (course.sections.length === 0) {
      results.append(h('p', { class: 'note' }, course.unavailable
        ? 'Class data is unavailable right now. Try again in a few minutes.'
        : `No sections of ${course.subject} ${course.catalogNbr} were found for this term. Check the course number.`));
      return;
    }
    const anyButton = h('button', { class: 'btn btn-blue', type: 'button', onclick: (e) => addWatch(course.id, null, e.currentTarget) }, 'Alert me for any section');
    results.append(
      h('div', { class: 'result-head' },
        h('div', {},
          h('h2', {}, `${course.subject} ${course.catalogNbr}`),
          course.title ? h('p', {}, course.title) : null),
        anyButton),
      h('ul', { class: 'sections' }, course.sections.map((s) => h('li', { class: s.open_seats > 0 ? 'has-seats' : '' },
        h('div', { class: 'section-seats' }, h('strong', {}, s.open_seats > 0 ? seats(s.open_seats) : 'Full'), h('span', {}, `${s.enrolled} of ${s.capacity} taken`)),
        h('div', { class: 'section-info' },
          h('strong', {}, `Class ${s.class_nbr}`),
          h('span', {}, [meetingText(s), s.instructors, s.location].filter(Boolean).join('. ') || 'Meeting details unavailable')),
        h('button', { class: 'btn btn-outline', type: 'button', onclick: (e) => addWatch(course.id, s.id, e.currentTarget) }, 'Alert me')))),
    );
    if (course.sections.some((s) => s.open_seats > 0)) {
      results.append(h('p', { class: 'note' }, 'Sections with open seats only alert you after they fill and reopen. Register now if you can.'));
    }
  }

  $('lookup').addEventListener('submit', async (event) => {
    event.preventDefault();
    const run = ++lookupRun;
    setError(lookupError, '');
    results.replaceChildren(h('p', { class: 'note' }, 'Looking up sections…'));
    const button = event.target.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const { courseId } = await api('/api/lookup', { method: 'POST', body: { term: $('term').value, course: $('course').value } });
      const deadline = Date.now() + 30000;
      for (;;) {
        const course = await api(`/api/courses/${courseId}`);
        if (run !== lookupRun) return;
        if (!course.pending) {
          renderCourse(course);
          break;
        }
        if (Date.now() > deadline) {
          results.replaceChildren(h('p', { class: 'note' }, 'That took too long. Lots of people are searching, so try again in a minute.'));
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    } catch (err) {
      results.replaceChildren();
      setError(lookupError, err.message);
    } finally {
      button.disabled = false;
    }
  });

  // Your alerts ---------------------------------------------------------------
  async function loadWatches() {
    const container = $('watches');
    let watches;
    try {
      ({ watches } = await api('/api/watches'));
    } catch (err) {
      container.replaceChildren(h('p', { class: 'form-error' }, err.message));
      return;
    }
    if (watches.length === 0) {
      container.replaceChildren(h('p', { class: 'note' }, 'No alerts yet. Search for a class above and choose a section.'));
      return;
    }
    container.replaceChildren(h('ul', { class: 'watches' }, watches.map((w) => {
      const scope = w.section_id ? `Class ${w.class_nbr}` : `Any of ${w.section_count} sections`;
      const detail = w.section_id ? [meetingText(w), w.instructors].filter(Boolean).join('. ') : w.course_title;
      return h('li', { class: w.open_seats > 0 ? 'has-seats' : '' },
        h('div', { class: 'section-seats' }, h('strong', {}, w.open_seats > 0 ? seats(w.open_seats) : 'Full'), h('span', {}, ago(w.last_success_at))),
        h('div', { class: 'section-info' },
          h('strong', {}, `${w.subject} ${w.catalog_nbr}`),
          h('span', {}, `${scope}, ${w.term_label}`),
          detail ? h('span', {}, detail) : null,
          w.conflicts.length ? h('span', { class: 'conflict' }, `Overlaps with ${w.conflicts.join(', ')}`) : null),
        h('button', {
          class: 'btn-link',
          type: 'button',
          'aria-label': `Stop alert for ${w.subject} ${w.catalog_nbr}`,
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            await api(`/api/watches/${w.id}`, { method: 'DELETE' });
            loadWatches();
          },
        }, 'Stop alert'));
    })));
  }

  // Delivery settings ---------------------------------------------------------
  const pushButton = $('push-toggle');
  const pushStatus = $('push-status');
  const vapidKey = root.dataset.vapid;
  let currentSubscription = null;

  function urlBase64ToUint8Array(value) {
    const padded = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  }

  function renderPush() {
    pushButton.textContent = currentSubscription ? 'Turn off push' : 'Turn on push';
    if (currentSubscription) pushStatus.textContent = 'Push is on for this device.';
  }

  async function initPush() {
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (!vapidKey || !supported) {
      pushButton.disabled = true;
      const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      pushStatus.textContent = !vapidKey
        ? 'Push alerts are not set up yet. Email alerts still work.'
        : iOS
          ? 'On iPhone, tap Share, then Add to Home Screen, then open this page from your home screen to turn on push.'
          : "This browser doesn't support push alerts. Email alerts still work.";
      return;
    }
    const registration = await navigator.serviceWorker.register('/sw.js');
    currentSubscription = await registration.pushManager.getSubscription();
    if (currentSubscription) {
      // Keeps the server copy in step if the browser rotated the subscription.
      await api('/api/push/subscribe', { method: 'POST', body: currentSubscription.toJSON() }).catch(() => undefined);
    }
    renderPush();
    pushButton.addEventListener('click', async () => {
      pushButton.disabled = true;
      try {
        if (currentSubscription) {
          await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: currentSubscription.endpoint } });
          await currentSubscription.unsubscribe();
          currentSubscription = null;
          pushStatus.textContent = 'Push is off for this device.';
        } else {
          const permission = await Notification.requestPermission();
          if (permission !== 'granted') {
            pushStatus.textContent = 'Notifications are blocked. Allow them in your browser settings, then try again.';
            return;
          }
          const ready = await navigator.serviceWorker.ready;
          currentSubscription = await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey) });
          await api('/api/push/subscribe', { method: 'POST', body: currentSubscription.toJSON() });
        }
        renderPush();
      } catch (err) {
        pushStatus.textContent = err.message;
      } finally {
        pushButton.disabled = false;
      }
    });
  }

  async function loadMe() {
    const me = await api('/api/me');
    $('email-address').textContent = me.email;
    const toggle = $('email-toggle');
    toggle.checked = me.emailEnabled;
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      try {
        await api('/api/settings', { method: 'POST', body: { emailEnabled: toggle.checked } });
      } catch (err) {
        toggle.checked = !toggle.checked;
        $('email-address').textContent = err.message;
      } finally {
        toggle.disabled = false;
      }
    });
  }

  $('test-alert').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const status = $('test-status');
    button.disabled = true;
    try {
      await api('/api/test-alert', { method: 'POST', body: {} });
      status.textContent = 'Test alert sent. It should arrive within a minute. Check spam if it doesn’t.';
    } catch (err) {
      status.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });

  $('sign-out').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} });
    window.location.assign('/');
  });

  $('delete-account').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (button.dataset.armed !== 'yes') {
      button.dataset.armed = 'yes';
      button.textContent = 'Click again to permanently delete your account';
      return;
    }
    await api('/api/account/delete', { method: 'POST', body: {} });
    window.location.assign('/');
  });

  loadMe().catch(() => undefined);
  loadWatches();
  initPush().catch((err) => {
    pushButton.disabled = true;
    pushStatus.textContent = err.message;
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') loadWatches();
  }, 60000);
})();
