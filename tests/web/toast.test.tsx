// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Toast, type ToastMessage } from '../../src/web/Toast';
import { DialogStackProvider } from '../../src/web/Dialog';

const styles = readFileSync(resolve(process.cwd(), 'src/web/styles.css'), 'utf8');

function renderToast(tone: ToastMessage['tone']) {
  render(
    <DialogStackProvider>
      <Toast
        toast={{ id: 1, title: 'הוספת פריט חדש', message: 'הודעת בדיקה', tone }}
        onDismiss={() => undefined}
      />
    </DialogStackProvider>,
  );
  return document.body.innerHTML;
}

afterEach(() => cleanup());

describe('Toast', () => {
  it.each([
    ['success', 'toast-success', 'role="status"', 'הצלחה'],
    ['warning', 'toast-warning', 'role="alert"', 'אזהרה'],
    ['error', 'toast-error', 'role="alert"', 'שגיאה'],
  ] as const)(
    'renders %s feedback with distinct semantics',
    (tone, className, role, accessibleTone) => {
      const markup = renderToast(tone);

      expect(markup).toContain(className);
      expect(markup).toContain(role);
      expect(markup).toContain('הוספת פריט חדש');
      expect(markup).toContain(`aria-label="${accessibleTone}: הוספת פריט חדש. הודעת בדיקה"`);
      expect(markup).toContain('text-ctp-text');
      expect(markup).toContain('הודעת בדיקה');
      expect(markup).toContain('aria-label="סגירת הודעה"');
      expect(markup).toContain('type="button"');
      expect(markup).toContain('toast-dismiss');
    },
  );

  it('lets pointer input pass through the toast body while keeping dismissal interactive', () => {
    expect(styles).toMatch(/\.toast\s*{[^}]*\bpointer-events-none\b/);
    expect(styles).toMatch(/\.toast-dismiss:not\(:disabled\)\s*{[^}]*pointer-events:\s*auto/);
    expect(styles).toMatch(/\.toast-modal-open \.toast-dismiss\s*{[^}]*pointer-events:\s*none/);
  });

  it('anchors the viewport at the bottom and uses symmetric vertical motion', () => {
    expect(styles).toMatch(/\.toast-viewport\s*{[^}]*\bbottom-4\b/);
    expect(styles).not.toMatch(/\.toast-viewport\s*{[^}]*\btop-4\b/);
    expect(styles).toMatch(/\.toast-exiting\s*{[^}]*animation: toast-exit 160ms ease-in forwards/);
    expect(styles).toMatch(
      /@keyframes toast-enter\s*{\s*from\s*{\s*opacity: 0;\s*transform: translateY\(0\.5rem\) scale\(0\.98\);/,
    );
    expect(styles).toMatch(
      /@keyframes toast-exit\s*{[\s\S]*?to\s*{\s*opacity: 0;\s*transform: translateY\(0\.5rem\) scale\(0\.98\);/,
    );
  });
});
