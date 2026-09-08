import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export type DialogLevel = 'root' | 'subordinate';
export type DialogRole = 'dialog' | 'alertdialog';
export type DialogVariant = 'standard' | 'destructive' | 'workspace';

const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[contenteditable="true"]',
  '[tabindex]',
].join(',');

function isVisiblyAvailable(element: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

function canReceiveFocus(element: HTMLElement | null | undefined): element is HTMLElement {
  if (!element?.isConnected) return false;
  if (element.matches(':disabled, [aria-disabled="true"]')) return false;
  if (element.closest('fieldset:disabled, [hidden], [inert]')) return false;
  return isVisiblyAvailable(element);
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
    .filter((element) => canReceiveFocus(element) && element.tabIndex >= 0)
    .map((element, domIndex) => ({ element, domIndex }))
    .sort((left, right) => {
      const leftOrder = left.element.tabIndex > 0 ? left.element.tabIndex : Number.MAX_SAFE_INTEGER;
      const rightOrder =
        right.element.tabIndex > 0 ? right.element.tabIndex : Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.domIndex - right.domIndex;
    })
    .map(({ element }) => element);
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

type ElementSnapshot = {
  element: HTMLElement;
  inertAttribute: string | null;
  ariaHidden: string | null;
};

type InlineStyleValue = { value: string; priority: string };
type BodyOverflowSnapshot = {
  overflow: InlineStyleValue;
  overflowX: InlineStyleValue;
  overflowY: InlineStyleValue;
};

function inlineStyleValue(style: CSSStyleDeclaration, property: string): InlineStyleValue {
  return {
    value: style.getPropertyValue(property),
    priority: style.getPropertyPriority(property),
  };
}

function snapshotBodyOverflow(): BodyOverflowSnapshot {
  const style = document.body.style;
  return {
    overflow: inlineStyleValue(style, 'overflow'),
    overflowX: inlineStyleValue(style, 'overflow-x'),
    overflowY: inlineStyleValue(style, 'overflow-y'),
  };
}

function restoreBodyOverflow(snapshot: BodyOverflowSnapshot) {
  const style = document.body.style;
  style.removeProperty('overflow');
  style.removeProperty('overflow-x');
  style.removeProperty('overflow-y');
  for (const [property, previous] of [
    ['overflow', snapshot.overflow],
    ['overflow-x', snapshot.overflowX],
    ['overflow-y', snapshot.overflowY],
  ] as const) {
    if (previous.value) style.setProperty(property, previous.value, previous.priority);
  }
}

function snapshotElement(element: HTMLElement): ElementSnapshot {
  return {
    element,
    inertAttribute: element.getAttribute('inert'),
    ariaHidden: element.getAttribute('aria-hidden'),
  };
}

function isolate(snapshot: ElementSnapshot) {
  snapshot.element.setAttribute('inert', '');
  snapshot.element.setAttribute('aria-hidden', 'true');
}

function restore(snapshot: ElementSnapshot) {
  if (snapshot.inertAttribute == null) snapshot.element.removeAttribute('inert');
  else snapshot.element.setAttribute('inert', snapshot.inertAttribute);
  if (snapshot.ariaHidden == null) snapshot.element.removeAttribute('aria-hidden');
  else snapshot.element.setAttribute('aria-hidden', snapshot.ariaHidden);
}

type StackEntry = {
  token: symbol;
  level: DialogLevel;
  backdrop: HTMLElement;
  dialog: HTMLElement;
  returnFocus: HTMLElement | null;
  fallbackFocus: HTMLElement | null;
  dismissible: RefObject<boolean>;
  onClose: RefObject<() => void>;
  isolatedParent?: ElementSnapshot;
};

type DialogStackValue = {
  depth: number;
  register: (entry: StackEntry) => void;
  unregister: (token: symbol) => void;
  isRegistered: (token: symbol) => boolean;
  isTop: (token: symbol) => boolean;
  requestDismiss: (token: symbol) => void;
};

const DialogStackContext = createContext<DialogStackValue | null>(null);
const documentOwners = new WeakMap<Document, symbol>();

function invariant(message: string): never {
  throw new Error(`Dialog stack invariant violation: ${message}`);
}

export function DialogStackProvider({ children }: { children: ReactNode }) {
  const parentStack = useContext(DialogStackContext);
  if (parentStack) invariant('DialogStackProvider cannot be nested');
  const providerTokenRef = useRef(Symbol('dialog-stack-provider'));
  const stackRef = useRef<StackEntry[]>([]);
  const pageSnapshotRef = useRef<ElementSnapshot | null>(null);
  const bodyOverflowRef = useRef<BodyOverflowSnapshot | null>(null);
  const [revision, setRevision] = useState(0);
  const [hostsReady, setHostsReady] = useState(false);

  const restoreGlobalState = useCallback(() => {
    for (const entry of stackRef.current.toReversed()) {
      if (entry.isolatedParent) restore(entry.isolatedParent);
    }
    if (pageSnapshotRef.current) restore(pageSnapshotRef.current);
    if (bodyOverflowRef.current) restoreBodyOverflow(bodyOverflowRef.current);
    stackRef.current = [];
    pageSnapshotRef.current = null;
    bodyOverflowRef.current = null;
  }, []);

  useLayoutEffect(() => {
    const providerToken = providerTokenRef.current;
    const existingOwner = documentOwners.get(document);
    if (existingOwner && existingOwner !== providerToken) {
      invariant('only one DialogStackProvider may own a document');
    }
    documentOwners.set(document, providerToken);
    setHostsReady(true);
    return () => {
      restoreGlobalState();
      if (documentOwners.get(document) === providerToken) documentOwners.delete(document);
    };
  }, [restoreGlobalState]);

  const publish = useCallback(() => setRevision((value) => value + 1), []);

  const register = useCallback(
    (entry: StackEntry) => {
      const stack = stackRef.current;
      if (stack.some(({ token }) => token === entry.token)) return;

      const legalRoot = entry.level === 'root' && stack.length === 0;
      const legalSubordinate =
        entry.level === 'subordinate' && stack.length === 1 && stack[0]?.level === 'root';
      if (!legalRoot && !legalSubordinate) {
        invariant(`cannot register ${entry.level} at depth ${stack.length}`);
      }

      const appContent = document.getElementById('app-content');
      const dialogHost = document.getElementById('dialog-stack-root');
      const toastHost = document.getElementById('toast-root');
      if (!appContent || !dialogHost || !toastHost) invariant('required sibling hosts are missing');
      if (entry.backdrop.parentElement !== dialogHost) {
        invariant('dialog backdrop is not a direct child of #dialog-stack-root');
      }

      if (entry.level === 'root') {
        const pageSnapshot = snapshotElement(appContent);
        const bodyOverflow = snapshotBodyOverflow();
        isolate(pageSnapshot);
        document.body.style.setProperty('overflow', 'hidden', 'important');
        document.body.style.setProperty('overflow-x', 'hidden', 'important');
        document.body.style.setProperty('overflow-y', 'hidden', 'important');
        pageSnapshotRef.current = pageSnapshot;
        bodyOverflowRef.current = bodyOverflow;
      } else {
        const parent = stack[0];
        if (!parent) invariant('subordinate has no root parent');
        entry.isolatedParent = snapshotElement(parent.backdrop);
        isolate(entry.isolatedParent);
      }

      stack.push(entry);
      publish();
    },
    [publish],
  );

  const unregister = useCallback(
    (token: symbol) => {
      const stack = stackRef.current;
      const index = stack.findIndex((entry) => entry.token === token);
      if (index < 0) return;
      if (index !== stack.length - 1) {
        restoreGlobalState();
        publish();
        invariant('a lower layer cannot be removed beneath its child');
      }

      const [entry] = stack.splice(index, 1);
      if (!entry) return;
      if (entry.isolatedParent) restore(entry.isolatedParent);
      if (entry.level === 'root') {
        if (pageSnapshotRef.current) restore(pageSnapshotRef.current);
        if (bodyOverflowRef.current) restoreBodyOverflow(bodyOverflowRef.current);
        pageSnapshotRef.current = null;
        bodyOverflowRef.current = null;
      }
      publish();

      queueMicrotask(() => {
        if (stackRef.current.some((candidate) => candidate.token === entry.token)) return;
        const target = canReceiveFocus(entry.returnFocus) ? entry.returnFocus : entry.fallbackFocus;
        if (canReceiveFocus(target)) focusElement(target);
      });
    },
    [publish, restoreGlobalState],
  );

  const isTop = useCallback(
    (token: symbol) => stackRef.current.at(-1)?.token === token,
    // revision intentionally invalidates consumers after stack transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revision],
  );

  const isRegistered = useCallback(
    (token: symbol) => stackRef.current.some((entry) => entry.token === token),
    // revision intentionally invalidates consumers after stack transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revision],
  );

  const requestDismiss = useCallback((token: symbol) => {
    const top = stackRef.current.at(-1);
    if (top?.token === token && top.dismissible.current) top.onClose.current();
  }, []);

  useEffect(() => {
    if (!hostsReady) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const top = stackRef.current.at(-1);
      if (!top) return;
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
        if (top.dismissible.current) {
          event.preventDefault();
          top.onClose.current();
        }
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = focusableElements(top.dialog);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        focusElement(top.dialog);
      } else if (!top.dialog.contains(document.activeElement)) {
        event.preventDefault();
        focusElement(event.shiftKey ? last : first);
      } else if (document.activeElement === top.dialog) {
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

    const clearNumberReplacement = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement) delete target.dataset.dialogReplaceOnType;
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', clearNumberReplacement);
    document.addEventListener('focusout', clearNumberReplacement);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', clearNumberReplacement);
      document.removeEventListener('focusout', clearNumberReplacement);
    };
  }, [hostsReady]);

  const value = useMemo<DialogStackValue>(
    () => ({
      depth: stackRef.current.length,
      register,
      unregister,
      isRegistered,
      isTop,
      requestDismiss,
    }),
    [isRegistered, isTop, register, requestDismiss, unregister],
  );

  return (
    <DialogStackContext.Provider value={value}>
      <div id="app-content">{hostsReady ? children : null}</div>
      <div id="dialog-stack-root" />
      <div id="toast-root" />
    </DialogStackContext.Provider>
  );
}

