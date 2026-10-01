import { desktop } from './desktop';
import { BorrowerImportDialog } from './BorrowerImportDialog';
import { FormEvent, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Archive,
  BookOpen,
  Boxes,
  ClipboardList,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  CalendarDays,
  Pencil,
  Radio,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Trash2,
  Upload,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import {
  AdminModeControl,
  AdminModeStatus,
  AdminPasswordDialog,
  AdminRecoveryDialog,
} from './AdminMode';
import {
  ApiError,
  api,
  downloadInventoryWorkbook,
  importRecoveryWorkbook,
  importResetWorkbook,
} from './api';
import { DataTable, type TableColumn } from './DataTable';
import {
  InventoryDialog,
  type ActiveDialog,
  type Borrower,
  type DialogSubmission,
  type Item,
  type Location,
} from './InventoryDialogs';
import { Toast, type ToastMessage, type ToastTone } from './Toast';
import { BorrowerWorkflow, type BorrowerWorkflowHandle } from './BorrowerWorkflow';
import { ConsumablesDesk } from './ConsumablesDesk';
import { hasStoredConsumableAttempt } from './consumable-attempt-storage';
import { PeriodSummary } from './PeriodSummary';
import { InventoryManagement } from './InventoryManagement';
import { Radios } from './Radios';
import { RadioCountSettings } from './RadioCountSettings';
import { Dialog } from './Dialog';
import {
  BORROWER_DELETION_STORAGE_KEY,
  clearFrozenManagementAttempt,
  persistFrozenManagementAttempt,
  readFrozenManagementAttempt,
  readFrozenManagementAttempts,
  safeWindowStorage,
  type FrozenManagementAttempt,
} from './borrower-workflow-recovery.js';

type Role = 'operator' | 'admin';
type LedgerEvent = {
  id: number;
  created_at: string;
  kind: string;
  itemName?: string;
  borrowerName?: string;
  quantity: number;
  note?: string;
};
type Session = { role: Role; deadline: number | null };
type Tab = 'desk' | 'summary' | 'catalogs' | 'ledger' | 'radios';
type ManagementTab = 'inventory' | 'borrowers' | 'data' | 'access';
type DeskView = 'borrowers' | 'consumables';
type BorrowerDeletionStatus = {
  borrower: Borrower;
  outstanding: number;
  lost: number;
  stateRevision: number;
};

const tabRoutes: Record<Tab, { path: string; aliases?: readonly string[] }> = {
  desk: { path: '/', aliases: ['/frontdesk'] },
  summary: { path: '/summary' },
  ledger: { path: '/ledger' },
  catalogs: { path: '/management' },
  radios: { path: '/radios' },
};

function tabFromPath(pathname: string): Tab | null {
  const normalized = pathname === '/' ? pathname : pathname.replace(/\/$/, '');
  return (
    (Object.entries(tabRoutes).find(
      ([, route]) => route.path === normalized || route.aliases?.includes(normalized),
    )?.[0] as Tab) ?? null
  );
}

const borrowerTypeNames: Record<Borrower['type'], string> = {
  individual: 'יחיד',
  camp_organization: 'ארגון מחנה',
  other: 'אחר',
};
const eventNames: Record<string, string> = {
  stock_added: 'קליטת מלאי',
  stock_removed: 'תיקון מלאי',
  issued: 'ניפוק',
  checked_out: 'השאלה',
  returned_usable: 'החזרה תקינה',
  returned_damaged: 'החזרה פגומה',
  marked_lost: 'סומן כאבוד',
  found_returned: 'נמצא והוחזר',
  found_returned_damaged: 'נמצא והוחזר פגום',
  repaired: 'תיקון',
  written_off: 'גריעה',
};
const ledgerEventName = (event: LedgerEvent) =>
  event.kind === 'stock_removed' && event.note === 'ארכוב פריט'
    ? 'איפוס מלאי בארכוב'
    : (eventNames[event.kind] ?? event.kind);
const navigation: { key: Tab; label: string; icon: LucideIcon }[] = [
  { key: 'desk', label: 'דלפק השאלות', icon: Users },
  { key: 'radios', label: 'מכשירי קשר', icon: Radio },
  { key: 'summary', label: 'סיכום', icon: CalendarDays },
  { key: 'ledger', label: 'יומן', icon: BookOpen },
  { key: 'catalogs', label: 'ניהול', icon: Settings2 },
];
const managementNavigation: {
  key: ManagementTab;
  label: string;
  description: string;
  icon: LucideIcon;
}[] = [
  { key: 'inventory', label: 'מלאי ומיקומים', description: 'פריטים, יתרות ומיקומים', icon: Boxes },
  { key: 'borrowers', label: 'שואלים', description: 'אנשים וארגונים', icon: Users },
  { key: 'data', label: 'ייבוא וייצוא', description: 'איפוס ושחזור מקובץ', icon: Download },
  { key: 'access', label: 'הרשאות והגדרות', description: 'סיסמאות ומכשירי קשר', icon: ShieldCheck },
];

function join(...values: (string | number | null | undefined)[]) {
  return values.filter((value) => value != null).join(' ');
}

export function App() {
  const recoveryAvailable =
    Boolean(desktop) || (import.meta.env.DEV && import.meta.env.MODE === 'recovery-preview');
  const [session, setSession] = useState<Session>({ role: 'operator', deadline: null });
  const [items, setItems] = useState<Item[]>([]);
  const [catalogItems, setCatalogItems] = useState<Item[]>([]);
  const [inventoryEpoch, setInventoryEpoch] = useState<number | null>(null);
  const [catalogBorrowers, setCatalogBorrowers] = useState<Borrower[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [ledger, setLedger] = useState<LedgerEvent[]>([]);
  const [tab, setTab] = useState<Tab>(() => tabFromPath(window.location.pathname) ?? 'desk');
  const [deskView, setDeskView] = useState<DeskView>(() =>
    hasStoredConsumableAttempt() ? 'consumables' : 'borrowers',
  );
  const [workflowStartup, setWorkflowStartup] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [summaryReturnRevision, setSummaryReturnRevision] = useState(0);
  const [managementTab, setManagementTab] = useState<ManagementTab>('inventory');
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [pending, setPending] = useState(false);
  const [borrowerImportOpen, setBorrowerImportOpen] = useState(false);
  const [borrowerCreateOpen, setBorrowerCreateOpen] = useState(false);
  const [adminDialogOpen, setAdminDialogOpen] = useState(false);
  const [adminRecoveryOpen, setAdminRecoveryOpen] = useState(false);
  const [activeDialog, setActiveDialog] = useState<ActiveDialog | null>(null);
  const [borrowerDeletionStatus, setBorrowerDeletionStatus] =
    useState<BorrowerDeletionStatus | null>(null);
  const [borrowerDeletionAttempt, setBorrowerDeletionAttempt] =
    useState<FrozenManagementAttempt | null>(() =>
      readFrozenManagementAttempt(safeWindowStorage(), BORROWER_DELETION_STORAGE_KEY),
    );
  const [adminPasswordError, setAdminPasswordError] = useState('');
  const [sessionReconciling, setSessionReconciling] = useState(false);
  const [announcement, setAnnouncement] = useState({ id: 0, text: '' });
  const pendingRef = useRef(false);
  const toastIdRef = useRef(0);
  const sessionRequestRef = useRef(0);
  const activityRequestRef = useRef<Promise<void> | null>(null);
  const borrowerCreateNameRef = useRef<HTMLInputElement>(null);
  const borrowerCreateTriggerRef = useRef<HTMLButtonElement>(null);
  const adminControlRef = useRef<HTMLButtonElement>(null);
  const managementTabRef = useRef<HTMLAnchorElement>(null);
  const dialogReturnFocusRef = useRef<HTMLElement>(null);
  const dialogFallbackRef = useRef<HTMLElement>(null);
  const previousRoleRef = useRef<Role>('operator');
  const imminentAnnouncedRef = useRef(false);
  const resetFileRef = useRef<HTMLInputElement>(null);
  const recoveryFileRef = useRef<HTMLInputElement>(null);
  const borrowerWorkflowRef = useRef<BorrowerWorkflowHandle>(null);
  const inventoryLeaveGuardRef = useRef<((continueNavigation: () => void) => boolean) | null>(null);
  const batchLeaveGuardRef = useRef<((continueNavigation: () => void) => boolean) | null>(null);
  const registerBatchLeaveGuard = useCallback(
    (guard: ((continueNavigation: () => void) => boolean) | null) => {
      batchLeaveGuardRef.current = guard;
    },
    [],
  );
  const registerInventoryLeaveGuard = useCallback(
    (guard: ((continueNavigation: () => void) => boolean) | null) => {
      inventoryLeaveGuardRef.current = guard;
    },
    [],
  );
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const [now, setNow] = useState(Date.now());
  const remaining =
    session.deadline == null ? null : Math.max(0, Math.ceil((session.deadline - now) / 1000));
  const isAdmin = session.role === 'admin';
  const adminActionsEnabled = isAdmin && !sessionReconciling;
  const inventoryDialogPending = pending || (sessionReconciling && activeDialog != null);

  const performNavigation = useCallback((nextTab: Tab) => {
    if (nextTab !== 'desk' && nextTab !== 'summary') setWorkflowStartup('loading');
    if (nextTab === 'summary' && tabRef.current !== 'desk' && tabRef.current !== 'summary')
      setWorkflowStartup('loading');
    window.history.pushState(
      { ...window.history.state, mapatzTab: nextTab },
      '',
      tabRoutes[nextTab].path,
    );
    setBorrowerCreateOpen(false);
    setTab(nextTab);
  }, []);

  const navigateToTab = useCallback(
    (nextTab: Tab) => {
      if (borrowerCreateOpen && pendingRef.current) return;
      if (
        tabRef.current === 'desk' &&
        nextTab !== 'desk' &&
        batchLeaveGuardRef.current &&
        !batchLeaveGuardRef.current(() => performNavigation(nextTab))
      )
        return;
      if (
        tabRef.current === 'catalogs' &&
        nextTab !== 'catalogs' &&
        inventoryLeaveGuardRef.current &&
        !inventoryLeaveGuardRef.current(() => performNavigation(nextTab))
      )
        return;
      performNavigation(nextTab);
    },
    [borrowerCreateOpen, performNavigation],
  );

  const selectDeskView = (nextView: DeskView) => {
    if (nextView === deskView) return;
    if (deskView === 'consumables') {
      if (batchLeaveGuardRef.current && !batchLeaveGuardRef.current(() => setDeskView(nextView)))
        return;
      setDeskView(nextView);
      return;
    }
    borrowerWorkflowRef.current?.requestNavigation(() => setDeskView(nextView));
  };

  const clearImportInput = useCallback((mode: 'reset' | 'recovery') => {
    const input = mode === 'reset' ? resetFileRef.current : recoveryFileRef.current;
    if (input) input.value = '';
  }, []);

  const closeInventoryDialog = useCallback(() => {
    if (activeDialog?.kind === 'import') clearImportInput(activeDialog.mode);
    setActiveDialog(null);
  }, [activeDialog, clearImportInput]);

  function openInventoryDialog(
    dialog: ActiveDialog,
    fallback: HTMLElement | null,
    returnFocus: HTMLElement | null = document.activeElement as HTMLElement | null,
  ) {
    dialogReturnFocusRef.current = returnFocus;
    dialogFallbackRef.current = fallback;
    setActiveDialog(dialog);
  }

  const showToast = useCallback((title: string, message: string, tone: ToastTone) => {
    toastIdRef.current += 1;
    setToast({ id: toastIdRef.current, title, message, tone });
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToast((current) => (current?.id === id ? null : current));
  }, []);
  const showError = useCallback(
    (title: string, error: unknown) => {
      showToast(title, error instanceof Error ? error.message : 'הפעולה נכשלה', 'error');
    },
    [showToast],
  );

  const announce = useCallback((text: string) => {
    setAnnouncement((current) => ({ id: current.id + 1, text }));
  }, []);

  const applySession = useCallback((next: Session, requestId: number) => {
    if (requestId !== sessionRequestRef.current) return;
    setNow(Date.now());
    setSession(next);
  }, []);

  const refresh = useCallback(async () => {
    const sessionRequestId = ++sessionRequestRef.current;
    const [current, nextItems, allItems, allBorrowers, nextLocations, epoch] = await Promise.all([
      api<Session>('/session'),
      api<Item[]>('/items'),
      api<Item[]>('/items?all=1'),
      api<Borrower[]>('/borrowers?all=1'),
      api<Location[]>('/locations?all=1'),
      api<{ ledgerEpoch: number }>('/inventory/epoch'),
    ]);
    applySession(current, sessionRequestId);
    setItems(nextItems);
    setCatalogItems(allItems);
    setInventoryEpoch(epoch.ledgerEpoch);
    setCatalogBorrowers(allBorrowers);
    setLocations(nextLocations);
    if (tab === 'ledger') setLedger(await api<LedgerEvent[]>('/ledger'));
  }, [applySession, tab]);

  useEffect(() => {
    refresh().catch((error) => showError('טעינת נתוני המלאי', error));
  }, [refresh, showError]);
  useEffect(() => {
    const syncTabToLocation = () => {
      const nextTab = tabFromPath(window.location.pathname);
      if (borrowerCreateOpen && nextTab !== 'catalogs') {
        if (pendingRef.current) {
          window.history.replaceState(
            { ...window.history.state, mapatzTab: 'catalogs' },
            '',
            tabRoutes.catalogs.path,
          );
          return;
        }
        setBorrowerCreateOpen(false);
      }
      if (nextTab) {
        if (
          tabRef.current === 'desk' &&
          nextTab !== 'desk' &&
          batchLeaveGuardRef.current &&
          !batchLeaveGuardRef.current(() => performNavigation(nextTab))
        ) {
          window.history.replaceState(
            { ...window.history.state, mapatzTab: 'desk' },
            '',
            tabRoutes.desk.path,
          );
          return;
        }
        if (
          tabRef.current === 'catalogs' &&
          nextTab !== 'catalogs' &&
          inventoryLeaveGuardRef.current &&
          !inventoryLeaveGuardRef.current(() => performNavigation(nextTab))
        ) {
          window.history.replaceState(
            { ...window.history.state, mapatzTab: 'catalogs' },
            '',
            tabRoutes.catalogs.path,
          );
          return;
        }
        if (nextTab !== 'desk' && nextTab !== 'summary') setWorkflowStartup('loading');
        if (nextTab === 'summary' && tabRef.current !== 'desk' && tabRef.current !== 'summary')
          setWorkflowStartup('loading');
        setTab(nextTab);
        return;
      }
      window.history.replaceState(
        { ...window.history.state, mapatzTab: 'desk' },
        '',
        `${tabRoutes.desk.path}${window.location.search}${window.location.hash}`,
      );
      setTab('desk');
    };
    syncTabToLocation();
    window.addEventListener('popstate', syncTabToLocation);
    return () => window.removeEventListener('popstate', syncTabToLocation);
  }, [borrowerCreateOpen, performNavigation]);
  useEffect(() => {
    const auth = () => refresh().catch((error) => showError('רענון הרשאות', error));
    window.addEventListener('mapatz-auth-stale', auth);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.removeEventListener('mapatz-auth-stale', auth);
      clearInterval(timer);
    };
  }, [refresh, showError]);
  useEffect(() => {
    if (remaining !== 0 || session.role !== 'admin') return;

    // Expiry is fail-safe in the UI: revoke locally before reconciling with the server.
    // This prevents a failed refresh from leaving enabled admin controls at 00:00.
    sessionRequestRef.current += 1;
    setSession({ role: 'operator', deadline: null });
    refresh().catch((error) => showError('רענון לאחר סיום מצב מנהל', error));
  }, [remaining, session.role, refresh, showError]);
  useEffect(() => {
    let lastPing = 0;
    const activity = (event: Event) => {
      if (!event.isTrusted || session.role !== 'admin' || Date.now() - lastPing < 5_000) return;
      lastPing = Date.now();
      const requestId = ++sessionRequestRef.current;
      const request = api<Session>('/session/activity', { method: 'POST' })
        .then((next) => applySession(next, requestId))
        .catch((error) => showError('הארכת מצב מנהל', error))
        .finally(() => {
          if (activityRequestRef.current === request) activityRequestRef.current = null;
        });
      activityRequestRef.current = request;
    };
    window.addEventListener('pointerdown', activity);
    window.addEventListener('keydown', activity);
    return () => {
      window.removeEventListener('pointerdown', activity);
      window.removeEventListener('keydown', activity);
    };
  }, [applySession, session.role, showError]);
  useEffect(() => {
    const reconcile = () => {
      if (document.visibilityState !== 'visible') return;
      setSessionReconciling(true);
      refresh()
        .catch((error) => showError('רענון נתוני המלאי', error))
        .finally(() => setSessionReconciling(false));
    };
    document.addEventListener('visibilitychange', reconcile);
    return () => document.removeEventListener('visibilitychange', reconcile);
  }, [refresh, showError]);
  useEffect(() => {
    const previousRole = previousRoleRef.current;
    if (previousRole !== session.role) {
      announce(session.role === 'admin' ? 'מצב מנהל הופעל. נותרו 10 דקות.' : 'מצב מנהל הסתיים.');
      if (previousRole === 'admin' && session.role === 'operator') {
        const focused = document.activeElement as HTMLElement | null;
        const becameUnavailable =
          !focused?.isConnected ||
          focused.matches(':disabled, [aria-disabled="true"]') ||
          Boolean(focused.closest('fieldset:disabled'));
        if (becameUnavailable) adminControlRef.current?.focus();
      }
    }
    previousRoleRef.current = session.role;
  }, [announce, session.role]);
  useEffect(() => {
    if (!isAdmin || remaining == null) {
      imminentAnnouncedRef.current = false;
      return;
    }
    if (remaining > 10) {
      imminentAnnouncedRef.current = false;
      return;
    }
    if (!imminentAnnouncedRef.current) {
      imminentAnnouncedRef.current = true;
      announce('מצב מנהל יסתיים בעוד 10 שניות.');
    }
  }, [announce, isAdmin, remaining]);
  useEffect(() => {
    if (isAdmin) return;
    setBorrowerImportOpen(false);
    if (!activeDialog) return;
    if (activeDialog.kind === 'import') clearImportInput(activeDialog.mode);
    setActiveDialog(null);
  }, [activeDialog, clearImportInput, isAdmin]);
  useEffect(
    () =>
      desktop?.onCloseRequest(() => {
        if (pendingRef.current) {
          showToast('הפעולה מוגנת', 'יש להמתין לסיום הפעולה.', 'warning');
          return;
        }
        const complete = () =>
          borrowerWorkflowRef.current
            ? borrowerWorkflowRef.current.requestNavigation(() => desktop?.approveClose())
            : desktop?.approveClose();
        if (
          tabRef.current === 'desk' &&
          batchLeaveGuardRef.current &&
          !batchLeaveGuardRef.current(complete)
        )
          return;
        complete();
      }),
    [showToast],
  );

  async function action(title: string, operation: () => Promise<unknown>) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    try {
      // A pointer/keyboard event may have started a deadline extension immediately
      // before this action. Preserve event order at the API boundary.
      await activityRequestRef.current;
      if ((await operation()) === 'cancelled') return false;
      try {
        await refresh();
        showToast(title, 'הפעולה הושלמה בהצלחה', 'success');
      } catch {
        showToast(
          title,
          'הפעולה הושלמה, אך התצוגה לא התרעננה. אין לחזור עליה; יש לרענן את המסך.',
          'warning',
        );
      }
      return true;
    } catch (error) {
      showError(title, error);
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  async function submitBorrowerCreation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;
    const form = new FormData(event.currentTarget);
    const succeeded = await action('הוספת שואל חדש', async () => {
      const { ledgerEpoch } = await api<{ ledgerEpoch: number }>('/borrowers/search?q=');
      return api('/borrowers', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          contractVersion: 1,
          ledgerEpoch,
          username: form.get('username'),
          name: form.get('name'),
          contact: form.get('contact'),
          type: form.get('type'),
        }),
      });
    });
    if (succeeded) setBorrowerCreateOpen(false);
  }

  async function inspectBorrowerForDeletion(borrower: Borrower) {
    if (!adminActionsEnabled || pendingRef.current || borrowerDeletionAttempt) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await activityRequestRef.current;
      setBorrowerDeletionStatus(
        await api<BorrowerDeletionStatus>(`/borrowers/${borrower.id}/deletion-status`),
      );
    } catch (error) {
      showError('בדיקת אפשרות למחיקת שואל', error);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  function clearStoredBorrowerDeletionAttempt(key: string): boolean {
    return clearFrozenManagementAttempt(safeWindowStorage(), BORROWER_DELETION_STORAGE_KEY, key);
  }
  async function dispatchBorrowerDeletion(attempt: FrozenManagementAttempt) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await activityRequestRef.current;
      await api(attempt.path, {
        method: attempt.method,
        body: JSON.stringify(attempt.body),
      });
      const cleared = clearStoredBorrowerDeletionAttempt(attempt.key);
      setBorrowerDeletionAttempt(
        cleared
          ? readFrozenManagementAttempt(safeWindowStorage(), BORROWER_DELETION_STORAGE_KEY)
          : attempt,
      );
      setBorrowerDeletionStatus(null);
      try {
        await refresh();
        showToast(
          'מחיקת שואל',
          cleared
            ? 'השואל וההיסטוריה שלו נמחקו. יתרות המלאי של פריטים אחרים לא השתנו.'
            : 'השואל נמחק, אך לא ניתן להסיר את פרטי ניסיון השחזור מהמכשיר.',
          cleared ? 'success' : 'warning',
        );
      } catch {
        showToast(
          'מחיקת שואל',
          cleared
            ? 'השואל נמחק, אך התצוגה לא התרעננה. יש לרענן את המסך.'
            : 'השואל נמחק, אך התצוגה וניסיון השחזור לא התרעננו. יש לרענן את המסך.',
          'warning',
        );
      }
    } catch (error) {
      setBorrowerDeletionStatus(null);
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setBorrowerDeletionAttempt(attempt);
        showToast(
          'מחיקת שואל ממתינה',
          'השרת דרש הרשאת מנהל. לאחר הכניסה למצב מנהל, יש לבדוק שוב את אותה פעולה.',
          'warning',
        );
      } else if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        const cleared = clearStoredBorrowerDeletionAttempt(attempt.key);
        setBorrowerDeletionAttempt(
          cleared
            ? readFrozenManagementAttempt(safeWindowStorage(), BORROWER_DELETION_STORAGE_KEY)
            : attempt,
        );
        try {
          await refresh();
        } catch {
          // The rejection is definitive; the toast below carries the server result.
        }
        showToast('מחיקת שואל לא בוצעה', error.message, cleared ? 'error' : 'warning');
      } else {
        setBorrowerDeletionAttempt(attempt);
        try {
          await refresh();
        } catch {
          // The same-key retry remains available if the commit status is still unknown.
        }
        showToast(
          'מחיקת שואל ממתינה לבדיקה',
          'לא התקבלה תשובה חד־משמעית. אפשר לבדוק שוב את אותה פעולה עם אותו מפתח.',
          'warning',
        );
      }
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  function confirmBorrowerDeletion() {
    if (!borrowerDeletionStatus || inventoryEpoch == null || borrowerDeletionAttempt) return;
    const storage = safeWindowStorage();
    if (!storage) {
      showToast('המחיקה לא נשלחה', 'אחסון השחזור בדפדפן אינו זמין כרגע', 'error');
      return;
    }
    const existingAttempt = readFrozenManagementAttempts(storage, BORROWER_DELETION_STORAGE_KEY)[0];
    if (existingAttempt) {
      setBorrowerDeletionAttempt(existingAttempt);
      showToast(
        'מחיקה קודמת ממתינה לבדיקה',
        'יש לבדוק תחילה את אותה פעולה לפני מחיקה נוספת',
        'warning',
      );
      return;
    }
    const key = crypto.randomUUID();
    const attempt: FrozenManagementAttempt = {
      version: 1,
      key,
      path: `/borrowers/${borrowerDeletionStatus.borrower.id}/delete`,
      method: 'POST',
      body: {
        key,
        ledgerEpoch: inventoryEpoch,
        expectedStateRevision: borrowerDeletionStatus.stateRevision,
        expectedOutstanding: borrowerDeletionStatus.outstanding,
        expectedLost: borrowerDeletionStatus.lost,
        expectedName: borrowerDeletionStatus.borrower.name,
        expectedUsername: borrowerDeletionStatus.borrower.username,
      },
    };
    const stored = persistFrozenManagementAttempt(storage, attempt, BORROWER_DELETION_STORAGE_KEY);
    if (!stored) {
      showToast(
        'המחיקה לא נשלחה',
        'לא ניתן לשמור ניסיון שחזור מקומי. בדוק את אחסון הדפדפן ונסה שוב.',
        'error',
      );
      return;
    }
    setBorrowerDeletionAttempt(attempt);
    void dispatchBorrowerDeletion(attempt);
  }
  const closeAdminDialog = useCallback(() => {
    setAdminDialogOpen(false);
    setAdminPasswordError('');
  }, []);
  const openAdminRecovery = useCallback(() => {
    setAdminDialogOpen(false);
    setAdminPasswordError('');
    setAdminRecoveryOpen(true);
  }, []);
  function toggleAdminMode() {
    if (!isAdmin) {
      setToast(null);
      setAdminPasswordError('');
      setAdminDialogOpen(true);
      return;
    }
    void endAdminMode();
  }
  async function endAdminMode() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    const requestId = ++sessionRequestRef.current;
    try {
      const next = await api<Session>('/session/role', {
        method: 'POST',
        body: JSON.stringify({ role: 'operator' }),
      });
      applySession(next, requestId);
    } catch (error) {
      showError('סיום מצב מנהל', error);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  async function authenticateAdmin(password: string) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setAdminPasswordError('');
    const requestId = ++sessionRequestRef.current;
    try {
      const next = await api<Session>('/session/role', {
        method: 'POST',
        body: JSON.stringify({ role: 'admin', password }),
      });
      applySession(next, requestId);
      closeAdminDialog();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'wrong_password') {
        setAdminPasswordError('הסיסמה אינה נכונה.');
      } else {
        showError('הפעלת מצב מנהל', error);
      }
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  async function submitInventoryDialog(submission: DialogSubmission): Promise<boolean> {
    let succeeded = false;
    switch (submission.kind) {
      case 'edit-borrower':
        succeeded = await action('עריכת שואל', () =>
          api(`/borrowers/${submission.borrowerId}`, {
            method: 'PUT',
            body: JSON.stringify({
              name: submission.name,
              username: submission.username,
              contact: submission.contact,
              type: submission.borrowerType,
            }),
          }),
        );
        break;
      case 'import':
        succeeded = await action(
          submission.mode === 'reset' ? 'ייבוא איפוס שנתי' : 'שחזור מלא',
          () =>
            submission.mode === 'reset'
              ? importResetWorkbook(submission.file)
              : importRecoveryWorkbook(submission.file),
        );
        clearImportInput(submission.mode);
        break;
    }
    if (succeeded) setActiveDialog(null);
    return succeeded;
  }

  const borrowerColumns: TableColumn<Borrower>[] = [
    {
      key: 'name',
      label: 'שם',
      render: (borrower) => borrower.name,
      sortValue: (borrower) => borrower.name,
    },
    {
      key: 'username',
      label: 'שם משתמש',
      render: (borrower) => (
        <span dir="ltr" className="font-mono text-xs">
          {borrower.username}
        </span>
      ),
      sortValue: (borrower) => borrower.username,
    },
    {
      key: 'type',
      label: 'סוג',
      render: (borrower) => borrowerTypeNames[borrower.type],
      sortValue: (borrower) => borrower.type,
    },
    {
      key: 'status',
      label: 'מצב',
      render: (borrower) => (
        <StatusBadge tone={borrower.archived ? 'neutral' : 'green'}>
          {borrower.archived ? 'בארכיון' : 'פעיל'}
        </StatusBadge>
      ),
      sortValue: (borrower) => Number(borrower.archived),
    },
    {
      key: 'actions',
      label: 'פעולות',
      render: (borrower) => (
        <RowActions
          onEdit={() =>
            openInventoryDialog({ kind: 'edit-borrower', borrower }, managementTabRef.current)
          }
          archived={borrower.archived}
          disabled={pending || !adminActionsEnabled}
          onArchive={() =>
            void action(borrower.archived ? 'הוצאת שואל מהארכיון' : 'העברת שואל לארכיון', () =>
              api(`/borrowers/${borrower.id}/archive`, {
                method: 'POST',
                body: JSON.stringify({ archived: !borrower.archived }),
              }),
            )
          }
          onDelete={
            borrowerDeletionAttempt ? undefined : () => void inspectBorrowerForDeletion(borrower)
          }
        />
      ),
    },
  ];
  const ledgerColumns: TableColumn<LedgerEvent>[] = [
    { key: 'id', label: '#', render: (event) => event.id, sortValue: (event) => event.id },
    {
      key: 'time',
      label: 'זמן',
      render: (event) => (
        <span dir="ltr" className="whitespace-nowrap text-xs">
          {event.created_at}
        </span>
      ),
      sortValue: (event) => event.created_at,
    },
    {
      key: 'kind',
      label: 'אירוע',
      render: (event) => <StatusBadge tone="blue">{ledgerEventName(event)}</StatusBadge>,
      sortValue: (event) => event.kind,
    },
    {
      key: 'item',
      label: 'פריט',
      render: (event) => <>{event.itemName}</>,
      sortValue: (event) => event.itemName ?? '',
    },
    {
      key: 'borrower',
      label: 'שואל',
      render: (event) => event.borrowerName ?? '—',
      sortValue: (event) => event.borrowerName ?? '',
    },
    {
      key: 'quantity',
      label: 'כמות',
      render: (event) => event.quantity,
      sortValue: (event) => event.quantity,
    },
    {
      key: 'note',
      label: 'הערה',
      render: (event) => event.note || '—',
      sortValue: (event) => event.note ?? '',
    },
  ];

  return (
    <div className={`app-shell ${isAdmin ? 'admin-mode-active' : ''}`}>
      <header className="app-header">
        <div className="app-header-inner">
          <div className="app-brand">
            <img
              src="/mapatz-2026-logo.jpeg"
              alt="סמל מפ״צ 2026"
              width={56}
              height={56}
              className="size-14 shrink-0 rounded-xl object-contain"
            />
            <div className="min-w-0">
              <h1 className="text-xl font-bold tracking-tight">מלאי מפ״צ</h1>
              <p className={`connectivity-status ${isAdmin ? 'admin-active' : ''}`}>
                <span className="size-1.5 rounded-full bg-ctp-green" />
                מקומי · עובד ללא אינטרנט
              </p>
              {isAdmin && remaining != null && (
                <div className="admin-mode-status-mobile">
                  <AdminModeStatus remaining={remaining} />
                </div>
              )}
            </div>
          </div>
          {isAdmin && remaining != null && (
            <div className="admin-mode-status-desktop">
              <AdminModeStatus remaining={remaining} />
            </div>
          )}
          <AdminModeControl
            ref={adminControlRef}
            active={isAdmin}
            disabled={pending}
            onClick={toggleAdminMode}
          />
        </div>
      </header>
      <nav className="app-nav" aria-label="ניווט ראשי">
        <div className="mx-auto flex max-w-screen-2xl items-center gap-1 overflow-x-auto px-3 py-2 sm:px-6 lg:px-8">
          {navigation.map(({ key, label, icon: Icon }) => (
            <div className="contents" key={key}>
              <a
                ref={key === 'catalogs' ? managementTabRef : undefined}
                href={tabRoutes[key].path}
                className={`nav-item ${tab === key ? 'active' : ''}`}
                aria-current={tab === key ? 'page' : undefined}
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  if (key === tab) return;
                  const complete = () => navigateToTab(key);
                  if (tab === 'desk' || tab === 'summary')
                    borrowerWorkflowRef.current?.requestNavigation(complete);
                  else complete();
                }}
              >
                <Icon className="size-4" />
                {label}
              </a>
            </div>
          ))}
        </div>
      </nav>
      <div
        key={`announcement-${announcement.id}`}
        className="sr-only"
        role="status"
        aria-live={isAdmin && remaining != null && remaining <= 10 ? 'assertive' : 'polite'}
        aria-atomic="true"
      >
        {announcement.text}
      </div>
      {borrowerImportOpen && isAdmin && (
        <BorrowerImportDialog
          onClose={() => setBorrowerImportOpen(false)}
          refresh={refresh}
          showToast={showToast}
          beforeRequest={async () => {
            await activityRequestRef.current;
          }}
        />
      )}
      {toast && <Toast key={`toast-${toast.id}`} toast={toast} onDismiss={dismissToast} />}
      <main className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        {tab === 'radios' && <Radios active showToast={showToast} />}
        {tab === 'desk' && (
          <div
            className="desk-view-switch inventory-view-switch"
            role="group"
            aria-label="תצוגת דלפק השאלות"
          >
            <button
              type="button"
              aria-pressed={deskView === 'borrowers'}
              aria-controls="desk-borrowers-panel"
              onClick={() => selectDeskView('borrowers')}
            >
              השאלות והחזרות
            </button>
            <button
              type="button"
              aria-pressed={deskView === 'consumables'}
              aria-controls="desk-consumables-panel"
              onClick={() => selectDeskView('consumables')}
            >
              ציוד מתכלה
            </button>
          </div>
        )}
        {tab === 'desk' && (
          <div id="desk-consumables-panel" hidden={deskView !== 'consumables'}>
            <ConsumablesDesk
              items={items}
              ledgerEpoch={inventoryEpoch}
              refresh={refresh}
              showToast={showToast}
              registerLeaveGuard={registerBatchLeaveGuard}
            />
          </div>
        )}
        {(tab === 'desk' || tab === 'summary') && (
          <div id="desk-borrowers-panel" hidden={tab !== 'desk' || deskView !== 'borrowers'}>
            <BorrowerWorkflow
              ref={borrowerWorkflowRef}
              showToast={showToast}
              deskVisible={tab === 'desk' && deskView === 'borrowers'}
              onStartupChange={setWorkflowStartup}
            />
          </div>
        )}
        {tab === 'summary' && workflowStartup !== 'ready' && (
          <section className="period-summary" aria-label="סיכום">
            <h2>סיכום</h2>
            {workflowStartup === 'loading' ? (
              <p role="status">בודק פעולות שמורות…</p>
            ) : (
              <button
                type="button"
                className="secondary-button"
                onClick={() => borrowerWorkflowRef.current?.retryStartup()}
              >
                ניסיון טעינה מחדש
              </button>
            )}
          </section>
        )}
        <PeriodSummary
          active={tab === 'summary' && workflowStartup === 'ready'}
          returnRevision={summaryReturnRevision}
          showToast={showToast}
          openCard={(borrower) =>
            borrowerWorkflowRef.current?.openFromSummary(borrower, () =>
              setSummaryReturnRevision((value) => value + 1),
            )
          }
        />
        {tab === 'catalogs' && (
          <PageSection
            title="ניהול"
            description="כלי תחזוקה מסודרים לפי תחום אחריות"
            icon={Settings2}
          >
            <div className="management-tabs" role="tablist">
              {managementNavigation.map(({ key, label, description, icon: Icon }) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={managementTab === key}
                  className={managementTab === key ? 'active' : ''}
                  onClick={() => {
                    if (
                      managementTab === 'inventory' &&
                      key !== 'inventory' &&
                      inventoryLeaveGuardRef.current &&
                      !inventoryLeaveGuardRef.current(() => setManagementTab(key))
                    )
                      return;
                    setManagementTab(key);
                  }}
                >
                  <Icon className="size-5" />
                  <span>
                    <strong>{label}</strong>
                    <small>{description}</small>
                  </span>
                </button>
              ))}
            </div>
            <div className="mt-6">
              {managementTab === 'inventory' && (
                <InventoryManagement
                  items={catalogItems}
                  locations={locations}
                  ledgerEpoch={inventoryEpoch}
                  admin={adminActionsEnabled}
                  onRefresh={refresh}
                  showToast={showToast}
                  registerLeaveGuard={registerInventoryLeaveGuard}
                />
              )}
              {managementTab === 'borrowers' && (
                <div className="space-y-7">
                  <div className="flex justify-end">
                    <button
                      ref={borrowerCreateTriggerRef}
                      type="button"
                      className="secondary-button"
                      disabled={pending}
                      onClick={() => setBorrowerCreateOpen(true)}
                    >
                      <UserPlus className="size-4" />
                      יצירת שואל חדש
                    </button>
                  </div>
                  {borrowerDeletionAttempt && (
                    <section className="rounded-2xl border border-ctp-yellow/40 bg-ctp-yellow/5 p-4">
                      <h3 className="font-semibold">מחיקת שואל ממתינה לבדיקה</h3>
                      <p className="mt-1 text-sm text-ctp-subtext">
                        נשמר ניסיון מחיקה שלא התקבלה עליו תשובה. בדיקה חוזרת תשלח בדיוק את אותה
                        בקשה, עם אותו מפתח.
                      </p>
                      <button
                        type="button"
                        className="primary-button mt-3"
                        disabled={pending || !adminActionsEnabled}
                        onClick={() => void dispatchBorrowerDeletion(borrowerDeletionAttempt)}
                      >
                        בדיקת אותה פעולה
                      </button>
                    </section>
                  )}
                  <CatalogBlock title="קטלוג שואלים">
                    <DataTable
                      rows={catalogBorrowers}
                      columns={borrowerColumns}
                      rowKey={(borrower) => borrower.id}
                      searchText={(borrower) =>
                        join(
                          borrower.name,
                          borrower.username,
                          borrower.contact,
                          borrowerTypeNames[borrower.type],
                          borrower.archived ? 'ארכיון' : 'פעיל',
                        )
                      }
                      searchPlaceholder="סינון שואלים…"
                    />
                  </CatalogBlock>
                </div>
              )}
              {managementTab === 'access' && (
                <div className="max-w-2xl space-y-4">
                  <ActionCard
                    title="החלפת סיסמה"
                    description="עדכון הסיסמה לכניסה למצב מנהל"
                    icon={KeyRound}
                    disabled={!adminActionsEnabled || pending}
                    onSubmit={(form) =>
                      action('החלפת סיסמה', () =>
                        api('/password', {
                          method: 'POST',
                          body: JSON.stringify({
                            password: form.get('password'),
                          }),
                        }),
                      )
                    }
                  >
                    <PasswordField name="password" label="סיסמה חדשה" />
                  </ActionCard>
                  <RadioCountSettings
                    isAdmin={isAdmin}
                    sessionReconciling={sessionReconciling}
                    showToast={showToast}
                  />
                  {!isAdmin && <PermissionNote />}
                </div>
              )}
              {managementTab === 'data' && (
                <div className="grid gap-4 lg:grid-cols-2">
                  <ActionCard
                    title="ייצוא מלאי"
                    description="קובץ XLSX לאיפוס, שחזור ודוחות — ללא סיסמאות או הגדרות"
                    icon={Download}
                    disabled={!adminActionsEnabled || pending}
                    onSubmit={() => action('ייצוא מלאי', downloadInventoryWorkbook)}
                  >
                    <p className="text-sm text-ctp-subtext">
                      הקובץ כולל אזורי איפוס ושחזור נפרדים. שמרו אותו במקום מאובטח.
                    </p>
                  </ActionCard>
                  <section className="action-card">
                    <div className="mb-5 flex items-start gap-3">
                      <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-ctp-blue/10 text-ctp-blue">
                        <Users className="size-4.5" />
                      </div>
                      <div>
                        <h3 className="font-semibold">ייבוא שואלים</h3>
                        <p className="mt-0.5 text-xs text-ctp-subtext">
                          הוספה או החלפה של רשימת השואלים מקובץ XLSX
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={!adminActionsEnabled || pending}
                      onClick={() => setBorrowerImportOpen(true)}
                    >
                      ייבוא שואלים מקובץ
                    </button>
                  </section>
                  <section className="action-card">
                    <div className="mb-5 flex items-start gap-3">
                      <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-ctp-blue/10 text-ctp-blue">
                        <Upload className="size-4.5" />
                      </div>
                      <div>
                        <h3 className="font-semibold">ייבוא איפוס שנתי</h3>
                        <p className="mt-0.5 text-xs text-ctp-subtext">
                          משתמש רק בגיליונות Reset ומחליף את כל נתוני המלאי
                        </p>
                      </div>
                    </div>
                    <input
                      ref={resetFileRef}
                      aria-label="בחירת קובץ לייבוא איפוס"
                      className="input-field"
                      type="file"
                      accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                      disabled={!adminActionsEnabled || pending}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file)
                          openInventoryDialog(
                            { kind: 'import', mode: 'reset', file },
                            managementTabRef.current,
                            resetFileRef.current,
                          );
                      }}
                    />
                  </section>
                  <section className="action-card">
                    <div className="mb-5 flex items-start gap-3">
                      <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-ctp-blue/10 text-ctp-blue">
                        <Upload className="size-4.5" />
                      </div>
                      <div>
                        <h3 className="font-semibold">שחזור מלא</h3>
                        <p className="mt-0.5 text-xs text-ctp-subtext">
                          משתמש רק בגיליונות Recovery ומשחזר את הקטלוג וההיסטוריה המלאה
                        </p>
                      </div>
                    </div>
                    <input
                      ref={recoveryFileRef}
                      aria-label="בחירת קובץ לשחזור מלא"
                      className="input-field"
                      type="file"
                      accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                      disabled={!adminActionsEnabled || pending}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file)
                          openInventoryDialog(
                            { kind: 'import', mode: 'recovery', file },
                            managementTabRef.current,
                            recoveryFileRef.current,
                          );
                      }}
                    />
                  </section>
                  {!isAdmin && <PermissionNote />}
                </div>
              )}
            </div>
          </PageSection>
        )}
        {tab === 'ledger' && (
          <PageSection
            title="יומן אירועים"
            description="תיעוד בלתי־ניתן לשינוי של כל תנועות המלאי"
            icon={ClipboardList}
          >
            <DataTable
              rows={ledger}
              columns={ledgerColumns}
              rowKey={(event) => event.id}
              searchText={(event) =>
                join(
                  event.id,
                  event.created_at,
                  event.kind,
                  ledgerEventName(event),
                  event.itemName,
                  event.borrowerName,
                  event.quantity,
                  event.note,
                )
              }
              searchPlaceholder="סינון אירועים…"
              initialSort={{ key: 'id', direction: 'desc' }}
            />
          </PageSection>
        )}
      </main>
      {borrowerCreateOpen && (
        <Dialog
          title="יצירת שואל חדש"
          description="אדם או ארגון שמקבל ציוד"
          level="root"
          role="dialog"
          variant="standard"
          busy={pending}
          dismissible={!pending}
          onClose={() => setBorrowerCreateOpen(false)}
          initialFocusRef={borrowerCreateNameRef}
          returnFocusRef={borrowerCreateTriggerRef}
          returnFocusFallbackRef={managementTabRef}
          actions={
            <>
              <button
                type="button"
                className="secondary-button"
                disabled={pending}
                onClick={() => setBorrowerCreateOpen(false)}
              >
                ביטול
              </button>
              <button
                type="submit"
                form="management-create-borrower-form"
                className="primary-button"
                disabled={pending}
              >
                יצירה
              </button>
            </>
          }
        >
          <form
            id="management-create-borrower-form"
            className="dialog-form"
            onSubmit={(event) => void submitBorrowerCreation(event)}
          >
            <fieldset className="grid gap-3" disabled={pending}>
              <label className="field-label">
                שם
                <input ref={borrowerCreateNameRef} className="input-field" name="name" required />
              </label>
              <Field name="username" label="שם משתמש" ltr />
              <Field name="contact" label="פרטי קשר" />
              <label className="field-label">
                סוג
                <select name="type" className="input-field">
                  <option value="individual">יחיד</option>
                  <option value="camp_organization">ארגון מחנה</option>
                  <option value="other">אחר</option>
                </select>
              </label>
            </fieldset>
          </form>
        </Dialog>
      )}
      {adminDialogOpen && (
        <AdminPasswordDialog
          pending={pending}
          error={adminPasswordError}
          returnFocusRef={adminControlRef}
          onClose={closeAdminDialog}
          onSubmit={(password) => void authenticateAdmin(password)}
          onRecovery={recoveryAvailable ? openAdminRecovery : undefined}
        />
      )}
      {adminRecoveryOpen && recoveryAvailable && (
        <AdminRecoveryDialog
          returnFocusRef={adminControlRef}
          onClose={() => setAdminRecoveryOpen(false)}
          onError={(error) => showError('שחזור סיסמת המנהל', error)}
        />
      )}
      {borrowerDeletionStatus && (
        <Dialog
          title={`למחוק לצמיתות את ${borrowerDeletionStatus.borrower.name}?`}
          description="המחיקה מסירה את השואל, את פרטי הקשר שלו ואת האירועים וההלוואות הסגורות שלו. היא אינה משנה את יתרות המלאי של פריטים שנותרו."
          level="root"
          role="alertdialog"
          variant="destructive"
          busy={pending}
          dismissible={!pending}
          onClose={() => {
            if (!pending) setBorrowerDeletionStatus(null);
          }}
        >
          <div className="space-y-3 text-sm">
            <p>
              {borrowerDeletionStatus.borrower.name} · שם משתמש{' '}
              <bdi dir="ltr">{borrowerDeletionStatus.borrower.username}</bdi>
            </p>
            <p>
              יתרות פתוחות: מושאל {borrowerDeletionStatus.outstanding}, אבוד{' '}
              {borrowerDeletionStatus.lost}.
            </p>
            {(borrowerDeletionStatus.outstanding > 0 || borrowerDeletionStatus.lost > 0) && (
              <p className="dialog-form-error">
                המחיקה חסומה כל עוד לשואל יש יתרות מושאלות או אבודות. יש להסדיר אותן תחילה.
              </p>
            )}
            <div className="dialog-actions dialog-actions-destructive">
              <button
                type="button"
                className="danger-button"
                disabled={
                  pending ||
                  !adminActionsEnabled ||
                  inventoryEpoch == null ||
                  !!borrowerDeletionAttempt ||
                  borrowerDeletionStatus.outstanding > 0 ||
                  borrowerDeletionStatus.lost > 0
                }
                onClick={confirmBorrowerDeletion}
              >
                מחק את השואל וההיסטוריה לצמיתות
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={pending}
                onClick={() => setBorrowerDeletionStatus(null)}
              >
                ביטול
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {activeDialog && (
        <InventoryDialog
          active={activeDialog}
          pending={inventoryDialogPending}
          returnFocusRef={dialogReturnFocusRef}
          fallbackFocusRef={dialogFallbackRef}
          onClose={closeInventoryDialog}
          onSubmit={submitInventoryDialog}
        />
      )}
    </div>
  );
}

