import { StickyTable } from './StickyTable';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Archive, Pencil, RotateCcw, Trash2, TriangleAlert } from 'lucide-react';
import { ApiError, api } from './api';
import { DataTable, type TableColumn } from './DataTable';
import { Dialog } from './Dialog';
import type { Item, Location } from './InventoryDialogs';
import type { ToastTone } from './Toast';
import {
  MANAGEMENT_ATTEMPT_STORAGE_KEY,
  clearFrozenManagementAttempt,
  persistFrozenManagementAttempt,
  readFrozenManagementAttempt,
  readFrozenManagementAttempts,
  safeWindowStorage,
  type FrozenManagementAttempt,
} from './borrower-workflow-recovery.js';

type Editor =
  | { kind: 'item'; item: Item | null }
  | { kind: 'damage'; item: Item }
  | { kind: 'transfer'; item: Item }
  | { kind: 'locations' };
type Draft = {
  name: string;
  kind: Item['kind'];
  aliases: string;
  locationId: string;
  lotSize: string;
  available: string;
  note: string;
};
type Attempt = {
  path: string;
  method: 'POST' | 'PUT';
  body: Record<string, unknown>;
  description?: string;
};

const kinds: Record<Item['kind'], string> = {
  consumable: 'מתכלה',
  non_consumable: 'מושאל',
  camp_equipment: 'ציוד מחנה',
};
const kindTones: Record<Item['kind'], 'blue' | 'mauve' | 'green'> = {
  consumable: 'blue',
  non_consumable: 'mauve',
  camp_equipment: 'green',
};
const itemDraft = (item: Item | null): Draft => ({
  name: item?.name ?? '',
  kind: item?.kind ?? 'consumable',
  aliases: item?.aliases.join(', ') ?? '',
  locationId: '',
  lotSize: item?.lotSize?.toString() ?? '',
  available: '0',
  note: '',
});
const safeInteger = (text: string, min: number) =>
  /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) >= min;

