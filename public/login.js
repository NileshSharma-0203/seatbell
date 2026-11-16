'use strict';

(function () {
  const emailForm = document.getElementById('email-form');
  const codeForm = document.getElementById('code-form');
  const emailInput = document.getElementById('email');
  const codeInput = document.getElementById('code');
  const emailError = document.getElementById('email-error');
  const codeError = document.getElementById('code-error');

  function showError(el, message) {
    el.textContent = message || '';
    el.hidden = !message;
  }

  async function post(path, payload) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Something went wrong. Try again.');
    return data;
  }

  async function withBusy(form, fn) {
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      await fn();
    } finally {
      button.disabled = false;
    }
  }

  emailForm.addEventListener('submit', (event) => {
    event.preventDefault();
    showError(emailError, '');
    withBusy(emailForm, async () => {
      try {
        await post('/api/auth/start', { email: emailInput.value });
        document.getElementById('code-sent').textContent = `We sent a code to ${emailInput.value.trim()}. Check spam if you don't see it in a minute.`;
        emailForm.hidden = true;
        codeForm.hidden = false;
        codeInput.focus();
      } catch (err) {
        showError(emailError, err.message);
      }
    });
  });

  codeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    showError(codeError, '');
    withBusy(codeForm, async () => {
      try {
        await post('/api/auth/verify', {
          email: emailInput.value,
          code: codeInput.value,
          ref: emailForm.dataset.ref || undefined,
        });
        window.location.assign('/app');
      } catch (err) {
        showError(codeError, err.message);
        codeInput.select();
      }
    });
  });

  document.getElementById('change-email').addEventListener('click', () => {
    codeForm.hidden = true;
    emailForm.hidden = false;
    codeInput.value = '';
    showError(codeError, '');
    emailInput.focus();
  });
})();