// The Toast adapter consumes stack depth without owning modal behavior.
// eslint-disable-next-line react-refresh/only-export-components
export function useDialogStack() {
  const value = useContext(DialogStackContext);
  if (!value) invariant('DialogStackProvider is required');
  return value;
}

export function Dialog({
  title,
  description,
  level,
  role,
  variant,
  busy,
  dismissible,
  onClose,
  children,
  actions,
  initialFocusRef,
  returnFocusRef,
  returnFocusFallbackRef,
  showClose = true,
}: {
  title: string;
  description?: string;
  level: DialogLevel;
  role: DialogRole;
  variant: DialogVariant;
  busy: boolean;
  dismissible: boolean;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  returnFocusFallbackRef?: RefObject<HTMLElement | null>;
  showClose?: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const tokenRef = useRef(Symbol('dialog-layer'));
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dismissibleRef = useRef(dismissible);
  const onCloseRef = useRef(onClose);
  const previousBusyRef = useRef(busy);
  const pendingFocusRef = useRef<HTMLElement | null>(null);
  const [registered, setRegistered] = useState(false);
  const stack = useDialogStack();
  dismissibleRef.current = dismissible;
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const token = tokenRef.current;
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    if (!backdrop || !dialog) return;
    const returnFocus = returnFocusRef?.current ?? (document.activeElement as HTMLElement | null);
    const fallbackFocus = returnFocusFallbackRef?.current ?? null;
    stack.register({
      token,
      level,
      backdrop,
      dialog,
      returnFocus,
      fallbackFocus,
      dismissible: dismissibleRef,
      onClose: onCloseRef,
    });
    setRegistered(true);

    const focusInitial = () => {
      const initial = initialFocusRef?.current;
      focusElement(
        canReceiveFocus(initial) ? initial : (focusableElements(dialog)[0] ?? dialog),
        true,
      );
    };
    focusInitial();
    const initialFocusTimer = window.setTimeout(focusInitial, 0);
    return () => {
      window.clearTimeout(initialFocusTimer);
      stack.unregister(token);
    };
    // A layer's identity and focus provenance are immutable for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const wasBusy = previousBusyRef.current;
    previousBusyRef.current = busy;
    const dialog = dialogRef.current;
    if (!dialog || !registered || !stack.isTop(tokenRef.current)) return;
    if (!wasBusy && busy) {
      const focused = document.activeElement as HTMLElement | null;
      pendingFocusRef.current = focused && dialog.contains(focused) ? focused : null;
      focusElement(dialog);
    } else if (wasBusy && !busy) {
      const target = pendingFocusRef.current;
      pendingFocusRef.current = null;
      if (canReceiveFocus(target)) focusElement(target);
      else focusElement(focusableElements(dialog)[0] ?? dialog);
    }
  }, [busy, registered, stack]);

  const host = document.getElementById('dialog-stack-root');
  if (!host) invariant('#dialog-stack-root is missing');
  if (registered && !stack.isRegistered(tokenRef.current)) return null;
  const isTop = registered && stack.isTop(tokenRef.current);

  return createPortal(
    <div
      ref={backdropRef}
      className={`dialog-backdrop dialog-layer-${level}`}
      role="presentation"
      data-dialog-level={level}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) stack.requestDismiss(tokenRef.current);
      }}
    >
      <div
        ref={dialogRef}
        className={`dialog dialog-${variant}`}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={busy || undefined}
        data-dialog-top={isTop ? 'true' : 'false'}
        tabIndex={-1}
      >
        <div className="dialog-shell-header">
          {showClose && (
            <button
              type="button"
              className="icon-button dialog-close"
              onClick={() => stack.requestDismiss(tokenRef.current)}
              disabled={!dismissible}
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
        </div>
        <div className="dialog-shell-body">{children}</div>
        {actions && <div className="dialog-shell-actions">{actions}</div>}
      </div>
    </div>,
    host,
  );
}
