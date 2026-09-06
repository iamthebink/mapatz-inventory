import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';

const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function canReceiveFocus(element: HTMLElement | null | undefined): element is HTMLElement {
  if (!element?.isConnected) return false;
  if (element.matches(':disabled, [aria-disabled="true"]')) return false;
  return !element.closest('fieldset:disabled, [hidden], [inert]');
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter(canReceiveFocus);
}

function focusElement(element: HTMLElement, selectContents = false) {
  element.focus();
  if (
    selectContents &&
    element instanceof HTMLInputElement &&
    ['text', 'number'].includes(element.type)
  ) {
    try {
      element.select();
    } catch {
      // Some browsers expose select() on number inputs without supporting selection.
    }
    if (element.type === 'number') element.dataset.dialogReplaceOnType = 'true';
  }
}

export function Dialog({
  title,
  description,
  pending,
  onClose,
  children,
  initialFocusRef,
  returnFocusRef,
  returnFocusFallbackRef,
  destructive = false,
  showClose = true,
}: {
  title: string;
  description?: string;
  pending: boolean;
  onClose: () => void;
  children: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  returnFocusFallbackRef?: RefObject<HTMLElement | null>;
  destructive?: boolean;
  showClose?: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(pending);
  const previousPendingRef = useRef(pending);
  const pendingFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  pendingRef.current = pending;
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    // Capture the initiating element exactly once. Mutations may remove it before
    // the dialog unmounts, in which case callers provide an explicit stable fallback.
    const returnFocus = returnFocusRef?.current ?? (document.activeElement as HTMLElement | null);
    const fallbackFocus = returnFocusFallbackRef?.current;
    const explicitBackgrounds = [
      ...document.querySelectorAll<HTMLElement>('[data-dialog-background]'),
    ];
    const backdrop = dialog.parentElement;
    const backgrounds = explicitBackgrounds.length
      ? explicitBackgrounds
      : [...(backdrop?.parentElement?.children ?? [])].filter(
          (element): element is HTMLElement =>
            element instanceof HTMLElement && element !== backdrop,
        );
    const backgroundState = backgrounds.map((background) => ({
      background,
      ariaHidden: background.getAttribute('aria-hidden'),
      inert: background.inert ?? false,
    }));
    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = 'hidden';
    for (const background of backgrounds) {
      background.inert = true;
      background.setAttribute('aria-hidden', 'true');
    }

    const focusInitial = () => {
      const initial = initialFocusRef?.current;
      focusElement(
        canReceiveFocus(initial) ? initial : (focusableElements(dialog)[0] ?? dialog),
        true,
      );
    };
    focusInitial();
    // File inputs may restore focus after their change event finishes. Reassert
    // the modal's safe initial target once that browser interaction has settled.
    const initialFocusTimer = window.setTimeout(focusInitial, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement &&
        target.type === 'number' &&
        target.dataset.dialogReplaceOnType &&
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        target.value = '';
        delete target.dataset.dialogReplaceOnType;
      }
      if (event.key === 'Escape') {
        if (event.defaultPrevented || event.isComposing) return;
        event.preventDefault();
        if (!pendingRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = focusableElements(dialog);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      if (document.activeElement === dialog) {
        event.preventDefault();
        focusElement(event.shiftKey ? last : first);
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        focusElement(event.shiftKey ? last : first);
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        focusElement(last);
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        focusElement(first);
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement) delete target.dataset.dialogReplaceOnType;
    };

    const handleFocusOut = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement) delete target.dataset.dialogReplaceOnType;
    };

    document.addEventListener('keydown', handleKeyDown);
    dialog.addEventListener('pointerdown', handlePointerDown);
    dialog.addEventListener('focusout', handleFocusOut);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      dialog.removeEventListener('pointerdown', handlePointerDown);
      dialog.removeEventListener('focusout', handleFocusOut);
      window.clearTimeout(initialFocusTimer);
      document.body.style.overflow = previousOverflow;
      for (const { background, ariaHidden, inert } of backgroundState) {
        background.inert = inert;
        if (ariaHidden == null) background.removeAttribute('aria-hidden');
        else background.setAttribute('aria-hidden', ariaHidden);
      }
      const target = canReceiveFocus(returnFocus) ? returnFocus : fallbackFocus;
      if (canReceiveFocus(target)) target.focus();
    };
    // Modal lifetime must not restart when callbacks or pending state rerender.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const wasPending = previousPendingRef.current;
    previousPendingRef.current = pending;
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!wasPending && pending) {
      const focused = document.activeElement as HTMLElement | null;
      pendingFocusRef.current = focused && dialog.contains(focused) ? focused : null;
      focusElement(dialog);
    } else if (wasPending && !pending) {
      const target = pendingFocusRef.current;
      pendingFocusRef.current = null;
      if (canReceiveFocus(target)) focusElement(target);
      else focusElement(focusableElements(dialog)[0] ?? dialog);
    }
  }, [pending]);

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (!pending && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`dialog ${destructive ? 'dialog-destructive' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={pending || undefined}
        tabIndex={-1}
      >
        {showClose && (
          <button
            type="button"
            className="icon-button dialog-close"
            onClick={onClose}
            disabled={pending}
            aria-label="סגירה"
          >
            <X className="size-5" />
          </button>
        )}
        <h2 id={titleId} className="dialog-title">
          {title}
        </h2>
        {description && (
          <p id={descriptionId} className="dialog-description">
            {description}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}
