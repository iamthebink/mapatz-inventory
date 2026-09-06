import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Toast, type ToastMessage } from '../../src/web/Toast';

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
});
