'use strict';

(function () {
  const form = document.getElementById('feedback-form');
  const error = document.getElementById('feedback-error');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    const contact = document.getElementById('contact');
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: document.getElementById('kind').value,
          message: document.getElementById('message').value,
          contact: contact ? contact.value : undefined,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'The message could not be sent. Try again.');
      form.hidden = true;
      document.getElementById('feedback-done').hidden = false;
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
})();
