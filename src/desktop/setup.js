/* global document, window */
document.querySelector('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = document.querySelector('#password').value;
  const confirmation = document.querySelector('#confirmation').value;
  const status = document.querySelector('[role=alert]');
  if (password !== confirmation) {
    status.textContent = 'הסיסמאות אינן תואמות';
    return;
  }
  try {
    await window.mapatzDesktop.setup(password);
  } catch {
    status.textContent = 'לא ניתן לשמור. בדקו שהסיסמה מכילה 8–256 תווים.';
  }
});

// Do not accept form submission until the IPC handler is installed.
document.querySelector('button').disabled = false;
