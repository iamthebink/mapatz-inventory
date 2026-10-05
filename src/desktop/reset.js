/* global document, window */
const phrase = document.querySelector('#phrase');
const confirm = document.querySelector('#confirm');
const cancel = document.querySelector('#cancel');
let pending = false;
phrase.addEventListener('input', () => {
  confirm.disabled = pending || phrase.value !== 'איפוס מערכת';
});
cancel.addEventListener('click', () => window.mapatzDesktop.cancelReset());
document.querySelector('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (pending || phrase.value !== 'איפוס מערכת') return;
  pending = true;
  confirm.disabled = true;
  cancel.disabled = true;
  phrase.disabled = true;
  document.querySelector('[role=status]').textContent = 'האיפוס מתבצע…';
  await window.mapatzDesktop.confirmReset(phrase.value);
});