function PageSection({
  title,
  description,
  icon: Icon,
  children,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-6 flex items-start gap-3">
        <div className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl bg-ctp-lavender/10 text-ctp-lavender">
          <Icon className="size-5" />
        </div>
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
          <p className="mt-1 text-sm text-ctp-subtext">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}
function ActionCard({
  title,
  description,
  icon: Icon,
  disabled,
  onSubmit,
  children,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  disabled: boolean;
  onSubmit: (form: FormData) => boolean | Promise<boolean>;
  children: ReactNode;
}) {
  return (
    <form
      className="action-card"
      onSubmit={async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (disabled) return;
        const form = event.currentTarget;
        if (await onSubmit(new FormData(form))) form.reset();
      }}
    >
      <fieldset disabled={disabled}>
        <div className="mb-5 flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-ctp-blue/10 text-ctp-blue">
            <Icon className="size-4.5" />
          </div>
          <div>
            <legend className="font-semibold text-ctp-text">{title}</legend>
            <p className="mt-0.5 text-xs text-ctp-subtext">{description}</p>
          </div>
        </div>
        <div className="grid gap-3">
          {children}
          <button className="primary-button mt-1" type="submit">
            בצע פעולה
          </button>
        </div>
      </fieldset>
    </form>
  );
}
function Field({
  name,
  label,
  type = 'text',
  ltr = false,
  required = true,
}: {
  name: string;
  label: string;
  type?: string;
  ltr?: boolean;
  required?: boolean;
}) {
  return (
    <label className="field-label">
      {label}
      <input
        className="input-field"
        required={required}
        name={name}
        type={type}
        dir={ltr ? 'ltr' : undefined}
      />
    </label>
  );
}
function PasswordField({
  name,
  label,
  autoFocus = false,
}: {
  name: string;
  label: string;
  autoFocus?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const form = inputRef.current?.form;
    if (!form) return;
    const conceal = () => setVisible(false);
    form.addEventListener('reset', conceal);
    return () => form.removeEventListener('reset', conceal);
  }, []);
  return (
    <label className="field-label">
      {label}
      <span className="relative">
        <input
          ref={inputRef}
          className="input-field ps-11"
          required
          name={name}
          type={visible ? 'text' : 'password'}
          autoFocus={autoFocus}
          autoComplete="current-password"
          dir="ltr"
        />
        <button
          type="button"
          className="icon-button absolute left-1.5 top-1/2 -translate-y-1/2"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? 'הסתרת סיסמה' : 'הצגת סיסמה'}
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </span>
    </label>
  );
}
function PermissionNote({
  text = 'המסך גלוי לעיון. יש לעבור למצב מנהל כדי לבצע שינויים.',
}: {
  text?: string;
}) {
  return (
    <p className="permission-note">
      <ShieldCheck className="size-4 shrink-0" />
      {text}
    </p>
  );
}
function StatusBadge({
  children,
  tone,
}: {
  children: ReactNode;
  tone: 'blue' | 'mauve' | 'green' | 'neutral';
}) {
  return <span className={`status-badge ${tone}`}>{children}</span>;
}
function SmallButton({
  icon: Icon,
  tone,
  children,
  ...props
}: {
  icon: LucideIcon;
  tone?: 'destructive' | 'warning' | 'positive';
  children: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="small-button" data-tone={tone} {...props}>
      <Icon className="size-3.5" />
      {children}
    </button>
  );
}
function RowActions({
  onEdit,
  onArchive,
  onDelete,
  archived,
  disabled,
}: {
  onEdit: () => void;
  onArchive: () => void;
  onDelete?: () => void;
  archived: boolean;
  disabled: boolean;
}) {
  return (
    <div className="flex gap-1.5">
      <SmallButton icon={Pencil} disabled={disabled} onClick={onEdit}>
        עריכה
      </SmallButton>
      <SmallButton icon={archived ? RotateCcw : Archive} disabled={disabled} onClick={onArchive}>
        {archived ? 'שחזור' : 'ארכוב'}
      </SmallButton>
      <SmallButton
        icon={Trash2}
        tone="destructive"
        disabled={disabled || !onDelete}
        onClick={onDelete}
      >
        מחיקה
      </SmallButton>
    </div>
  );
}
function CatalogBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-ctp-surface bg-white p-4 shadow-sm sm:p-5">
      <h3 className="mb-4 font-semibold">{title}</h3>
      {children}
    </section>
  );
}
