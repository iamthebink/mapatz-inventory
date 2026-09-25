import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError, api } from './api';
import { DataTable, type TableColumn } from './DataTable';
import { Dialog } from './Dialog';
import type { Item, Location } from './InventoryDialogs';
import type { ToastTone } from './Toast';

type Editor =
  { kind: 'item'; item: Item | null } | { kind: 'damage'; item: Item } | { kind: 'locations' };
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
  returnToLocations?: boolean;
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
  locationId: item?.locationId?.toString() ?? '',
  lotSize: item?.lotSize?.toString() ?? '',
  available: item?.available.toString() ?? '0',
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
  const [editorEpoch, setEditorEpoch] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>(itemDraft(null));
  const [damageQuantity, setDamageQuantity] = useState('1');
  const [damageNote, setDamageNote] = useState('');
  const [resolution, setResolution] = useState<'repair' | 'write_off'>('repair');
  const [locationEdit, setLocationEdit] = useState<Location | 'new' | null>(null);
  const [locationName, setLocationName] = useState('');
  const [locationCode, setLocationCode] = useState('');
  const [locationQuery, setLocationQuery] = useState('');
  const [dirty, setDirty] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discardToLocations, setDiscardToLocations] = useState(false);
  const [pending, setPending] = useState(false);
  const [unresolved, setUnresolved] = useState<Attempt | null>(null);
  const [refreshRecovery, setRefreshRecovery] = useState(false);
  const [refreshRecoveryReturnToLocations, setRefreshRecoveryReturnToLocations] = useState(false);
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
  const pendingNavigationRef = useRef<(() => void) | null>(null);

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
    if (editor?.kind === 'locations' && locationEdit === null) firstFieldRef.current?.focus();
  }, [editor, locationEdit]);

  function open(next: Editor) {
    triggerRef.current = document.activeElement as HTMLElement;
    setEditor(next);
    setEditorEpoch(ledgerEpoch);
    setLocationEdit(null);
    setDirty(false);
    setUnresolved(null);
    setRefreshRecovery(false);
    setRefreshRecoveryReturnToLocations(false);
    setReviewSnapshot(null);
    setReviewRequired(false);
    setCurrentBalances(null);
    if (next.kind === 'item') setDraft(itemDraft(next.item));
    if (next.kind === 'damage') {
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
    setLocationEdit(null);
    if (!discardToLocations) queueMicrotask(() => setEditor(null));
    setDiscardToLocations(false);
    const next = pendingNavigationRef.current;
    pendingNavigationRef.current = null;
    if (next) queueMicrotask(next);
  }
  async function refreshAfterCommit(returnToLocations = false) {
    try {
      await onRefresh();
      setRefreshRecovery(false);
      setRefreshRecoveryReturnToLocations(false);
      setUnresolved(null);
      setDirty(false);
      if (returnToLocations) {
        setLocationEdit(null);
        setEditor({ kind: 'locations' });
      } else setEditor(null);
      showToast('המלאי עודכן', 'השינוי נשמר בהצלחה', 'success');
    } catch (error) {
      setRefreshRecovery(true);
      setRefreshRecoveryReturnToLocations(returnToLocations);
      showToast(
        'השינוי נשמר',
        error instanceof Error ? `רענון נכשל: ${error.message}` : 'רענון הנתונים נכשל',
        'warning',
      );
    }
  }
  async function send(attempt: Attempt) {
    if (pendingRef.current || refreshRecovery || (unresolved && unresolved !== attempt)) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await api(attempt.path, { method: attempt.method, body: JSON.stringify(attempt.body) });
      await refreshAfterCommit(attempt.returnToLocations);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'stale_stock' && editor?.kind === 'item') {
        setUnresolved(null);
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
      } else if (error instanceof ApiError && error.status < 500) {
        setUnresolved(null);
        showToast('השמירה נדחתה', error.message, 'error');
      } else {
        setUnresolved(attempt);
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
      !draft.name.trim() ||
      draft.name.trim().length > 100 ||
      !safeInteger(draft.available, 0) ||
      (draft.lotSize !== '' && !safeInteger(draft.lotSize, 1))
    ) {
      showToast('פרטים לא תקינים', 'יש לבדוק את השם, הכמות וגודל המארז', 'error');
      return;
    }
    const item = editor.item;
    const countChanged = !item || Number(draft.available) !== item.available;
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
              stockSnapshot: item ? (reviewSnapshot ?? item.stockSnapshot) : undefined,
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
    if (!safeInteger(damageQuantity, 1) || Number(damageQuantity) > editor.item.damaged) {
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
  function editLocation(location: Location | 'new') {
    setLocationEdit(location);
    setLocationName(location === 'new' ? '' : location.name);
    setLocationCode(location === 'new' ? '' : location.code);
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
      },
      returnToLocations: true,
    });
  }
  function archiveLocation(location: Location) {
    if (!admin || editorEpoch === null || pendingRef.current) return;
    void send({
      path: `/inventory/locations/${location.id}`,
      method: 'PUT',
      body: {
        key: crypto.randomUUID(),
        ledgerEpoch: editorEpoch,
        name: location.name,
        code: location.code,
        archived: !location.archived,
      },
      returnToLocations: true,
    });
  }
  const filtered = useMemo(
    () =>
      items.filter(
        (item) =>
          (includeArchived || !item.archived) &&
          (!typeFilter || item.kind === typeFilter) &&
          (!locationFilter || String(item.locationId ?? '') === locationFilter),
      ),
    [items, includeArchived, typeFilter, locationFilter],
  );
  const columns: TableColumn<Item>[] = [
    { key: 'code', label: 'קוד', render: (item) => item.code, sortValue: (item) => item.code },
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
      render: (item) => locations.find((location) => location.id === item.locationId)?.name ?? '—',
      sortValue: (item) =>
        locations.find((location) => location.id === item.locationId)?.name ?? '',
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
        <button
          type="button"
          className="secondary-button"
          disabled={item.archived || item.damaged === 0}
          onClick={() => open({ kind: 'damage', item })}
        >
          טיפול בפגומים
        </button>
      ),
    },
  ];
  const selected = editor?.kind === 'item' ? editor.item : null;
  const lockedDraft = pending || !!unresolved || refreshRecovery;
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
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="primary-button"
          disabled={!admin}
          onClick={() => open({ kind: 'item', item: null })}
        >
          הוספת פריט חדש
        </button>
        <button
          ref={fallbackRef}
          type="button"
          className="secondary-button"
          onClick={() => open({ kind: 'locations' })}
        >
          מיקומים
        </button>
      </div>
      <DataTable
        rows={filtered}
        columns={columns}
        rowKey={(item) => item.id}
        searchText={(item) => [item.name, item.code, ...item.aliases].join(' ')}
        searchPlaceholder="חיפוש שם, כינוי או קוד…"
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
      {editor && (
        <Dialog
          title={
            editor.kind === 'item'
              ? selected
                ? 'עריכת פריט'
                : 'הוספת פריט חדש'
              : editor.kind === 'damage'
                ? 'טיפול בפגומים'
                : 'מיקומים'
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
            <form className="dialog-form" onSubmit={saveItem}>
              <div className="dialog-fields">
                {selected && (
                  <p>
                    קוד: {selected.code} · סוג: {kinds[selected.kind]}
                  </p>
                )}
                {!selected && <p>קוד פריט ייווצר בעת השמירה.</p>}
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
                <label className="field-label">
                  מיקום
                  <select
                    className="input-field"
                    value={draft.locationId}
                    disabled={!admin || lockedDraft}
                    onChange={(event) => {
                      setDraft({ ...draft, locationId: event.target.value });
                      setDirty(true);
                    }}
                  >
                    <option value="">ללא מיקום</option>
                    {locations
                      .filter(
                        (location) => !location.archived || location.id === selected?.locationId,
                      )
                      .map((location) => (
                        <option key={location.id} value={location.id}>
                          {location.name}
                          {location.archived ? ' (בארכיון)' : ''}
                        </option>
                      ))}
                  </select>
                </label>
                {field('available', 'זמין', !admin || !!selected?.archived)}
                <p>
                  מושאל: {selected?.borrowed ?? 0} · אבוד: {selected?.lost ?? 0} · פגום:{' '}
                  {selected?.damaged ?? 0}
                </p>
                {selected &&
                  !selected.archived &&
                  !!(
                    selected.available ||
                    selected.borrowed ||
                    selected.lost ||
                    selected.damaged
                  ) && (
                    <p>
                      ארכוב חסום עד שכל היתרות השמורות הן אפס: זמין {selected.available}, מושאל{' '}
                      {selected.borrowed}, אבוד {selected.lost}, פגום {selected.damaged}.
                    </p>
                  )}
                {selected &&
                  safeInteger(draft.available, 0) &&
                  Number(draft.available) !== selected.available && (
                    <p>
                      התאמה: {Number(draft.available) - selected.available > 0 ? '+' : ''}
                      {Number(draft.available) - selected.available}
                    </p>
                  )}
                {draft.available !== (selected?.available.toString() ?? '0') &&
                  field('note', 'הערת התאמה (רשות)', !admin)}
                {reviewRequired && (
                  <div>
                    {currentBalances ? (
                      <>
                        <p>
                          יתרות עדכניות: זמין {currentBalances.available}, מושאל{' '}
                          {currentBalances.borrowed}, אבוד {currentBalances.lost}, פגום{' '}
                          {currentBalances.damaged}
                        </p>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={lockedDraft}
                          onClick={() => setReviewSnapshot(currentBalances.stockSnapshot)}
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
              </div>
              <div className="dialog-actions">
                {!selected?.archived && (
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={!admin || pending || !!unresolved || refreshRecovery}
                  >
                    שמירה
                  </button>
                )}
                {selected && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={
                      !admin ||
                      pending ||
                      (dirty && !selected.archived) ||
                      !!unresolved ||
                      refreshRecovery ||
                      (!selected.archived &&
                        !!(
                          selected.available ||
                          selected.borrowed ||
                          selected.lost ||
                          selected.damaged
                        ))
                    }
                    onClick={() => archiveItem(selected)}
                  >
                    {selected.archived ? 'שחזור פריט' : 'העברה לארכיון'}
                  </button>
                )}
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
          {editor.kind === 'locations' && (
            <div className="space-y-4">
              {locationEdit ? (
                <form className="dialog-form" onSubmit={saveLocation}>
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
                      disabled={pending || !!unresolved || refreshRecovery}
                    >
                      שמירה
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={lockedDraft}
                      onClick={() => {
                        if (dirty) {
                          setDiscardToLocations(true);
                          setDiscardOpen(true);
                        } else setLocationEdit(null);
                      }}
                    >
                      חזרה
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <input
                    ref={firstFieldRef}
                    className="input-field"
                    aria-label="חיפוש מיקומים"
                    placeholder="חיפוש מיקומים…"
                    value={locationQuery}
                    onChange={(event) => setLocationQuery(event.target.value)}
                  />
                  <button
                    className="primary-button"
                    type="button"
                    disabled={!admin || pending || !!unresolved || refreshRecovery}
                    onClick={() => editLocation('new')}
                  >
                    מיקום חדש
                  </button>
                  <div className="table-shell">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>שם</th>
                          <th>קוד</th>
                          <th>מצב</th>
                          <th>פעולות</th>
                        </tr>
                      </thead>
                      <tbody>
                        {locations
                          .filter((location) =>
                            `${location.name} ${location.code}`
                              .toLowerCase()
                              .includes(locationQuery.toLowerCase()),
                          )
                          .map((location) => (
                            <tr key={location.id}>
                              <td>{location.name}</td>
                              <td>{location.code}</td>
                              <td>{location.archived ? 'בארכיון' : 'פעיל'}</td>
                              <td>
                                <button
                                  type="button"
                                  className="secondary-button"
                                  disabled={!admin || pending || !!unresolved || refreshRecovery}
                                  onClick={() => editLocation(location)}
                                >
                                  עריכה
                                </button>
                                <button
                                  type="button"
                                  className="secondary-button"
                                  disabled={!admin || pending || !!unresolved || refreshRecovery}
                                  onClick={() => archiveLocation(location)}
                                >
                                  {location.archived ? 'שחזור' : 'ארכוב'}
                                </button>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              <button className="secondary-button" type="button" onClick={close}>
                סגירה
              </button>
            </div>
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
                onClick={() => void refreshAfterCommit(refreshRecoveryReturnToLocations)}
              >
                רענון נתונים
              </button>
            </div>
          )}
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
            setDiscardToLocations(false);
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
                setDiscardToLocations(false);
              }}
            >
              להמשיך לערוך
            </button>
            <button type="button" className="primary-button" onClick={discard}>
              ביטול השינויים
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
