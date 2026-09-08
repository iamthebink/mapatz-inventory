// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Component, StrictMode, useRef, useState, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog, DialogStackProvider } from '../../src/web/Dialog';
import { Toast } from '../../src/web/Toast';

afterEach(() => {
  cleanup();
  document.body.removeAttribute('style');
});

function RootHarness({ withToast = false }: { withToast?: boolean }) {
  const [rootOpen, setRootOpen] = useState(false);
  const [childOpen, setChildOpen] = useState(false);
  const pageTriggerRef = useRef<HTMLButtonElement>(null);
  const childTriggerRef = useRef<HTMLButtonElement>(null);
  const rootInputRef = useRef<HTMLInputElement>(null);
  const childInputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button ref={pageTriggerRef} onClick={() => setRootOpen(true)}>
        open root
      </button>
      {withToast && (
        <Toast
          toast={{ id: 1, title: 'notice', message: 'still announced', tone: 'warning' }}
          onDismiss={vi.fn()}
        />
      )}
      {rootOpen && (
        <Dialog
          title="root"
          level="root"
          role="dialog"
          variant="workspace"
          busy={false}
          dismissible
          initialFocusRef={rootInputRef}
          returnFocusRef={pageTriggerRef}
          returnFocusFallbackRef={pageTriggerRef}
          onClose={() => setRootOpen(false)}
        >
          <input ref={rootInputRef} aria-label="root input" />
          <button ref={childTriggerRef} onClick={() => setChildOpen(true)}>
            open child
          </button>
        </Dialog>
      )}
      {childOpen && (
        <Dialog
          title="child"
          level="subordinate"
          role="alertdialog"
          variant="destructive"
          busy={false}
          dismissible
          initialFocusRef={childInputRef}
          returnFocusRef={childTriggerRef}
          returnFocusFallbackRef={rootInputRef}
          onClose={() => setChildOpen(false)}
        >
          <input ref={childInputRef} aria-label="child input" />
          <button>child last</button>
        </Dialog>
      )}
    </>
  );
}

function renderStack(children: ReactNode) {
  return render(<DialogStackProvider>{children}</DialogStackProvider>);
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null } as { error: Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    return this.state.error ? <span>{this.state.error.message}</span> : this.props.children;
  }
}

