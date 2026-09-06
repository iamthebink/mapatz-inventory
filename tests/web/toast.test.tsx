import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Toast, type ToastMessage } from '../../src/web/Toast';

const styles = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');

function renderToast(tone: ToastMessage['tone']) {
  return renderToStaticMarkup(
    <Toast toast={{ id: 1, message: 'הודעת בדיקה', tone }} onDismiss={() => undefined} />,
  );
}

describe('Toast', () => {
  it.each([
    ['success', 'toast-success', 'role="status"', 'הצלחה'],
    ['warning', 'toast-warning', 'role="alert"', 'אזהרה'],
    ['error', 'toast-error', 'role="alert"', 'שגיאה'],
  ] as const)('renders %s feedback with distinct semantics', (tone, className, role, label) => {
    const markup = renderToast(tone);

    expect(markup).toContain(className);
    expect(markup).toContain(role);
    expect(markup).toContain(label);
    expect(markup).toContain('text-ctp-text');
    expect(markup).toContain('הודעת בדיקה');
    expect(markup).toContain('aria-label="סגירת הודעה"');
    expect(markup).toContain('type="button"');
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
