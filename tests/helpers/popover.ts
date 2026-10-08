// jsdom has no top layer. Browser tests cover positioning, light dismissal and focus.
import { beforeAll } from 'vitest';

beforeAll(() => {
  const style = document.createElement('style');
  style.textContent = '[popover]:not([data-test-popover-open]) { display: none; }';
  document.head.append(style);
  function toggle(element: HTMLElement, newState: 'open' | 'closed') {
    element.dispatchEvent(Object.assign(new Event('beforetoggle'), { newState }));
    element.toggleAttribute('data-test-popover-open', newState === 'open');
  }
  HTMLElement.prototype.showPopover = function () {
    for (const element of document.querySelectorAll<HTMLElement>('[data-test-popover-open]')) {
      if (element !== this) toggle(element, 'closed');
    }
    toggle(this, 'open');
  };
  HTMLElement.prototype.hidePopover = function () {
    if (this.hasAttribute('data-test-popover-open')) toggle(this, 'closed');
  };
});