export function InventoryManagement({
  items,
  locations,
  ledgerEpoch,
  admin,
  onRefresh,
  showToast,
  registerLeaveGuard,
}: {
  items: Item[];
  locations: Location[];
  ledgerEpoch: number | null;
  admin: boolean;
  onRefresh: () => Promise<void>;
  showToast: (title: string, message: string, tone: ToastTone) => void;
  registerLeaveGuard: (guard: ((continueNavigation: () => void) => boolean) | null) => void;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [view, setView] = useState<'inventory' | 'locations'>('inventory');
  const [editorEpoch, setEditorEpoch] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>(itemDraft(null));
  const [damageQuantity, setDamageQuantity] = useState('1');
  const [damageNote, setDamageNote] = useState('');
  const [damageLocationId, setDamageLocationId] = useState('');
  const [transferDestination, setTransferDestination] = useState('');
  const [transferCondition, setTransferCondition] = useState<'usable' | 'damaged'>('usable');
  const [resolution, setResolution] = useState<'repair' | 'write_off'>('repair');
  const [locationEdit, setLocationEdit] = useState<Location | 'new' | null>(null);
  const [locationName, setLocationName] = useState('');
  const [locationCode, setLocationCode] = useState('');
  const [locationDefault, setLocationDefault] = useState(false);
  const [locationQuery, setLocationQuery] = useState('');
  const [dirty, setDirty] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState<Item | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Item | null>(null);
  const [locationRetirement, setLocationRetirement] = useState<{
    location: Location;
    action: 'archive' | 'delete';
    items: Item[];
  } | null>(null);
  const [replacementLocationId, setReplacementLocationId] = useState('');
  const [pending, setPending] = useState(false);
  const [unresolved, setUnresolved] = useState<Attempt | null>(() =>
    readFrozenManagementAttempt(safeWindowStorage()),
  );
  const [refreshRecovery, setRefreshRecovery] = useState(false);
  const [recoveryDescription, setRecoveryDescription] = useState('');
  const [reviewSnapshot, setReviewSnapshot] = useState<number | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [currentBalances, setCurrentBalances] = useState<Item | null>(null);
  const [typeFilter, setTypeFilter] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const fallbackRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef(false);
  const refreshPendingRef = useRef(false);
  const pendingNavigationRef = useRef<(() => void) | null>(null);
  const pendingEditorChangeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    registerLeaveGuard((continueNavigation) => {
      if (pendingRef.current || unresolved || refreshRecovery) return false;
      if (!editor || !dirty) return true;
      pendingNavigationRef.current = continueNavigation;
      setDiscardOpen(true);
      return false;
    });
    return () => registerLeaveGuard(null);
  }, [dirty, editor, refreshRecovery, registerLeaveGuard, unresolved]);

  useEffect(() => {
    if (!deleteConfirm) return;
    const current = items.find((item) => item.id === deleteConfirm.id);
    if (current !== deleteConfirm) setDeleteConfirm(current ?? null);
  }, [deleteConfirm, items]);

  function open(next: Editor) {
    if (pendingRef.current || unresolved || refreshRecovery) return;
    if (editor && dirty) {
      pendingEditorChangeRef.current = () => openEditor(next);
      setDiscardOpen(true);
      return;
    }
    openEditor(next);
  }
  function openEditor(next: Editor) {
    triggerRef.current = document.activeElement as HTMLElement;
    setEditor(next);
    setEditorEpoch(ledgerEpoch);
    setLocationEdit(null);
    setDirty(false);
    setRecoveryDescription('');
    setReviewSnapshot(null);
    setReviewRequired(false);
    setCurrentBalances(null);
    if (next.kind === 'item') {
      const initial = itemDraft(next.item);
      const defaultLocation = locations.find(
        (location) => location.isDefault && !location.archived,
      );
      const balance =
        next.item?.balances.find((placement) => placement.locationId === defaultLocation?.id) ??
        next.item?.balances[0];
      setDraft(
        balance
          ? {
              ...initial,
              locationId: String(balance.locationId),
              available: String(balance.available),
            }
          : initial,
      );
    }
    if (next.kind === 'transfer') {
      setDamageLocationId('');
      setTransferDestination('');
      setDamageQuantity('1');
      setDamageNote('');
      setTransferCondition('usable');
    }
    if (next.kind === 'damage') {
      setDamageLocationId('');
      setDamageQuantity('1');
      setDamageNote('');
      setResolution('repair');
    }
  }
  function close() {
    if (pendingRef.current || unresolved || refreshRecovery) return;
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    setEditor(null);
  }
  function discard() {
    setDiscardOpen(false);
    setDirty(false);
    const edit = pendingEditorChangeRef.current;
    pendingEditorChangeRef.current = null;
    if (edit) {
      edit();
      return;
    }
    setLocationEdit(null);
    queueMicrotask(() => setEditor(null));
    const next = pendingNavigationRef.current;
    pendingNavigationRef.current = null;
    if (next) queueMicrotask(next);
  }
  async function refreshAfterCommit(description = recoveryDescription, recoveryCleared = true) {
    if (refreshPendingRef.current) return;
    refreshPendingRef.current = true;
    setPending(true);
    try {
      await onRefresh();
      setRefreshRecovery(false);
      setRecoveryDescription('');
      setDirty(false);
      setLocationEdit(null);
      setEditor(null);
      setDeleteConfirm(null);
      setLocationRetirement(null);
      showToast(
        recoveryCleared ? 'המלאי עודכן' : 'השינוי נשמר',
        recoveryCleared
          ? 'השינוי נשמר בהצלחה'
          : 'לא ניתן לנקות את ניסיון השחזור. יש לבדוק שוב את אותה פעולה לפני שינוי נוסף.',
        recoveryCleared ? 'success' : 'warning',
      );
    } catch (error) {
      setRefreshRecovery(true);
      setRecoveryDescription(description);
      showToast(
        'השינוי נשמר',
        error instanceof Error ? `רענון נכשל: ${error.message}` : 'רענון הנתונים נכשל',
        'warning',
      );
    } finally {
      refreshPendingRef.current = false;
      setPending(false);
    }
  }
  async function send(attempt: Attempt) {
    if (pendingRef.current || refreshRecovery || (unresolved && unresolved !== attempt)) return;
    const storage = safeWindowStorage();
    if (!storage) {
      showToast('לא ניתן לשמור את הפעולה', 'אחסון הדפדפן אינו זמין כרגע', 'error');
      return;
    }
    const frozen: FrozenManagementAttempt = {
      version: 1,
      key: String(attempt.body.key ?? ''),
      path: attempt.path,
      method: attempt.method,
      body: attempt.body,
      ...(attempt.description ? { description: attempt.description } : {}),
    };
    const otherAttempt = readFrozenManagementAttempts(storage).find(
      (saved) => saved.key !== frozen.key,
    );
    const retryingCurrentAttempt = String(unresolved?.body.key ?? '') === frozen.key;
    if (otherAttempt && !retryingCurrentAttempt) {
      setUnresolved(otherAttempt);
      showToast(
        'פעולה קודמת ממתינה לבדיקה',
        'יש לבדוק תחילה את אותה פעולה לפני שליחת שינוי נוסף',
        'warning',
      );
      return;
    }
    if (!persistFrozenManagementAttempt(storage, frozen)) {
      showToast('לא ניתן לשמור את הפעולה', 'בדוק את שטח האחסון בדפדפן לפני שליחה', 'error');
      return;
    }
    const clearAttempt = (): boolean => {
      const cleared = clearFrozenManagementAttempt(
        safeWindowStorage(),
        MANAGEMENT_ATTEMPT_STORAGE_KEY,
        frozen.key,
      );
      if (cleared) setUnresolved(readFrozenManagementAttempt(safeWindowStorage()));
      else setUnresolved(attempt);
      return cleared;
    };
    pendingRef.current = true;
    setPending(true);
    try {
      await api(attempt.path, { method: attempt.method, body: JSON.stringify(attempt.body) });
      const recoveryCleared = clearAttempt();
      setDeleteConfirm(null);
      setLocationRetirement(null);
      await refreshAfterCommit(attempt.description, recoveryCleared);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'stale_stock' && editor?.kind === 'item') {
        if (!clearAttempt()) {
          showToast(
            'הפעולה נדחתה',
            'אחסון השחזור אינו זמין. יש לבדוק שוב את אותה פעולה לפני שינוי נוסף.',
            'warning',
          );
          return;
        }
        setReviewRequired(true);
        setCurrentBalances(null);
        setReviewSnapshot(null);
        try {
          const latest = await api<Item[]>('/items?all=1');
          setCurrentBalances(latest.find((item) => item.id === editor.item?.id) ?? null);
        } catch {
          /* The original draft remains available. */
        }
        showToast('המלאי השתנה', 'יש לבדוק את היתרות העדכניות לפני שמירת הכמות', 'warning');
      } else if (
        error instanceof ApiError &&
        error.code === 'stale_stock' &&
        (editor?.kind === 'transfer' || editor?.kind === 'damage')
      ) {
        if (!clearAttempt()) {
          showToast(
            'הפעולה נדחתה',
            'אחסון השחזור אינו זמין. יש לבדוק שוב את אותה פעולה לפני שינוי נוסף.',
            'warning',
          );
          return;
        }
        setEditor(null);
        setDirty(false);
        try {
          await onRefresh();
        } catch {
          showToast('רענון נכשל', 'יש לרענן את הנתונים לפני פתיחת הפעולה מחדש', 'error');
        }
        showToast('המלאי השתנה', 'יש לפתוח את הפעולה מחדש ולבדוק את היתרות העדכניות', 'warning');
      } else if (error instanceof ApiError && error.status < 500) {
        clearAttempt();
        if (error.code === 'confirmation_changed') {
          setDeleteConfirm(null);
          setLocationRetirement(null);
          try {
            await onRefresh();
          } catch {
            showToast('רענון נכשל', 'יש לרענן את הנתונים לפני אישור מחדש', 'error');
          }
          showToast('נדרשת בדיקה מחדש', error.message, 'warning');
        } else {
          if (error.code === 'deletion_ineligible') {
            try {
              await onRefresh();
            } catch {
              /* The blocking balances are still reported by the command. */
            }
          }
          showToast('השמירה נדחתה', error.message, 'error');
        }
      } else {
        setUnresolved(attempt);
        setDeleteConfirm(null);
        setLocationRetirement(null);
        showToast(
          'תוצאת הפעולה אינה ידועה',
          'יש לבדוק שוב את אותה פעולה לפני שינוי נוסף',
          'warning',
        );
      }
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  function saveItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      editor?.kind !== 'item' ||
      !admin ||
      editorEpoch === null ||
      pending ||
      unresolved ||
      refreshRecovery
    )
      return;
    if (
      !draft.locationId ||
      !draft.name.trim() ||
      draft.name.trim().length > 100 ||
      !safeInteger(draft.available, 0) ||
      (draft.lotSize !== '' && !safeInteger(draft.lotSize, 1))
    ) {
      showToast('פרטים לא תקינים', 'יש לבדוק את השם, הכמות וגודל המארז', 'error');
      return;
    }
    const item = editor.item;
    const countChanged =
      !item ||
      Number(draft.available) !==
        (item.balances.find((p) => p.locationId === Number(draft.locationId))?.available ?? 0);
    if (countChanged && reviewRequired && reviewSnapshot === null) {
      showToast('נדרשת בדיקה', 'יש לאשר את היתרות העדכניות', 'warning');
      return;
    }
    void send({
      path: item ? `/inventory/items/${item.id}` : '/inventory/items',
      method: item ? 'PUT' : 'POST',
      body: {
        key: crypto.randomUUID(),
        ledgerEpoch: editorEpoch,
        name: draft.name.trim(),
        ...(!item ? { kind: draft.kind } : {}),
        aliases: draft.aliases
          .split(',')
          .map((alias) => alias.trim())
          .filter(Boolean),
        lotSize: draft.kind === 'consumable' && draft.lotSize ? Number(draft.lotSize) : null,
        locationId: draft.locationId ? Number(draft.locationId) : null,
        ...(countChanged
          ? {
              targetAvailable: Number(draft.available),
              stockRevision: item ? (reviewSnapshot ?? item.stockRevision) : undefined,
              note: draft.note,
            }
          : {}),
      },
    });
  }
  function saveDamage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      editor?.kind !== 'damage' ||
      editorEpoch === null ||
      pending ||
      unresolved ||
      refreshRecovery
    )
      return;
    if (
      !safeInteger(damageQuantity, 1) ||
      Number(damageQuantity) >
        (editor.item.balances.find((p) => p.locationId === Number(damageLocationId))?.damaged ?? 0)
    ) {
      showToast('כמות לא תקינה', 'יש להזין כמות שלמה בין 1 ליתרה הפגומה', 'error');
      return;
    }
    if (resolution === 'write_off' && !admin) {
      showToast('אין הרשאה לגריעה', 'אפשר לבחור החזרה לשימוש במפורש', 'error');
      return;
    }
    void send({
      path: '/inventory/damage',
      method: 'POST',
      body: {
        key: crypto.randomUUID(),
        ledgerEpoch: editorEpoch,
        itemId: editor.item.id,
        locationId: Number(damageLocationId),
        stockRevision: editor.item.stockRevision,
        quantity: Number(damageQuantity),
        resolution,
        note: damageNote,
      },
    });
  }
  function archiveItem(item: Item) {
    if (!admin || editorEpoch === null || pendingRef.current) return;
    void send({
      path: `/inventory/items/${item.id}/archive`,
      method: 'POST',
      body: {
        key: crypto.randomUUID(),
        ledgerEpoch: editorEpoch,
        archived: !item.archived,
        ...(!item.archived
          ? {}
          : { locationId: draft.locationId ? Number(draft.locationId) : null }),
      },
    });
  }
  function deleteItem(item: Item) {
    if (!admin || ledgerEpoch === null || pendingRef.current || unresolved || refreshRecovery)
      return;
    void send({
      path: `/inventory/items/${item.id}/delete`,
      method: 'POST',
      body: {
        key: crypto.randomUUID(),
        ledgerEpoch,
        expectedStockRevision: item.stockRevision,
        expectedName: item.name,
      },
      description: `מחיקת פריט: ${item.name}`,
    });
  }
  function editLocation(location: Location | 'new') {
    open({ kind: 'locations' });
    setLocationEdit(location);
    setLocationName(location === 'new' ? '' : location.name);
    setLocationCode(location === 'new' ? '' : location.code);
    setLocationDefault(location !== 'new' && location.isDefault);
    setDirty(false);
  }
  function saveLocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !admin ||
      editorEpoch === null ||
      pendingRef.current ||
      !locationEdit ||
      unresolved ||
      refreshRecovery
    )
      return;
    void send({
      path:
        locationEdit === 'new' ? '/inventory/locations' : `/inventory/locations/${locationEdit.id}`,
      method: locationEdit === 'new' ? 'POST' : 'PUT',
      body: {
        key: crypto.randomUUID(),
        ledgerEpoch: editorEpoch,
        name: locationName.trim(),
        code: locationCode.trim(),
        isDefault: locationDefault,
      },
    });
  }
  function restoreLocation(location: Location) {
    if (!admin || ledgerEpoch === null || pendingRef.current || unresolved || refreshRecovery)
      return;
    void send({
      path: `/inventory/locations/${location.id}`,
      method: 'PUT',
      body: {
        key: crypto.randomUUID(),
        ledgerEpoch,
        name: location.name,
        code: location.code,
        archived: false,
      },
      description: `שחזור מיקום: ${location.name}`,
    });
  }
  function retireLocation(location: Location, action: 'archive' | 'delete') {
    setReplacementLocationId('');
    setLocationRetirement({
      location,
      action,
      items: structuredClone(
        items.filter((item) => item.balances.some((p) => p.locationId === location.id)),
      ),
    });
  }
  function confirmLocationRetirement() {
    if (!locationRetirement || ledgerEpoch === null || pendingRef.current) return;
    const { location, action } = locationRetirement;
    const affected = locationRetirement.items
      .map((item) => item.id)
      .sort((left, right) => left - right);
    void send({
      path: `/inventory/locations/${location.id}/retire`,
      method: 'POST',
      body: {
        key: crypto.randomUUID(),
        ledgerEpoch,
        action,
        expectedCode: location.code,
        expectedName: location.name,
        ...(affected.length && replacementLocationId
          ? { replacementLocationId: Number(replacementLocationId) }
          : {}),
        expectedItemIds: affected,
        expectedBalances: locationRetirement.items
          .map((item) => {
            const balance = item.balances.find((p) => p.locationId === location.id)!;
            return {
              itemId: item.id,
              available: balance.available,
              damaged: balance.damaged,
              stockRevision: item.stockRevision,
            };
          })
          .sort((a, b) => a.itemId - b.itemId),
      },
      description: `${action === 'archive' ? 'ארכוב' : 'מחיקת'} מיקום: ${location.name}`,
    });
    setLocationRetirement(null);
  }
  const filtered = useMemo(
    () =>
      items.filter(
        (item) =>
          (includeArchived || !item.archived) &&
          (!typeFilter || item.kind === typeFilter) &&
          (!locationFilter || item.balances.some((p) => String(p.locationId) === locationFilter)),
      ),
    [items, includeArchived, typeFilter, locationFilter],
  );
  const filteredLocations = useMemo(() => {
    const query = locationQuery.trim().toLocaleLowerCase();
    return locations.filter((location) =>
      `${location.name} ${location.code}`.toLocaleLowerCase().includes(query),
    );
  }, [locations, locationQuery]);
  const columns: TableColumn<Item>[] = [
    {
      key: 'name',
      label: 'פריט',
      render: (item) => (
        <button
          type="button"
          className="inventory-link"
          onClick={() => open({ kind: 'item', item })}
        >
          {item.name}
          {item.archived ? ' (בארכיון)' : ''}
        </button>
      ),
      sortValue: (item) => item.name,
    },
    {
      key: 'kind',
      label: 'סוג',
      render: (item) => (
        <span className={`status-badge ${kindTones[item.kind]}`}>{kinds[item.kind]}</span>
      ),
      sortValue: (item) => item.kind,
    },
    {
      key: 'location',
      label: 'מיקום',
      render: (item) =>
        item.balances
          .map((p) => locations.find((l) => l.id === p.locationId)?.name)
          .filter(Boolean)
          .join(', ') || '—',
      sortValue: (item) =>
        item.balances
          .map((p) => locations.find((l) => l.id === p.locationId)?.name)
          .filter(Boolean)
          .join(', '),
    },
    {
      key: 'available',
      label: 'זמין',
      render: (item) => item.available,
      sortValue: (item) => item.available,
    },
    {
      key: 'borrowed',
      label: 'מושאל',
      render: (item) => item.borrowed,
      sortValue: (item) => item.borrowed,
    },
    { key: 'lost', label: 'אבוד', render: (item) => item.lost, sortValue: (item) => item.lost },
    {
      key: 'damaged',
      label: 'פגום',
      render: (item) => item.damaged,
      sortValue: (item) => item.damaged,
    },
    {
      key: 'action',
      label: 'פעולה',
      render: (item) => (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            className="small-button"
            disabled={
              item.archived || item.damaged === 0 || pending || !!unresolved || refreshRecovery
            }
            onClick={() => open({ kind: 'damage', item })}
          >
            <TriangleAlert className="size-3.5" aria-hidden="true" />
            טיפול בפגומים
          </button>
          <button
            type="button"
            className="small-button"
            data-tone="destructive"
            disabled={!admin || pending || !!unresolved || refreshRecovery}
            onClick={() => setDeleteConfirm(item)}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            מחיקה
          </button>
        </div>
      ),
    },
  ];
  const selected = editor?.kind === 'item' ? editor.item : null;
  const confirmedLocationItems = locationRetirement ? locationRetirement.items : [];
  const activeRetirementDestinations = locationRetirement
    ? locations.filter(
        (location) => !location.archived && location.id !== locationRetirement.location.id,
      )
    : [];
  const lockedDraft = pending || !!unresolved || refreshRecovery;
  const selectedBalance = selected?.balances.find(
    (balance) => balance.locationId === Number(draft.locationId),
  );
  const availableChanged =
    Boolean(draft.locationId) && draft.available !== String(selectedBalance?.available ?? 0);
  const adjustment = Number(draft.available) - (selectedBalance?.available ?? 0);
  const field = (key: keyof Draft, label: string, disabled = false) => (
    <label className="field-label">
      {label}
      <input
        ref={key === 'name' ? firstFieldRef : undefined}
        className="input-field"
        value={draft[key]}
        disabled={disabled || lockedDraft}
        onChange={(event) => {
          setDraft({ ...draft, [key]: event.target.value });
          if (key === 'available' && reviewRequired) setReviewSnapshot(null);
          setDirty(true);
        }}
      />
    </label>
  );
  return (
    <div className="space-y-5">
      <div className="inventory-view-header">
        <div className="inventory-view-switch" role="group" aria-label="תצוגת ניהול מלאי">
          <button
            ref={fallbackRef}
            type="button"
            id="inventory-view-tab"
            aria-controls="inventory-view-panel"
            aria-pressed={view === 'inventory'}
            disabled={pending || !!unresolved || refreshRecovery}
            onClick={() => setView('inventory')}
          >
            מלאי
          </button>
          <button
            type="button"
            id="locations-view-tab"
            aria-controls="locations-view-panel"
            aria-pressed={view === 'locations'}
            disabled={pending || !!unresolved || refreshRecovery}
            onClick={() => setView('locations')}
          >
            מיקומים
          </button>
        </div>
        {view === 'inventory' ? (
          <button
            type="button"
            className="primary-button"
            disabled={!admin || pending || !!unresolved || refreshRecovery}
            onClick={() => open({ kind: 'item', item: null })}
          >
            הוספת פריט חדש
          </button>
        ) : (
          <button
            type="button"
            className="primary-button"
            disabled={!admin || pending || !!unresolved || refreshRecovery}
            onClick={() => editLocation('new')}
          >
            מיקום חדש
          </button>
        )}
      </div>
      {!editor && unresolved && (
        <div className="inventory-location-recovery" role="status">
          <span>{unresolved.description ?? 'פעולה בניהול מלאי'}: תוצאת הפעולה אינה ידועה</span>
          <button
            className="primary-button"
            type="button"
            disabled={pending}
            onClick={() => void send(unresolved)}
          >
            בדוק שוב את אותה פעולה
          </button>
        </div>
      )}
      {!editor && refreshRecovery && (
        <div className="inventory-location-recovery" role="status">
          <span>
            {recoveryDescription ? `${recoveryDescription} נשמר; ` : ''}רענון הנתונים נכשל
          </span>
          <button
            className="primary-button"
            type="button"
            disabled={pending}
            onClick={() => void refreshAfterCommit()}
          >
            רענון נתונים
          </button>
        </div>
      )}
      <div id="inventory-view-panel" aria-label="טבלת מלאי" hidden={view !== 'inventory'}>
        <DataTable
          rows={filtered}
          columns={columns}
          rowKey={(item) => item.id}
          searchText={(item) => [item.name, ...item.aliases].join(' ')}
          searchPlaceholder="חיפוש שם או כינוי…"
          toolbar={
            <>
              <label className="inventory-filter">
                סוג
                <select
                  className="input-field"
                  value={typeFilter}
                  onChange={(event) => setTypeFilter(event.target.value)}
                >
                  <option value="">הכול</option>
                  {Object.entries(kinds).map(([kind, name]) => (
                    <option key={kind} value={kind}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="inventory-filter">
                מיקום
                <select
                  className="input-field"
                  value={locationFilter}
                  title={locations.find((location) => String(location.id) === locationFilter)?.name}
                  onChange={(event) => setLocationFilter(event.target.value)}
                >
                  <option value="">הכול</option>
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="inventory-archive-toggle">
                <input
                  type="checkbox"
                  checked={includeArchived}
                  onChange={(event) => setIncludeArchived(event.target.checked)}
                />
                כולל ארכיון
              </label>
            </>
          }
        />
      </div>
      <div id="locations-view-panel" aria-label="טבלת מיקומים" hidden={view !== 'locations'}>
        <div className="inventory-locations-toolbar">
          <input
            className="input-field"
            aria-label="חיפוש מיקומים"
            placeholder="חיפוש מיקומים…"
            value={locationQuery}
            onChange={(event) => setLocationQuery(event.target.value)}
          />
          <span className="inventory-locations-count">{filteredLocations.length} מיקומים</span>
        </div>
        <div className="table-shell">
          <StickyTable className="data-table">
            <thead>
              <tr>
                <th scope="col">שם</th>
                <th scope="col">קוד</th>
                <th scope="col">מצב</th>
                <th scope="col">פעולות</th>
              </tr>
            </thead>
            <tbody>
              {filteredLocations.map((location) => (
                <tr key={location.id}>
                  <td>{location.name}</td>
                  <td>{location.code}</td>
                  <td>{location.archived ? 'בארכיון' : 'פעיל'}</td>
                  <td>
                    <div className="inventory-location-actions">
                      <button
                        type="button"
                        className="small-button"
                        disabled={!admin || pending || !!unresolved || refreshRecovery}
                        onClick={() => editLocation(location)}
                      >
                        <Pencil className="size-3.5" aria-hidden="true" />
                        עריכה
                      </button>
                      <button
                        type="button"
                        className="small-button"
                        disabled={!admin || pending || !!unresolved || refreshRecovery}
                        onClick={() =>
                          location.archived
                            ? restoreLocation(location)
                            : retireLocation(location, 'archive')
                        }
                      >
                        {location.archived ? (
                          <RotateCcw className="size-3.5" aria-hidden="true" />
                        ) : (
                          <Archive className="size-3.5" aria-hidden="true" />
                        )}
                        {location.archived ? 'שחזור' : 'ארכוב'}
                      </button>
                      <button
                        type="button"
                        className="small-button"
                        data-tone="destructive"
                        disabled={!admin || pending || !!unresolved || refreshRecovery}
                        onClick={() => retireLocation(location, 'delete')}
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                        מחיקה
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </StickyTable>
        </div>
        {filteredLocations.length === 0 && (
          <p className="inventory-locations-empty">לא נמצאו מיקומים</p>
        )}
      </div>
      {editor && (
        <Dialog
          title={
            editor.kind === 'item'
              ? selected
                ? 'עריכת פריט'
                : 'הוספת פריט חדש'
              : editor.kind === 'transfer'
                ? 'העברת מלאי'
                : editor.kind === 'damage'
                  ? 'טיפול בפגומים'
                  : locationEdit === 'new'
                    ? 'מיקום חדש'
                    : 'עריכת מיקום'
          }
          level="root"
          role="dialog"
          variant="standard"
          busy={pending}
          dismissible={!pending}
          onClose={close}
          initialFocusRef={firstFieldRef}
          returnFocusRef={triggerRef}
          returnFocusFallbackRef={fallbackRef}
        >
          {editor.kind === 'item' && (
            <form className="dialog-form item-editor-form" onSubmit={saveItem}>
              <section className="item-editor-section" aria-labelledby="item-details-heading">
                <div className="item-editor-section-heading">
                  <h3 id="item-details-heading">פרטי פריט</h3>
                  {selected && (
                    <span className={`status-badge ${kindTones[selected.kind]}`}>
                      {kinds[selected.kind]}
                    </span>
                  )}
                </div>
                <div className="item-editor-fields">
                  {!selected && (
                    <label className="field-label">
                      סוג
                      <select
                        className="input-field"
                        value={draft.kind}
                        disabled={lockedDraft}
                        onChange={(event) => {
                          setDraft({
                            ...draft,
                            kind: event.target.value as Item['kind'],
                            lotSize: '',
                          });
                          setDirty(true);
                        }}
                      >
                        {Object.entries(kinds).map(([kind, name]) => (
                          <option key={kind} value={kind}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {field('name', 'שם פריט', !admin || !!selected?.archived)}
                  {field('aliases', 'כינויים, מופרדים בפסיק', !admin || !!selected?.archived)}
                  {draft.kind === 'consumable' &&
                    field('lotSize', 'גודל מארז', !admin || !!selected?.archived)}
                </div>
              </section>
              <section className="item-editor-section" aria-labelledby="item-stock-heading">
                <div className="item-editor-section-heading">
                  <h3 id="item-stock-heading">מלאי לפי מיקום</h3>
                  {selected && admin && !selected.archived && (
                    <button
                      type="button"
                      className="small-button"
                      disabled={lockedDraft}
                      onClick={() => open({ kind: 'transfer', item: selected })}
                    >
                      העברת מלאי בין מיקומים
                    </button>
                  )}
                </div>
                {selected && selected.balances.length > 1 && (
                  <div className="item-stock-overview">
                    <table className="item-stock-table" aria-label="יתרות מלאי לפי מיקום">
                      <thead>
                        <tr>
                          <th scope="col">מיקום</th>
                          <th scope="col">זמין</th>
                          <th scope="col">פגום</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.balances.map((balance) => (
                          <tr key={balance.locationId}>
                            <th scope="row">
                              {
                                locations.find((location) => location.id === balance.locationId)
                                  ?.name
                              }
                            </th>
                            <td>{balance.available}</td>
                            <td>{balance.damaged}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="item-stock-fields">
                  <label className="field-label">
                    מיקום
                    <select
                      className="input-field"
                      value={draft.locationId}
                      disabled={lockedDraft}
                      onChange={(event) => {
                        const locationId = event.target.value;
                        const apply = () => {
                          setDraft((current) => ({
                            ...current,
                            locationId,
                            available: String(
                              selected?.balances.find(
                                (balance) => balance.locationId === Number(locationId),
                              )?.available ?? 0,
                            ),
                          }));
                          setReviewRequired(false);
                          setReviewSnapshot(null);
                          setCurrentBalances(null);
                          setDirty(
                            admin &&
                              (!selected ||
                                draft.name !== selected.name ||
                                draft.aliases !== selected.aliases.join(', ') ||
                                draft.lotSize !== (selected.lotSize?.toString() ?? '') ||
                                draft.note !== '' ||
                                !selected.balances.some(
                                  (balance) => balance.locationId === Number(locationId),
                                )),
                          );
                        };
                        const original =
                          selected?.balances.find(
                            (balance) => balance.locationId === Number(draft.locationId),
                          )?.available ?? 0;
                        if (admin && draft.locationId && draft.available !== String(original)) {
                          pendingEditorChangeRef.current = apply;
                          setDiscardOpen(true);
                        } else apply();
                      }}
                    >
                      <option value="">בחרו מיקום לעריכת היתרה</option>
                      {locations
                        .filter((location) => !location.archived)
                        .map((location) => (
                          <option key={location.id} value={location.id}>
                            {location.name}
                            {location.archived ? ' (בארכיון)' : ''}
                          </option>
                        ))}
                    </select>
                  </label>

                  {field('available', 'זמין', !admin || !!selected?.archived || !draft.locationId)}
                </div>
                {selected && selected.kind !== 'consumable' && (
                  <p className="item-stock-summary">
                    פגום במיקום: {selectedBalance?.damaged ?? 0} · מושאל: {selected.borrowed} ·
                    אבוד: {selected.lost}
                  </p>
                )}
                {selected && availableChanged && safeInteger(draft.available, 0) && (
                  <p className="item-stock-adjustment">
                    התאמה: {adjustment > 0 ? '+' : ''}
                    {adjustment}
                  </p>
                )}
                {availableChanged && field('note', 'הערת התאמה (רשות)', !admin)}
                {reviewRequired && (
                  <div>
                    {currentBalances ? (
                      <>
                        <p>
                          יתרות עדכניות: זמין{' '}
                          {currentBalances.balances.find(
                            (balance) => balance.locationId === Number(draft.locationId),
                          )?.available ?? 0}
                          , מושאל {currentBalances.borrowed}, אבוד {currentBalances.lost}, פגום{' '}
                          {currentBalances.balances.find(
                            (balance) => balance.locationId === Number(draft.locationId),
                          )?.damaged ?? 0}
                        </p>
                        <p>
                          מיקום:{' '}
                          {
                            locations.find((location) => location.id === Number(draft.locationId))
                              ?.name
                          }{' '}
                          · כמות מבוקשת: {draft.available} · התאמה:{' '}
                          {Number(draft.available) -
                            (currentBalances.balances.find(
                              (balance) => balance.locationId === Number(draft.locationId),
                            )?.available ?? 0)}
                        </p>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={lockedDraft}
                          onClick={() => setReviewSnapshot(currentBalances.stockRevision)}
                        >
                          בדקתי את היתרות; שמור את הכמות המבוקשת
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={lockedDraft}
                        onClick={() => {
                          void api<Item[]>('/items?all=1')
                            .then((latest) =>
                              setCurrentBalances(
                                latest.find((item) => item.id === selected?.id) ?? null,
                              ),
                            )
                            .catch((failure) =>
                              showToast(
                                'רענון יתרות נכשל',
                                failure instanceof Error ? failure.message : 'שגיאה',
                                'error',
                              ),
                            );
                        }}
                      >
                        רענון יתרות לבדיקה
                      </button>
                    )}
                  </div>
                )}
              </section>
              {selected && admin && (
                <details className="item-editor-more">
                  <summary>פעולות נוספות</summary>
                  <div className="item-editor-more-actions">
                    {!selected.archived && (
                      <button
                        type="button"
                        className="small-button"
                        disabled={
                          pending ||
                          dirty ||
                          !!unresolved ||
                          refreshRecovery ||
                          !!(selected.borrowed || selected.lost || selected.damaged)
                        }
                        onClick={() => setArchiveConfirm(selected)}
                      >
                        <Archive className="size-3.5" aria-hidden="true" />
                        העברה לארכיון
                      </button>
                    )}
                    <button
                      type="button"
                      className="small-button"
                      data-tone="destructive"
                      disabled={pending || !!unresolved || refreshRecovery}
                      onClick={() => setDeleteConfirm(selected)}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                      מחיקה לצמיתות
                    </button>
                  </div>
                  {!selected.archived &&
                    !!(selected.borrowed || selected.lost || selected.damaged) && (
                      <p className="item-stock-summary">
                        ארכוב חסום כל עוד יש יתרות מושאלות, אבודות או פגומות: מושאל{' '}
                        {selected.borrowed}, אבוד {selected.lost}, פגום {selected.damaged}.
                      </p>
                    )}
                </details>
              )}
              <div className="dialog-actions item-editor-actions">
                {selected?.archived ? (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={!admin || pending || !!unresolved || refreshRecovery}
                    onClick={() => archiveItem(selected)}
                  >
                    שחזור פריט
                  </button>
                ) : (
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={!admin || pending || !!unresolved || refreshRecovery}
                  >
                    שמירה
                  </button>
                )}
                <button type="button" className="secondary-button" onClick={close}>
                  ביטול
                </button>
              </div>
            </form>
          )}
          {editor.kind === 'transfer' && (
            <form
              className="dialog-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!safeInteger(damageQuantity, 1) || !damageLocationId || !transferDestination) {
                  showToast('העברת מלאי', 'יש לבחור מקור, יעד וכמות חיובית', 'error');
                  return;
                }
                void send({
                  path: '/inventory/transfer',
                  method: 'POST',
                  body: {
                    key: crypto.randomUUID(),
                    ledgerEpoch: editorEpoch,
                    itemId: editor.item.id,
                    sourceLocationId: Number(damageLocationId),
                    destinationLocationId: Number(transferDestination),
                    quantity: Number(damageQuantity),
                    condition: transferCondition,
                    stockRevision: editor.item.stockRevision,
                    note: damageNote,
                  },
                });
              }}
            >
              <label className="field-label">
                מיקום מקור
                <select
                  className="input-field"
                  value={damageLocationId}
                  disabled={lockedDraft}
                  onChange={(event) => {
                    setDamageLocationId(event.target.value);
                    setDirty(true);
                  }}
                >
                  <option value="">בחרו מיקום</option>
                  {locations
                    .filter(
                      (l) => !l.archived && editor.item.balances.some((p) => p.locationId === l.id),
                    )
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field-label">
                מיקום יעד
                <select
                  className="input-field"
                  value={transferDestination}
                  disabled={lockedDraft}
                  onChange={(event) => {
                    setTransferDestination(event.target.value);
                    setDirty(true);
                  }}
                >
                  <option value="">בחרו מיקום</option>
                  {locations
                    .filter((l) => !l.archived && String(l.id) !== damageLocationId)
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field-label">
                מצב
                <select
                  className="input-field"
                  value={transferCondition}
                  disabled={lockedDraft}
                  onChange={(event) => {
                    setTransferCondition(event.target.value as 'usable' | 'damaged');
                    setDirty(true);
                  }}
                >
                  <option value="usable">תקין</option>
                  <option value="damaged">פגום</option>
                </select>
              </label>
              <label className="field-label">
                כמות
                <input
                  className="input-field"
                  type="number"
                  min="1"
                  value={damageQuantity}
                  disabled={lockedDraft}
                  onChange={(event) => {
                    setDamageQuantity(event.target.value);
                    setDirty(true);
                  }}
                />
              </label>
              <label className="field-label">
                הערה
                <input
                  className="input-field"
                  value={damageNote}
                  disabled={lockedDraft}
                  onChange={(event) => {
                    setDamageNote(event.target.value);
                    setDirty(true);
                  }}
                />
              </label>
              <div className="dialog-actions">
                <button className="primary-button" disabled={lockedDraft}>
                  העברה
                </button>
                <button type="button" className="secondary-button" onClick={close}>
                  ביטול
                </button>
              </div>
            </form>
          )}
          {editor.kind === 'damage' && (
            <form className="dialog-form" onSubmit={saveDamage}>
              <p>
                {editor.item.name} · פגום: {editor.item.damaged}
              </p>
              <label className="field-label">
                מיקום הפגומים
                <select
                  className="input-field"
                  value={damageLocationId}
                  disabled={lockedDraft}
                  onChange={(event) => setDamageLocationId(event.target.value)}
                >
                  <option value="">בחרו מיקום</option>
                  {locations
                    .filter(
                      (l) =>
                        !l.archived &&
                        (editor.item.balances.find((p) => p.locationId === l.id)?.damaged ?? 0) > 0,
                    )
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} · פגום{' '}
                        {editor.item.balances.find((p) => p.locationId === l.id)?.damaged}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field-label">
                כמות
                <input
                  ref={firstFieldRef}
                  className="input-field"
                  type="number"
                  min="1"
                  max={editor.item.damaged}
                  step="1"
                  value={damageQuantity}
                  disabled={lockedDraft}
                  onChange={(event) => {
                    setDamageQuantity(event.target.value);
                    setDirty(true);
                  }}
                />
              </label>
              <label className="field-label">
                פעולה
                <select
                  className="input-field"
                  value={resolution}
                  disabled={lockedDraft}
                  onChange={(event) => {
                    setResolution(event.target.value as 'repair' | 'write_off');
                    setDirty(true);
                  }}
                >
                  <option value="repair">החזרה לשימוש</option>
                  <option value="write_off" disabled={!admin}>
                    גריעה קבועה
                  </option>
                </select>
              </label>
              <label className="field-label">
                הערה (רשות)
                <textarea
                  className="input-field"
                  value={damageNote}
                  disabled={lockedDraft}
                  onChange={(event) => {
                    setDamageNote(event.target.value);
                    setDirty(true);
                  }}
                />
              </label>
              <div className="dialog-actions">
                <button
                  className="primary-button"
                  type="submit"
                  disabled={
                    pending ||
                    !!unresolved ||
                    refreshRecovery ||
                    (resolution === 'write_off' && !admin)
                  }
                >
                  שמירה
                </button>
                <button type="button" className="secondary-button" onClick={close}>
                  ביטול
                </button>
              </div>
            </form>
          )}
          {editor.kind === 'locations' && locationEdit && (
            <form className="dialog-form" onSubmit={saveLocation}>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={locationDefault}
                  disabled={lockedDraft}
                  onChange={(event) => {
                    setLocationDefault(event.target.checked);
                    setDirty(true);
                  }}
                />
                <span>מיקום ברירת מחדל</span>
              </label>
              <label className="field-label">
                שם
                <input
                  ref={firstFieldRef}
                  className="input-field"
                  value={locationName}
                  disabled={lockedDraft}
                  onChange={(event) => {
                    setLocationName(event.target.value);
                    setDirty(true);
                  }}
                />
              </label>
              <label className="field-label">
                קוד
                <input
                  className="input-field"
                  value={locationCode}
                  disabled={lockedDraft}
                  onChange={(event) => {
                    setLocationCode(event.target.value);
                    setDirty(true);
                  }}
                />
              </label>
              <div className="dialog-actions">
                <button
                  className="primary-button"
                  type="submit"
                  disabled={!admin || pending || !!unresolved || refreshRecovery}
                >
                  שמירה
                </button>
                <button className="secondary-button" type="button" onClick={close}>
                  ביטול
                </button>
              </div>
            </form>
          )}
          {unresolved && (
            <div className="dialog-actions">
              <button
                className="primary-button"
                type="button"
                disabled={pending}
                onClick={() => void send(unresolved)}
              >
                בדוק שוב את אותה פעולה
              </button>
            </div>
          )}
          {refreshRecovery && (
            <div className="dialog-actions">
              <button
                className="primary-button"
                type="button"
                disabled={pending}
                onClick={() => void refreshAfterCommit()}
              >
                רענון נתונים
              </button>
            </div>
          )}
        </Dialog>
      )}
      {archiveConfirm && (
        <Dialog
          title={`לארכב את ${archiveConfirm.name}?`}
          description="ארכוב הפריט יאפס את כל המלאי הזמין שלו, גם אם היתרה השתנתה מאז פתיחת הפריט. אם נותר מלאי זמין, ההפחתה תירשם בהיסטוריית המלאי."
          level="subordinate"
          role="alertdialog"
          variant="destructive"
          busy={pending}
          dismissible={!pending}
          onClose={() => setArchiveConfirm(null)}
          returnFocusFallbackRef={fallbackRef}
        >
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setArchiveConfirm(null)}
            >
              ביטול
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={pending}
              onClick={() => {
                archiveItem(archiveConfirm);
                setArchiveConfirm(null);
              }}
            >
              ארכוב ואיפוס מלאי זמין
            </button>
          </div>
        </Dialog>
      )}
      {deleteConfirm && (
        <Dialog
          title={`למחוק את ${deleteConfirm.name} לצמיתות?`}
          description="המחיקה תסיר את הפריט ואת ההיסטוריה שלו, כולל אזכורים בהיסטוריית שואלים ובדוחות. לא ניתן לשחזר דרך המערכת."
          level={editor ? 'subordinate' : 'root'}
          role="alertdialog"
          variant="destructive"
          busy={pending}
          dismissible={!pending}
          onClose={() => setDeleteConfirm(null)}
          returnFocusFallbackRef={fallbackRef}
        >
          <div className="dialog-fields">
            <p>זמין למחיקה: {deleteConfirm.available}</p>
            {(deleteConfirm.borrowed || deleteConfirm.damaged || deleteConfirm.lost) > 0 && (
              <p role="alert">
                המחיקה חסומה: מושאל {deleteConfirm.borrowed}, פגום {deleteConfirm.damaged}, אבוד{' '}
                {deleteConfirm.lost}.
              </p>
            )}
          </div>
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={pending}
              onClick={() => setDeleteConfirm(null)}
            >
              ביטול
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={
                !admin ||
                pending ||
                !!unresolved ||
                refreshRecovery ||
                Boolean(deleteConfirm.borrowed || deleteConfirm.damaged || deleteConfirm.lost)
              }
              onClick={() => deleteItem(deleteConfirm)}
            >
              מחק את הפריט וההיסטוריה לצמיתות
            </button>
          </div>
        </Dialog>
      )}
      {locationRetirement && (
        <Dialog
          title={
            locationRetirement.action === 'archive'
              ? `לארכב את ${locationRetirement.location.name}?`
              : `למחוק את ${locationRetirement.location.name}?`
          }
          description={
            confirmedLocationItems.length > 0
              ? `כל ${confirmedLocationItems.length} הפריטים, כולל פריטים שבארכיון, יועברו למיקום הפעיל שתבחר. הפעולה תתבצע יחד עם ${locationRetirement.action === 'archive' ? 'ארכוב' : 'מחיקת'} המיקום.`
              : `המיקום ריק. ${locationRetirement.action === 'archive' ? 'הוא יועבר לארכיון.' : 'הוא יימחק לצמיתות.'}`
          }
          level="root"
          role="alertdialog"
          variant="destructive"
          busy={pending}
          dismissible={!pending}
          onClose={() => setLocationRetirement(null)}
          returnFocusFallbackRef={fallbackRef}
        >
          {confirmedLocationItems.length > 0 && (
            <ul>
              {confirmedLocationItems.map((item) => {
                const balance = item.balances.find(
                  (p) => p.locationId === locationRetirement.location.id,
                )!;
                return (
                  <li key={item.id}>
                    {item.name}: זמין {balance.available}, פגום {balance.damaged}
                  </li>
                );
              })}
            </ul>
          )}
          {confirmedLocationItems.length > 0 && (
            <label className="field-label">
              להעביר את כל הפריטים אל
              <select
                className="input-field"
                value={replacementLocationId}
                disabled={pending || !!unresolved || refreshRecovery}
                onChange={(event) => setReplacementLocationId(event.target.value)}
              >
                <option value="">בחירת מיקום פעיל</option>
                {activeRetirementDestinations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {confirmedLocationItems.length > 0 && activeRetirementDestinations.length === 0 && (
            <p role="alert">אין מיקום פעיל אחר. יש ליצור או להפעיל מיקום לפני הפרישה.</p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={pending}
              onClick={() => setLocationRetirement(null)}
            >
              ביטול
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={
                !admin ||
                pending ||
                !!unresolved ||
                refreshRecovery ||
                (confirmedLocationItems.length > 0 && !replacementLocationId)
              }
              onClick={confirmLocationRetirement}
            >
              {locationRetirement.action === 'archive'
                ? 'ארכוב והעברה'
                : confirmedLocationItems.length > 0
                  ? 'העבר את הפריטים ומחק את המיקום לצמיתות'
                  : 'מחק את המיקום לצמיתות'}
            </button>
          </div>
        </Dialog>
      )}
      {discardOpen && (
        <Dialog
          title="לבטל את השינויים?"
          description="השינויים בטופס לא נשמרו"
          level="subordinate"
          role="alertdialog"
          variant="destructive"
          busy={false}
          dismissible={true}
          onClose={() => {
            setDiscardOpen(false);
            pendingNavigationRef.current = null;
            pendingEditorChangeRef.current = null;
          }}
          returnFocusRef={firstFieldRef}
          returnFocusFallbackRef={triggerRef}
        >
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setDiscardOpen(false);
                pendingNavigationRef.current = null;
                pendingEditorChangeRef.current = null;
              }}
            >
              להמשיך לערוך
            </button>
            <button type="button" className="danger-button" onClick={discard}>
              ביטול השינויים
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