describe('DialogStackProvider', () => {
  it('rejects a sibling provider before it mounts children or document listeners', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const addEventListener = vi.spyOn(document, 'addEventListener');

    render(
      <>
        <DialogStackProvider>
          <Dialog
            title="first provider dialog"
            level="root"
            role="dialog"
            variant="standard"
            busy={false}
            dismissible
            onClose={vi.fn()}
          >
            first provider child
          </Dialog>
        </DialogStackProvider>
        <Boundary>
          <DialogStackProvider>
            <span>second provider child</span>
          </DialogStackProvider>
        </Boundary>
      </>,
    );

    expect(await screen.findByText(/only one DialogStackProvider may own a document/)).toBeTruthy();
    expect(await screen.findByRole('dialog', { name: 'first provider dialog' })).toBeTruthy();
    expect(screen.queryByText('second provider child')).toBeNull();
    expect(document.querySelectorAll('#app-content')).toHaveLength(1);
    expect(document.querySelectorAll('#dialog-stack-root')).toHaveLength(1);
    expect(document.querySelectorAll('#toast-root')).toHaveLength(1);
    await waitFor(() =>
      expect(addEventListener.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1),
    );

    addEventListener.mockRestore();
    consoleError.mockRestore();
  });

  it('owns sibling hosts and restores exact page, body, and focus state around a root', async () => {
    const user = userEvent.setup();
    renderStack(<RootHarness />);
    const app = document.getElementById('app-content')!;
    const dialogs = document.getElementById('dialog-stack-root')!;
    const toasts = document.getElementById('toast-root')!;
    expect(app.parentElement).toBe(dialogs.parentElement);
    expect(app.parentElement).toBe(toasts.parentElement);

    app.setAttribute('aria-hidden', 'false');
    document.body.style.setProperty('overflow-x', 'clip');
    document.body.style.setProperty('overflow-y', 'auto', 'important');
    await user.click(screen.getByRole('button', { name: 'open root' }));

    const root = screen.getByRole('dialog', { name: 'root' });
    expect(root.parentElement?.parentElement).toBe(dialogs);
    expect(dialogs.children).toHaveLength(1);
    expect(app.getAttribute('inert')).toBe('');
    expect(app.getAttribute('aria-hidden')).toBe('true');
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.body.style.getPropertyPriority('overflow-x')).toBe('important');
    expect(document.body.style.getPropertyPriority('overflow-y')).toBe('important');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('root input')));

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(app.hasAttribute('inert')).toBe(false);
    expect(app.getAttribute('aria-hidden')).toBe('false');
    expect(document.body.style.getPropertyValue('overflow')).toBe('');
    expect(document.body.style.getPropertyValue('overflow-x')).toBe('clip');
    expect(document.body.style.getPropertyPriority('overflow-x')).toBe('');
    expect(document.body.style.getPropertyValue('overflow-y')).toBe('auto');
    expect(document.body.style.getPropertyPriority('overflow-y')).toBe('important');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'open root' })),
    );
  });

  it('isolates and restores the parent while dispatching only to the subordinate', async () => {
    const user = userEvent.setup();
    renderStack(<RootHarness />);
    await user.click(screen.getByRole('button', { name: 'open root' }));
    const rootDialog = screen.getByRole('dialog', { name: 'root' });
    const rootBackdrop = rootDialog.parentElement!;
    const childTrigger = screen.getByRole('button', { name: 'open child' });
    rootBackdrop.setAttribute('aria-hidden', 'false');
    childTrigger.focus();
    fireEvent.click(childTrigger);

    const child = await screen.findByRole('alertdialog', { name: 'child' });
    expect(rootBackdrop.getAttribute('inert')).toBe('');
    expect(rootBackdrop.getAttribute('aria-hidden')).toBe('true');
    expect(child.parentElement?.parentElement).toBe(document.getElementById('dialog-stack-root'));
    expect(document.getElementById('dialog-stack-root')?.children).toHaveLength(2);

    rootDialog.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(within(child).getByRole('button', { name: 'סגירה' }));
    fireEvent.mouseDown(rootBackdrop);
    expect(screen.getByRole('alertdialog', { name: 'child' })).toBe(child);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(rootBackdrop.hasAttribute('inert')).toBe(false);
    expect(rootBackdrop.getAttribute('aria-hidden')).toBe('false');
    await waitFor(() => expect(document.activeElement).toBe(childTrigger));
    expect(screen.getByRole('dialog', { name: 'root' })).toBe(rootDialog);
  });

  it('rejects standalone subordinates without mutating page or body state', () => {
    document.body.style.overflow = 'auto';
    expect(() =>
      renderStack(
        <Dialog
          title="illegal"
          level="subordinate"
          role="dialog"
          variant="standard"
          busy={false}
          dismissible
          onClose={vi.fn()}
        >
          illegal
        </Dialog>,
      ),
    ).toThrow(/cannot register subordinate at depth 0/);
    expect(document.body.style.overflow).toBe('auto');
    expect(document.getElementById('app-content')?.hasAttribute('inert') ?? false).toBe(false);
  });

  it('rejects a second root while leaving the existing root operational', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function CompetingRoots() {
      const [second, setSecond] = useState(false);
      return (
        <>
          <Dialog
            title="first"
            level="root"
            role="dialog"
            variant="standard"
            busy={false}
            dismissible
            onClose={vi.fn()}
          >
            <button onClick={() => setSecond(true)}>add second</button>
          </Dialog>
          {second && (
            <Boundary>
              <Dialog
                title="second"
                level="root"
                role="dialog"
                variant="standard"
                busy={false}
                dismissible
                onClose={vi.fn()}
              >
                second
              </Dialog>
            </Boundary>
          )}
        </>
      );
    }
    renderStack(<CompetingRoots />);
    fireEvent.click(await screen.findByRole('button', { name: 'add second' }));
    expect(await screen.findByText(/cannot register root at depth 1/)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'first' })).toBeTruthy();
    expect(document.getElementById('dialog-stack-root')?.children).toHaveLength(1);
    expect(document.body.style.overflow).toBe('hidden');
    consoleError.mockRestore();
  });

  it('rejects a third layer while leaving both legal layers registered', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function ThreeLayers() {
      const [third, setThird] = useState(false);
      return (
        <>
          <Dialog
            title="root"
            level="root"
            role="dialog"
            variant="standard"
            busy={false}
            dismissible
            onClose={vi.fn()}
          >
            root
          </Dialog>
          <Dialog
            title="child"
            level="subordinate"
            role="dialog"
            variant="standard"
            busy={false}
            dismissible
            onClose={vi.fn()}
          >
            <button onClick={() => setThird(true)}>add third</button>
          </Dialog>
          {third && (
            <Boundary>
              <Dialog
                title="third"
                level="subordinate"
                role="dialog"
                variant="standard"
                busy={false}
                dismissible
                onClose={vi.fn()}
              >
                third
              </Dialog>
            </Boundary>
          )}
        </>
      );
    }
    renderStack(<ThreeLayers />);
    fireEvent.click(await screen.findByRole('button', { name: 'add third' }));
    expect(await screen.findByText(/cannot register subordinate at depth 2/)).toBeTruthy();
    const dialogHost = document.getElementById('dialog-stack-root')!;
    expect(dialogHost.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    expect(dialogHost.children).toHaveLength(2);
    expect(document.body.style.overflow).toBe('hidden');
    consoleError.mockRestore();
  });

  it('fails loudly and recovers without stale state when a root is removed beneath its child', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const rootClose = vi.fn();
    const childClose = vi.fn();
    function IllegalRemoval() {
      const [root, setRoot] = useState(true);
      return (
        <>
          <Boundary>
            {root ? (
              <Dialog
                title="root"
                level="root"
                role="dialog"
                variant="standard"
                busy={false}
                dismissible
                onClose={rootClose}
              >
                root
              </Dialog>
            ) : (
              <span>root removed</span>
            )}
          </Boundary>
          <Dialog
            title="child"
            level="subordinate"
            role="dialog"
            variant="standard"
            busy={false}
            dismissible
            onClose={childClose}
          >
            <button onClick={() => setRoot(false)}>remove root first</button>
          </Dialog>
        </>
      );
    }
    renderStack(
      <>
        <Toast
          toast={{ id: 2, title: 'recovery notice', message: 'registry probe', tone: 'warning' }}
          onDismiss={vi.fn()}
        />
        <IllegalRemoval />
      </>,
    );
    const toastDismiss = within(screen.getByRole('alert', { name: /registry probe/ })).getByRole(
      'button',
      { name: 'סגירת הודעה' },
    ) as HTMLButtonElement;
    expect(toastDismiss.disabled).toBe(true);
    fireEvent.click(await screen.findByRole('button', { name: 'remove root first' }));
    expect(await screen.findByText(/lower layer cannot be removed beneath its child/)).toBeTruthy();
    expect(document.getElementById('dialog-stack-root')?.children).toHaveLength(0);
    expect(document.body.style.overflow).toBe('');
    expect(document.getElementById('app-content')?.hasAttribute('inert')).toBe(false);
    await waitFor(() => expect(toastDismiss.disabled).toBe(false));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(rootClose).not.toHaveBeenCalled();
    expect(childClose).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('keeps busy and dismissible independent', async () => {
    const busyClose = vi.fn();
    const { unmount } = renderStack(
      <Dialog
        title="busy dismissible"
        level="root"
        role="dialog"
        variant="standard"
        busy
        dismissible
        onClose={busyClose}
      >
        busy
      </Dialog>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(busyClose).toHaveBeenCalledOnce();
    unmount();

    const idleClose = vi.fn();
    renderStack(
      <Dialog
        title="idle fixed"
        level="root"
        role="dialog"
        variant="standard"
        busy={false}
        dismissible={false}
        onClose={idleClose}
      >
        idle
      </Dialog>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    expect(idleClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog').hasAttribute('aria-busy')).toBe(false);
  });

  it('traps focus among only visible, enabled, non-inert controls', async () => {
    renderStack(
      <Dialog
        title="focus filter"
        level="root"
        role="dialog"
        variant="standard"
        busy={false}
        dismissible
        showClose={false}
        onClose={vi.fn()}
      >
        <button hidden>hidden</button>
        <button style={{ display: 'none' }}>display none</button>
        <button disabled>disabled</button>
        <span inert>
          <button>inert</button>
        </span>
        <button tabIndex={-2}>negative tabindex</button>
        <button tabIndex={3}>positive three</button>
        <button tabIndex={1}>positive one</button>
        <button>zero tabindex</button>
      </Dialog>,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'positive one' })),
    );
    screen.getByRole('button', { name: 'zero tabindex' }).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'positive one' }));
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'zero tabindex' }));
  });

  it('keeps Toast announced outside isolation but removes its control from interaction', async () => {
    const user = userEvent.setup();
    renderStack(<RootHarness withToast />);
    const toast = screen.getByRole('alert', { name: /still announced/ });
    const dismiss = within(toast).getByRole('button', { name: 'סגירת הודעה' });
    expect(toast.closest('#toast-root')).toBeTruthy();
    expect((dismiss as HTMLButtonElement).disabled).toBe(false);

    dismiss.focus();
    fireEvent.click(screen.getByRole('button', { name: 'open root' }));
    expect(toast.closest('[aria-hidden="true"]')).toBeNull();
    expect(toast.closest('[inert]')).toBeNull();
    expect((dismiss as HTMLButtonElement).disabled).toBe(true);
    expect(dismiss.tabIndex).toBe(-1);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('root input')));

    await user.click(screen.getByRole('button', { name: 'open child' }));
    expect(screen.getByRole('alertdialog', { name: 'child' })).toBeTruthy();
    expect((dismiss as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect((dismiss as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect((dismiss as HTMLButtonElement).disabled).toBe(false));
    expect(dismiss.tabIndex).toBe(0);
  });

  it('survives StrictMode effect replay without leaking isolation or handlers', async () => {
    const close = vi.fn();
    const { unmount } = render(
      <StrictMode>
        <DialogStackProvider>
          <Dialog
            title="strict"
            level="root"
            role="dialog"
            variant="standard"
            busy={false}
            dismissible
            onClose={close}
          >
            strict body
          </Dialog>
        </DialogStackProvider>
      </StrictMode>,
    );
    await screen.findByRole('dialog', { name: 'strict' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
    unmount();
    await waitFor(() => expect(document.body.style.overflow).toBe(''));
    expect(document.querySelector('[inert]')).toBeNull();
  });

  it('defines explicit layer order and one workspace scroll owner', () => {
    renderStack(
      <Dialog
        title="workspace"
        level="root"
        role="dialog"
        variant="workspace"
        busy={false}
        dismissible
        actions={<button>persistent actions</button>}
        onClose={vi.fn()}
      >
        <div>scrolling middle</div>
      </Dialog>,
    );
    const workspace = screen.getByRole('dialog', { name: 'workspace' });
    expect([...workspace.children].map((child) => child.className)).toEqual([
      'dialog-shell-header',
      'dialog-shell-body',
      'dialog-shell-actions',
    ]);
    const styles = readFileSync(resolve(process.cwd(), 'src/web/styles.css'), 'utf8');
    expect(styles).toMatch(/\.dialog-layer-root\s*{\s*z-index: 80/);
    expect(styles).toMatch(/\.toast-viewport\s*{[^}]*\bz-90\b/);
    expect(styles).toMatch(/\.dialog-layer-subordinate\s*{\s*z-index: 100/);
    expect(styles).toMatch(
      /\.dialog-workspace\s*{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto/,
    );
    expect(styles).toMatch(/\.dialog-workspace \.dialog-shell-body\s*{[^}]*overflow-y: auto/);
    expect(styles).toMatch(/\.dialog-workspace\s*{[^}]*overflow: hidden/);
    expect(styles).toMatch(
      /\.dialog-workspace[^}]*min-width: 0|\.dialog-workspace[\s\S]*?\.dialog-shell-body[^}]*min-width: 0/,
    );
  });
});
