import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Archive,
  ArrowLeftRight,
  BookOpen,
  Boxes,
  ClipboardList,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  LayoutGrid,
  MapPin,
  PackageCheck,
  PackageOpen,
  PackagePlus,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  TriangleAlert,
  Upload,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { AdminModeControl, AdminModeStatus, AdminPasswordDialog } from './AdminMode';
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
  type Loan,
  type Location,
} from './InventoryDialogs';
import { Toast, type ToastMessage, type ToastTone } from './Toast';

type Role = 'operator' | 'admin';
type LedgerEvent = {
  id: number;
  created_at: string;
  kind: string;
  itemCode?: number;
  itemName?: string;
  borrowerName?: string;
  quantity: number;
  note?: string;
};
type Session = { role: Role; deadline: number | null };
type Tab = 'inventory' | 'issue' | 'checkout' | 'returns' | 'catalogs' | 'ledger';
type ManagementTab = 'stock' | 'catalog' | 'borrowers' | 'data' | 'access';

const borrowerTypeNames: Record<Borrower['type'], string> = {
  individual: 'יחיד',
  camp_organization: 'ארגון מחנה',
  other: 'אחר',
};
const itemKindNames: Record<Item['kind'], string> = {
  consumable: 'מתכלה',
  non_consumable: 'מושאל',
  camp_equipment: 'ציוד מחנה',
};
const eventNames: Record<string, string> = {
  stock_added: 'קליטת מלאי',
  stock_removed: 'תיקון מלאי',
  issued: 'ניפוק',
  checked_out: 'השאלה',
  returned_usable: 'החזרה תקינה',
  returned_damaged: 'החזרה פגומה',
  marked_lost: 'סומן כאבוד',
  unmarked_lost: 'בוטל אובדן',
  repaired: 'תיקון',
  written_off: 'גריעה',
};
const navigation: { key: Tab; label: string; icon: LucideIcon }[] = [
  { key: 'issue', label: 'ציוד מתכלה', icon: PackageOpen },
  { key: 'checkout', label: 'השאלה', icon: ArrowLeftRight },
  { key: 'returns', label: 'החזרות', icon: PackageCheck },
  { key: 'inventory', label: 'מלאי', icon: Boxes },
  { key: 'ledger', label: 'יומן', icon: BookOpen },
  { key: 'catalogs', label: 'ניהול', icon: Settings2 },
];
const managementNavigation: {
  key: ManagementTab;
  label: string;
  description: string;
  icon: LucideIcon;
}[] = [
  {
    key: 'stock',
    label: 'מלאי ופגומים',
    description: 'קליטה וטיפול בפגום',
    icon: PackagePlus,
  },
  {
    key: 'catalog',
    label: 'פריטים ומיקומים',
    description: 'מבנה הקטלוג והאחסון',
    icon: LayoutGrid,
  },
  { key: 'borrowers', label: 'שואלים', description: 'אנשים וארגונים', icon: Users },
  { key: 'data', label: 'ייבוא וייצוא', description: 'איפוס ושחזור מקובץ', icon: Download },
  { key: 'access', label: 'הרשאות', description: 'סיסמאות גישה', icon: ShieldCheck },
];

function number(form: FormData, name: string): number {
  return Number(form.get(name));
}
function join(...values: (string | number | null | undefined)[]) {
  return values.filter((value) => value != null).join(' ');
}

export function App() {
  const [session, setSession] = useState<Session>({ role: 'operator', deadline: null });
  const [items, setItems] = useState<Item[]>([]);
  const [borrowers, setBorrowers] = useState<Borrower[]>([]);
  const [catalogItems, setCatalogItems] = useState<Item[]>([]);
  const [catalogBorrowers, setCatalogBorrowers] = useState<Borrower[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [ledger, setLedger] = useState<LedgerEvent[]>([]);
  const [tab, setTab] = useState<Tab>('inventory');
  const [managementTab, setManagementTab] = useState<ManagementTab>('stock');
  const [issueQuery, setIssueQuery] = useState('');
  const [checkoutQuery, setCheckoutQuery] = useState('');
  const [borrowerQuery, setBorrowerQuery] = useState('');
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [pending, setPending] = useState(false);
  const [adminDialogOpen, setAdminDialogOpen] = useState(false);
  const [activeDialog, setActiveDialog] = useState<ActiveDialog | null>(null);
  const [adminPasswordError, setAdminPasswordError] = useState('');
  const [sessionReconciling, setSessionReconciling] = useState(false);
  const [announcement, setAnnouncement] = useState({ id: 0, text: '' });
  const pendingRef = useRef(false);
  const toastIdRef = useRef(0);
  const sessionRequestRef = useRef(0);
  const activityRequestRef = useRef<Promise<void> | null>(null);
  const adminControlRef = useRef<HTMLButtonElement>(null);
  const returnsTabRef = useRef<HTMLButtonElement>(null);
  const managementTabRef = useRef<HTMLButtonElement>(null);
  const dialogReturnFocusRef = useRef<HTMLElement>(null);
  const dialogFallbackRef = useRef<HTMLElement>(null);
  const previousRoleRef = useRef<Role>('operator');
  const imminentAnnouncedRef = useRef(false);
  const resetFileRef = useRef<HTMLInputElement>(null);
  const recoveryFileRef = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(Date.now());
  const remaining =
    session.deadline == null ? null : Math.max(0, Math.ceil((session.deadline - now) / 1000));
  const isAdmin = session.role === 'admin';
  const adminActionsEnabled = isAdmin && !sessionReconciling;
  const activeDialogRequiresAdmin = activeDialog != null && activeDialog.kind !== 'return';
  const inventoryDialogPending = pending || (sessionReconciling && activeDialogRequiresAdmin);

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
    const [current, nextItems, nextBorrowers, nextLoans, allItems, allBorrowers, nextLocations] =
      await Promise.all([
        api<Session>('/session'),
        api<Item[]>('/items'),
        api<Borrower[]>('/borrowers'),
        api<Loan[]>('/loans'),
        api<Item[]>('/items?all=1'),
        api<Borrower[]>('/borrowers?all=1'),
        api<Location[]>('/locations?all=1'),
      ]);
    applySession(current, sessionRequestId);
    setItems(nextItems);
    setBorrowers(nextBorrowers);
    setLoans(nextLoans);
    setCatalogItems(allItems);
    setCatalogBorrowers(allBorrowers);
    setLocations(nextLocations);
    if (tab === 'ledger') setLedger(await api<LedgerEvent[]>('/ledger'));
  }, [applySession, tab]);

  useEffect(() => {
    refresh().catch((error) => showError('טעינת נתוני המלאי', error));
  }, [refresh, showError]);
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
    if (isAdmin || !activeDialog || activeDialog.kind === 'return') return;
    if (activeDialog.kind === 'import') clearImportInput(activeDialog.mode);
    setActiveDialog(null);
  }, [activeDialog, clearImportInput, isAdmin]);
  const issueItems = useMemo(
    () =>
      items.filter(
        (item) =>
          item.kind === 'consumable' &&
          join(item.code, item.name, ...item.aliases)
            .toLocaleLowerCase()
            .includes(issueQuery.toLocaleLowerCase()),
      ),
    [issueQuery, items],
  );
  const checkoutItems = useMemo(
    () =>
      items.filter(
        (item) =>
          item.kind === 'non_consumable' &&
          join(item.code, item.name, ...item.aliases)
            .toLocaleLowerCase()
            .includes(checkoutQuery.toLocaleLowerCase()),
      ),
    [checkoutQuery, items],
  );
  const operationBorrowers = useMemo(
    () =>
      borrowers.filter((borrower) =>
        join(borrower.name, borrower.username)
          .toLocaleLowerCase()
          .includes(borrowerQuery.toLocaleLowerCase()),
      ),
    [borrowers, borrowerQuery],
  );

  async function action(title: string, operation: () => Promise<unknown>) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    try {
      // A pointer/keyboard event may have started a deadline extension immediately
      // before this action. Preserve event order at the API boundary.
      await activityRequestRef.current;
      await operation();
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
  const closeAdminDialog = useCallback(() => {
    setAdminDialogOpen(false);
    setAdminPasswordError('');
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
      case 'return':
        succeeded = await action('החזרת ציוד', () =>
          api('/return', {
            method: 'POST',
            body: JSON.stringify({
              checkoutId: submission.checkoutId,
              usable: submission.usable,
              damaged: submission.damaged,
              note: submission.note,
            }),
          }),
        );
        break;
      case 'lost':
        succeeded = await action(submission.lost ? 'סימון ציוד כאבוד' : 'ביטול סימון אובדן', () =>
          api('/lost', {
            method: 'POST',
            body: JSON.stringify({
              checkoutId: submission.checkoutId,
              quantity: submission.quantity,
              lost: submission.lost,
              note: submission.note,
            }),
          }),
        );
        break;
      case 'edit-item':
        succeeded = await action('עריכת פריט', () =>
          api(`/items/${submission.itemId}`, {
            method: 'PUT',
            body: JSON.stringify({
              name: submission.name,
              aliases: submission.aliases,
              lotSize: submission.lotSize,
              locationId: submission.locationId,
            }),
          }),
        );
        break;
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
      case 'edit-location':
        succeeded = await action('עריכת מיקום', () =>
          api(`/locations/${submission.locationId}`, {
            method: 'PUT',
            body: JSON.stringify({
              name: submission.name,
              code: submission.code,
              archived: submission.archived,
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

  const inventoryColumns: TableColumn<Item>[] = [
    {
      key: 'code',
      label: 'קוד',
      render: (item) => <span className="code-pill">{item.code}</span>,
      sortValue: (item) => item.code,
    },
    {
      key: 'name',
      label: 'פריט',
      render: (item) => (
        <div>
          <strong className="font-medium text-ctp-text">{item.name}</strong>
          {item.aliases.length > 0 && (
            <div className="mt-0.5 text-xs text-ctp-subtext">{item.aliases.join(' · ')}</div>
          )}
        </div>
      ),
      sortValue: (item) => item.name,
    },
    {
      key: 'kind',
      label: 'סוג',
      render: (item) => (
        <StatusBadge
          tone={
            item.kind === 'consumable' ? 'blue' : item.kind === 'non_consumable' ? 'mauve' : 'green'
          }
        >
          {itemKindNames[item.kind]}
        </StatusBadge>
      ),
      sortValue: (item) => item.kind,
    },
    {
      key: 'available',
      label: 'זמין',
      render: (item) => <Metric value={item.available} />,
      sortValue: (item) => item.available,
    },
    {
      key: 'damaged',
      label: 'פגום',
      render: (item) => <Metric value={item.damaged} warning={item.damaged > 0} />,
      sortValue: (item) => item.damaged,
    },
  ];
  const loanColumns: TableColumn<Loan>[] = [
    {
      key: 'code',
      label: 'קוד',
      render: (loan) => <span className="code-pill">{loan.code}</span>,
      sortValue: (loan) => loan.code,
    },
    {
      key: 'item',
      label: 'פריט',
      render: (loan) => loan.itemName,
      sortValue: (loan) => loan.itemName,
    },
    {
      key: 'borrower',
      label: 'שואל',
      render: (loan) => loan.borrowerName,
      sortValue: (loan) => loan.borrowerName,
    },
    {
      key: 'outstanding',
      label: 'בחוץ',
      render: (loan) => <Metric value={loan.outstanding} />,
      sortValue: (loan) => loan.outstanding,
    },
    {
      key: 'lost',
      label: 'אבוד',
      render: (loan) => <Metric value={loan.lost} warning={loan.lost > 0} />,
      sortValue: (loan) => loan.lost,
    },
    {
      key: 'actions',
      label: 'פעולות',
      render: (loan) => (
        <div className="flex flex-wrap gap-1.5">
          <SmallButton
            icon={RotateCcw}
            disabled={pending || loan.outstanding < 1}
            onClick={() => openInventoryDialog({ kind: 'return', loan }, returnsTabRef.current)}
          >
            החזרה
          </SmallButton>
          <SmallButton
            icon={TriangleAlert}
            disabled={pending || !adminActionsEnabled || loan.outstanding < 1}
            onClick={() =>
              openInventoryDialog({ kind: 'lost', loan, lost: true }, returnsTabRef.current)
            }
          >
            סמן אבוד
          </SmallButton>
          <SmallButton
            icon={RotateCcw}
            disabled={pending || !adminActionsEnabled || loan.lost < 1}
            onClick={() =>
              openInventoryDialog({ kind: 'lost', loan, lost: false }, returnsTabRef.current)
            }
          >
            בטל אובדן
          </SmallButton>
        </div>
      ),
    },
  ];
  const itemCatalogColumns: TableColumn<Item>[] = [
    {
      key: 'code',
      label: 'קוד',
      render: (item) => <span className="code-pill">{item.code}</span>,
      sortValue: (item) => item.code,
    },
    { key: 'name', label: 'פריט', render: (item) => item.name, sortValue: (item) => item.name },
    {
      key: 'status',
      label: 'מצב',
      render: (item) => (
        <StatusBadge tone={item.archived ? 'neutral' : 'green'}>
          {item.archived ? 'בארכיון' : 'פעיל'}
        </StatusBadge>
      ),
      sortValue: (item) => Number(item.archived),
    },
    {
      key: 'actions',
      label: 'פעולות',
      render: (item) => (
        <RowActions
          onEdit={() => openInventoryDialog({ kind: 'edit-item', item }, managementTabRef.current)}
          archived={item.archived}
          disabled={pending || !adminActionsEnabled}
          onArchive={() =>
            void action(item.archived ? 'הוצאת פריט מהארכיון' : 'העברת פריט לארכיון', () =>
              api(`/items/${item.id}/archive`, {
                method: 'POST',
                body: JSON.stringify({ archived: !item.archived }),
              }),
            )
          }
        />
      ),
    },
  ];
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
        />
      ),
    },
  ];
  const locationColumns: TableColumn<Location>[] = [
    {
      key: 'name',
      label: 'מיקום',
      render: (location) => location.name,
      sortValue: (location) => location.name,
    },
    {
      key: 'code',
      label: 'קוד',
      render: (location) => <span className="code-pill">{location.code}</span>,
      sortValue: (location) => location.code,
    },
    {
      key: 'status',
      label: 'מצב',
      render: (location) => (
        <StatusBadge tone={location.archived ? 'neutral' : 'green'}>
          {location.archived ? 'בארכיון' : 'פעיל'}
        </StatusBadge>
      ),
      sortValue: (location) => Number(location.archived),
    },
    {
      key: 'actions',
      label: 'פעולות',
      render: (location) => (
        <RowActions
          archived={location.archived}
          disabled={pending || !adminActionsEnabled}
          onEdit={() =>
            openInventoryDialog({ kind: 'edit-location', location }, managementTabRef.current)
          }
          onArchive={() =>
            void action(location.archived ? 'הוצאת מיקום מהארכיון' : 'העברת מיקום לארכיון', () =>
              api(`/locations/${location.id}`, {
                method: 'PUT',
                body: JSON.stringify({ ...location, archived: !location.archived }),
              }),
            )
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
      render: (event) => (
        <StatusBadge tone="blue">{eventNames[event.kind] ?? event.kind}</StatusBadge>
      ),
      sortValue: (event) => event.kind,
    },
    {
      key: 'item',
      label: 'פריט',
      render: (event) => (
        <>
          <span className="code-pill me-1">{event.itemCode ?? '—'}</span>
          {event.itemName}
        </>
      ),
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
      <header className="app-header" data-dialog-background>
        <div className="app-header-inner">
          <div className="app-brand">
            <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-ctp-lavender text-white shadow-sm">
              <Boxes className="size-6" />
            </div>
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
      <nav className="app-nav" aria-label="ניווט ראשי" data-dialog-background>
        <div className="mx-auto flex max-w-screen-2xl items-center gap-1 overflow-x-auto px-3 py-2 sm:px-6 lg:px-8">
          {navigation.map(({ key, label, icon: Icon }) => (
            <div className="contents" key={key}>
              {key === 'inventory' && <span className="nav-separator" aria-hidden="true" />}
              <button
                ref={
                  key === 'returns'
                    ? returnsTabRef
                    : key === 'catalogs'
                      ? managementTabRef
                      : undefined
                }
                className={`nav-item ${tab === key ? 'active' : ''}`}
                aria-current={tab === key ? 'page' : undefined}
                onClick={() => setTab(key)}
              >
                <Icon className="size-4" />
                {label}
              </button>
            </div>
          ))}
        </div>
      </nav>
      <div
        key={`announcement-${announcement.id}`}
        data-dialog-background
        className="sr-only"
        role="status"
        aria-live={isAdmin && remaining != null && remaining <= 10 ? 'assertive' : 'polite'}
        aria-atomic="true"
      >
        {announcement.text}
      </div>
      {toast && <Toast key={`toast-${toast.id}`} toast={toast} onDismiss={dismissToast} />}
      <main
        className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8"
        data-dialog-background
      >
        {tab === 'inventory' && (
          <PageSection
            title="מצב מלאי"
            description="תמונת מצב עדכנית של כל הציוד הזמין"
            icon={Boxes}
          >
            <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="סוגי פריטים" value={items.length} icon={PackageOpen} />
              <StatCard
                label="יחידות זמינות"
                value={items.reduce((sum, item) => sum + item.available, 0)}
                icon={PackageCheck}
              />
              <StatCard
                label="יחידות פגומות"
                value={items.reduce((sum, item) => sum + item.damaged, 0)}
                icon={TriangleAlert}
                warning
              />
              <StatCard
                label="ציוד בהשאלה"
                value={loans.reduce((sum, loan) => sum + loan.outstanding, 0)}
                icon={ArrowLeftRight}
              />
            </div>
            <DataTable
              rows={items}
              columns={inventoryColumns}
              rowKey={(item) => item.id}
              searchText={(item) => join(item.code, item.name, item.kind, ...item.aliases)}
              searchPlaceholder="סינון לפי שם, כינוי, סוג או קוד…"
            />
          </PageSection>
        )}
        {tab === 'issue' && (
          <PageSection title="ציוד מתכלה" description="ניפוק ציוד מתכלה מהמלאי" icon={PackageOpen}>
            <div className="mb-5 rounded-2xl border border-ctp-surface bg-white p-4">
              <SearchField
                label="סינון פריטים"
                value={issueQuery}
                onChange={setIssueQuery}
                placeholder="שם, כינוי או קוד"
              />
            </div>
            <div className="grid gap-4">
              <ActionCard
                title="ניפוק מתכלה"
                description="הוצאה קבועה מהמלאי"
                icon={PackageOpen}
                disabled={pending}
                onSubmit={(form) =>
                  void action('ניפוק מתכלה', () =>
                    api('/issue', {
                      method: 'POST',
                      body: JSON.stringify({
                        itemId: number(form, 'itemId'),
                        quantity: number(form, 'quantity'),
                        note: form.get('note'),
                      }),
                    }),
                  )
                }
              >
                <Select
                  name="itemId"
                  label="פריט"
                  options={issueItems.map((item) => [
                    item.id,
                    `${item.code} — ${item.name} (${item.available})`,
                  ])}
                />
                <Quantity />
                <Note />
              </ActionCard>
            </div>
          </PageSection>
        )}
        {tab === 'checkout' && (
          <PageSection title="השאלה" description="השאלת ציוד לשואל עד להחזרה" icon={ArrowLeftRight}>
            <div className="mb-5 grid gap-3 rounded-2xl border border-ctp-surface bg-white p-4 sm:grid-cols-2">
              <SearchField
                label="סינון פריטים"
                value={checkoutQuery}
                onChange={setCheckoutQuery}
                placeholder="שם, כינוי או קוד"
              />
              <SearchField
                label="סינון שואלים"
                value={borrowerQuery}
                onChange={setBorrowerQuery}
                placeholder="שם או שם משתמש"
              />
            </div>
            <div className="grid gap-4">
              <ActionCard
                title="השאלת ציוד"
                description="שיוך ציוד לשואל עד להחזרה"
                icon={ArrowLeftRight}
                disabled={pending}
                onSubmit={(form) =>
                  void action('השאלת ציוד', () =>
                    api('/checkout', {
                      method: 'POST',
                      body: JSON.stringify({
                        itemId: number(form, 'itemId'),
                        borrowerId: number(form, 'borrowerId'),
                        quantity: number(form, 'quantity'),
                        note: form.get('note'),
                      }),
                    }),
                  )
                }
              >
                <Select
                  name="itemId"
                  label="פריט"
                  options={checkoutItems.map((item) => [
                    item.id,
                    `${item.code} — ${item.name} (${item.available})`,
                  ])}
                />
                <Select
                  name="borrowerId"
                  label="שואל"
                  options={operationBorrowers.map((borrower) => [
                    borrower.id,
                    `${borrower.name} · ${borrower.username}`,
                  ])}
                />
                <Quantity />
                <Note />
              </ActionCard>
            </div>
          </PageSection>
        )}
        {tab === 'returns' && (
          <PageSection
            title="ציוד בחוץ"
            description="מעקב והחזרה של ציוד מושאל"
            icon={PackageCheck}
          >
            <DataTable
              rows={loans}
              columns={loanColumns}
              rowKey={(loan) => loan.checkoutId}
              searchText={(loan) =>
                join(loan.code, loan.itemName, loan.borrowerName, loan.outstanding, loan.lost)
              }
              searchPlaceholder="סינון לפי פריט, שואל או קוד…"
            />
          </PageSection>
        )}
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
                  onClick={() => setManagementTab(key)}
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
              {managementTab === 'stock' && (
                <>
                  <div className="grid gap-4 lg:grid-cols-2">
                    <ActionCard
                      title="הוספת מלאי"
                      description="קליטת יחידות חדשות"
                      icon={PackagePlus}
                      disabled={!adminActionsEnabled || pending}
                      onSubmit={(form) =>
                        void action('הוספת מלאי', () =>
                          api('/stock/add', {
                            method: 'POST',
                            body: JSON.stringify({
                              itemId: number(form, 'itemId'),
                              quantity: number(form, 'quantity'),
                              note: form.get('note'),
                            }),
                          }),
                        )
                      }
                    >
                      <Select
                        name="itemId"
                        label="פריט"
                        options={items.map((item) => [item.id, `${item.code} — ${item.name}`])}
                      />
                      <Quantity />
                      <Note />
                    </ActionCard>
                    <ActionCard
                      title="טיפול בפגום"
                      description="החזרה לשימוש או גריעה"
                      icon={TriangleAlert}
                      disabled={!adminActionsEnabled || pending}
                      onSubmit={(form) => {
                        const resolution = form.get('resolution');
                        void action(
                          resolution === 'repair'
                            ? 'תיקון פריט פגום'
                            : resolution === 'write_off'
                              ? 'גריעת פריט פגום'
                              : 'טיפול בפריט פגום',
                          () =>
                            api('/damage', {
                              method: 'POST',
                              body: JSON.stringify({
                                itemId: number(form, 'itemId'),
                                quantity: number(form, 'quantity'),
                                resolution: form.get('resolution'),
                                note: form.get('note'),
                              }),
                            }),
                        );
                      }}
                    >
                      <Select
                        name="itemId"
                        label="פריט"
                        options={items
                          .filter((item) => item.damaged > 0)
                          .map((item) => [
                            item.id,
                            `${item.code} — ${item.name} (${item.damaged})`,
                          ])}
                      />
                      <Quantity />
                      <label className="field-label">
                        פתרון
                        <select name="resolution" className="input-field">
                          <option value="repair">תוקן</option>
                          <option value="write_off">הוצאה מהמלאי</option>
                        </select>
                      </label>
                      <Note />
                    </ActionCard>
                  </div>
                  {!isAdmin && <PermissionNote />}
                </>
              )}
              {managementTab === 'catalog' && (
                <div className="space-y-7">
                  <div className="grid gap-4 lg:grid-cols-2">
                    <ActionCard
                      title="פריט חדש"
                      description="הוספת סוג ציוד לקטלוג"
                      icon={Plus}
                      disabled={!adminActionsEnabled || pending}
                      onSubmit={(form) =>
                        void action('הוספת פריט חדש', () =>
                          api('/items', {
                            method: 'POST',
                            body: JSON.stringify({
                              name: form.get('name'),
                              kind: form.get('kind'),
                              lotSize: form.get('lotSize') ? number(form, 'lotSize') : null,
                              locationId: form.get('locationId')
                                ? number(form, 'locationId')
                                : null,
                              aliases: String(form.get('aliases') ?? '')
                                .split(',')
                                .map((alias) => alias.trim())
                                .filter(Boolean),
                            }),
                          }),
                        )
                      }
                    >
                      <Field name="name" label="שם" />
                      <label className="field-label">
                        סוג
                        <select name="kind" className="input-field">
                          <option value="consumable">מתכלה</option>
                          <option value="non_consumable">מושאל</option>
                          <option value="camp_equipment">ציוד מחנה</option>
                        </select>
                      </label>
                      <Field
                        name="lotSize"
                        label="גודל מארז (רשות)"
                        type="number"
                        required={false}
                      />
                      <Field name="aliases" label="כינויים, מופרדים בפסיק" required={false} />
                      <Select
                        name="locationId"
                        label="מיקום"
                        required={false}
                        emptyLabel="ללא מיקום"
                        options={locations
                          .filter((location) => !location.archived)
                          .map((location) => [location.id, location.name])}
                      />
                    </ActionCard>
                    <ActionCard
                      title="מיקום חדש"
                      description="אזור אחסון שניתן לשייך לפריטים"
                      icon={MapPin}
                      disabled={!adminActionsEnabled || pending}
                      onSubmit={(form) =>
                        void action('הוספת מיקום חדש', () =>
                          api('/locations', {
                            method: 'POST',
                            body: JSON.stringify({
                              code: form.get('code'),
                              name: form.get('name'),
                            }),
                          }),
                        )
                      }
                    >
                      <Field name="name" label="שם בעברית" />
                      <Field name="code" label="קוד" ltr />
                    </ActionCard>
                  </div>
                  <CatalogBlock title="קטלוג פריטים">
                    <DataTable
                      rows={catalogItems}
                      columns={itemCatalogColumns}
                      rowKey={(item) => item.id}
                      searchText={(item) =>
                        join(
                          item.code,
                          item.name,
                          item.archived ? 'ארכיון' : 'פעיל',
                          ...item.aliases,
                        )
                      }
                      searchPlaceholder="סינון פריטים…"
                    />
                  </CatalogBlock>
                  <CatalogBlock title="מיקומים">
                    <DataTable
                      rows={locations}
                      columns={locationColumns}
                      rowKey={(location) => location.id}
                      searchText={(location) =>
                        join(location.name, location.code, location.archived ? 'ארכיון' : 'פעיל')
                      }
                      searchPlaceholder="סינון מיקומים…"
                    />
                  </CatalogBlock>
                  {!isAdmin && <PermissionNote />}
                </div>
              )}
              {managementTab === 'borrowers' && (
                <div className="space-y-7">
                  <div className="max-w-2xl">
                    <ActionCard
                      title="שואל חדש"
                      description="אדם או ארגון שמקבל ציוד"
                      icon={UserPlus}
                      disabled={pending}
                      onSubmit={(form) =>
                        void action('הוספת שואל חדש', () =>
                          api('/borrowers', {
                            method: 'POST',
                            body: JSON.stringify({
                              username: form.get('username'),
                              name: form.get('name'),
                              contact: form.get('contact'),
                              type: form.get('type'),
                            }),
                          }),
                        )
                      }
                    >
                      <Field name="name" label="שם" />
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
                    </ActionCard>
                  </div>
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
                <div className="max-w-2xl">
                  <ActionCard
                    title="החלפת סיסמה"
                    description="עדכון הסיסמה לכניסה למצב מנהל"
                    icon={KeyRound}
                    disabled={!adminActionsEnabled || pending}
                    onSubmit={(form) =>
                      void action('החלפת סיסמה', () =>
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
                    onSubmit={() => void action('ייצוא מלאי', downloadInventoryWorkbook)}
                  >
                    <p className="text-sm text-ctp-subtext">
                      הקובץ כולל אזורי איפוס ושחזור נפרדים. שמרו אותו במקום מאובטח.
                    </p>
                  </ActionCard>
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
                  eventNames[event.kind],
                  event.itemCode,
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
      {adminDialogOpen && (
        <AdminPasswordDialog
          pending={pending}
          error={adminPasswordError}
          returnFocusRef={adminControlRef}
          onClose={closeAdminDialog}
          onSubmit={(password) => void authenticateAdmin(password)}
        />
      )}
      {activeDialog && (
        <InventoryDialog
          active={activeDialog}
          pending={inventoryDialogPending}
          locations={locations}
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
function StatCard({
  label,
  value,
  icon: Icon,
  warning = false,
}: {
  label: string;
  value: number;
  icon: LucideIcon;
  warning?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-ctp-surface bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ctp-subtext">{label}</span>
        <Icon
          className={`size-4 ${warning && value > 0 ? 'text-ctp-peach' : 'text-ctp-lavender'}`}
        />
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums">{value}</div>
    </div>
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
  onSubmit: (form: FormData) => void;
  children: ReactNode;
}) {
  return (
    <form
      className="action-card"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        onSubmit(new FormData(event.currentTarget));
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
  return (
    <label className="field-label">
      {label}
      <span className="relative">
        <input
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
function Quantity() {
  return <Field name="quantity" label="כמות" type="number" />;
}
function Note({ label = 'הערה (רשות)' }: { label?: string }) {
  return <Field name="note" label={label} required={false} />;
}
function Select({
  name,
  label,
  options,
  required = true,
  emptyLabel = 'בחירה…',
}: {
  name: string;
  label: string;
  options: [number, string][];
  required?: boolean;
  emptyLabel?: string;
}) {
  return (
    <label className="field-label">
      {label}
      <select required={required} name={name} className="input-field">
        <option value="">{emptyLabel}</option>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
function SearchField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="field-label">
      {label}
      <span className="relative">
        <Search className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ctp-overlay" />
        <input
          className="input-field pe-10"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
      </span>
    </label>
  );
}
function PermissionNote() {
  return (
    <p className="permission-note">
      <ShieldCheck className="size-4 shrink-0" />
      המסך גלוי לעיון. יש לעבור למצב מנהל כדי לבצע שינויים.
    </p>
  );
}
function Metric({ value, warning = false }: { value: number; warning?: boolean }) {
  return (
    <span className={`font-semibold tabular-nums ${warning ? 'text-ctp-red' : 'text-ctp-text'}`}>
      {value}
    </span>
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
  children,
  ...props
}: { icon: LucideIcon; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="small-button" {...props}>
      <Icon className="size-3.5" />
      {children}
    </button>
  );
}
function RowActions({
  onEdit,
  onArchive,
  archived,
  disabled,
}: {
  onEdit: () => void;
  onArchive: () => void;
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
