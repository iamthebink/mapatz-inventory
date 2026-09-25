import { desktop } from './desktop';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Check, ClipboardCheck, TriangleAlert, Undo2 } from 'lucide-react';
import type { Borrower } from '../domain/types';
import type { BorrowerDeskSnapshot } from '../contracts/borrower-workflow';
import { fetchBorrowerDeskSnapshot, fetchBorrowerSearch, sendFrozenBorrowerAttempt } from './api';
import { ActiveDescendantCombobox, type ComboboxOption } from './ActiveDescendantCombobox';
import { BorrowerOperationalTables, type ReturnCondition } from './BorrowerOperationalTables';
import { Dialog, useDialogStack } from './Dialog';
import {
  canSave,
  createCreationState,
  createOperationState,
  creationLocks,
  creationReducer,
  operationLocks,
  operationPresentation,
  operationReducer,
  operationRequest,
  projectItem,
  type CreationState,
  type OperationState,
  type SaveIntent,
  type WorkflowFeedback,
} from './borrower-workflow-state';
import {
  clearFrozenAttempt,
  dispatchFrozenAttempt,
  initializeFrozenAttemptRecovery,
  persistFrozenAttempt,
  resolveFrozenAttempt,
  type FrozenAttempt,
  type FrozenCreateAttempt,
  type FrozenDispatchResult,
  type FrozenOperationAttempt,
} from './borrower-workflow-recovery';
import type { ToastTone } from './Toast';

export type BorrowerWorkflowHandle = {
  requestNavigation: (complete: () => void) => void;
  openFromSummary: (borrower: Borrower, onReturn: () => void) => void;
  retryStartup: () => void;
};

type QuantityDialog = {
  direction: 'borrow' | 'issue' | 'return';
  condition?: ReturnCondition;
  itemId: number;
  quantity: string;
  note: string;
  error: string;
  damaged: boolean;
};

const titleForFeedback: Record<WorkflowFeedback['kind'], string> = {
  success: 'הפעולה הושלמה',
  warning: 'נדרשת תשומת לב',
  error: 'הפעולה נכשלה',
};

const translatedFeedback: Record<string, string> = {
  operation_saved: 'השמירה הושלמה.',
  borrower_created: 'השואל נוצר בהצלחה.',
  outcome_unknown: 'תוצאת הפעולה אינה ידועה. יש לבדוק את אותה פעולה שמורה.',
  authorization_required: 'נדרש אימות הרשאה מחדש.',
  refresh_required: 'הפעולה אושרה, אך התצוגה טרם אומתה.',
  reload_required: 'נדרשת טעינה מחדש של נתוני האמת.',
  ledger_epoch_changed: 'נתוני המלאי הוחלפו. יש לטעון את נתוני האמת מחדש.',
  card_load_failed: 'כרטיס השואל לא נטען. ניתן לנסות שוב ללא יצירה נוספת.',
  storage_persist_failed: 'לא ניתן לשמור את הפעולה לשחזור.',
  storage_clear_failed: 'לא ניתן לנקות את הפעולה השמורה.',
  dependent_recovery: 'יש לבטל תחילה את הפעולה התלויה בסימון כאבוד.',
};

const borrowerTypeNames: Record<Borrower['type'], string> = {
  individual: 'יחיד',
  camp_organization: 'ארגון מחנה',
  other: 'אחר',
};

function uuid(): string {
  return crypto.randomUUID();
}

function focusWithFallback(
  preferred: HTMLElement | null | undefined,
  fallback: HTMLElement | null | undefined,
) {
  if (preferred?.isConnected && !preferred.matches(':disabled')) preferred.focus();
  else fallback?.focus();
}

function OperationReview({ state }: { state: OperationState }) {
  const inventory = new Map(state.snapshot.inventory.map((item) => [item.id, item.name]));
  return (
    <div className="borrower-review-list">
      {state.staged.flatMap((group) => {
        const rows: Array<{ label: string; quantity: number; note: string }> = [];
        for (const part of group.borrow)
          rows.push({ label: 'השאלה', quantity: part.quantity, note: part.note });
        for (const part of group.issue ?? [])
          rows.push({ label: 'ניפוק · מתכלה', quantity: part.quantity, note: part.note });
        for (const part of group.return) {
          if (part.usable > 0)
            rows.push({ label: 'החזרת ציוד', quantity: part.usable, note: part.note });
          if (part.damaged > 0)
            rows.push({ label: 'החזרת ציוד · פגום', quantity: part.damaged, note: part.note });
        }
        for (const part of group.lost ?? [])
          rows.push({ label: 'סמן כאבוד', quantity: part.quantity, note: part.note });
        for (const part of group.lostCredit ?? [])
          rows.push({
            label: part.condition === 'damaged' ? 'נמצא והוחזר · פגום' : 'נמצא והוחזר',
            quantity: part.quantity,
            note: part.note,
          });
        return rows.map((row, index) => (
          <div className="borrower-review-row" key={`${group.itemId}-${index}`}>
            <strong>{inventory.get(group.itemId) ?? `#${group.itemId}`}</strong>
            <span>
              {row.label.includes('פגום') && (
                <TriangleAlert className="size-4 inline-block" aria-hidden="true" />
              )}{' '}
              {row.label} · {row.quantity}
            </span>
            {row.note && <small>{row.note}</small>}
          </div>
        ));
      })}
    </div>
  );
}

export const BorrowerWorkflow = forwardRef<
  BorrowerWorkflowHandle,
  {
    showToast: (title: string, message: string, tone: ToastTone) => void;
    deskVisible?: boolean;
    onStartupChange?: (status: 'loading' | 'ready' | 'failed') => void;
  }
>(function BorrowerWorkflow({ showToast, deskVisible = true, onStartupChange }, ref) {
  const [startup, setStartup] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [search, setSearch] = useState('');
  const [searchSnapshot, setSearchSnapshot] = useState<Awaited<
    ReturnType<typeof fetchBorrowerSearch>
  > | null>(null);
  const [resolvedSearch, setResolvedSearch] = useState<string | null>(null);
  const [selectedBorrower, setSelectedBorrower] = useState<Borrower | null>(null);
  const [cardLoadFailed, setCardLoadFailed] = useState(false);
  const [operation, setOperation] = useState<OperationState | null>(null);
  const [itemSearch, setItemSearch] = useState('');
  const [quantity, setQuantity] = useState<QuantityDialog | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [creation, setCreation] = useState<CreationState | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const deskVisibleRef = useRef(deskVisible);
  deskVisibleRef.current = deskVisible;
  const startupRetryRef = useRef<HTMLButtonElement>(null);
  const itemSearchRef = useRef<HTMLInputElement>(null);
  const cardOverviewRef = useRef<HTMLParagraphElement>(null);
  const quantityErrorRef = useRef<HTMLInputElement>(null);
  const reviewConfirmRef = useRef<HTMLButtonElement>(null);
  const createFirstRef = useRef<HTMLInputElement>(null);
  const retryCardRef = useRef<HTMLButtonElement>(null);
  const retryRefreshRef = useRef<HTMLButtonElement>(null);
  const directoryRecoveryRef = useRef<HTMLButtonElement>(null);
  const creationRecoveryRef = useRef<HTMLButtonElement>(null);
  const closeInitiatorRef = useRef<HTMLElement | null>(null);
  const returnButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const rollbackButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const initiallyFocusedBorrowerRef = useRef<number | null>(null);
  const frozenAttemptRef = useRef<FrozenAttempt | null>(null);
  const navigationRef = useRef<(() => void) | null>(null);
  const summaryReturnRef = useRef<(() => void) | null>(null);
  const sentinelRef = useRef(false);
  const suppressPopRef = useRef(false);
  const feedbackRef = useRef<WorkflowFeedback | null>(null);
  const searchRequestRef = useRef(0);
  const cardLoadRequestRef = useRef(0);
  const stack = useDialogStack();

  const loadSearch = useCallback(
    async (query: string, focus = false) => {
      const requestId = ++searchRequestRef.current;
      try {
        const result = await fetchBorrowerSearch(query);
        if (requestId !== searchRequestRef.current) return null;
        setSearchSnapshot(result);
        setResolvedSearch(query);
        setStartup('ready');
        if (focus && deskVisibleRef.current) queueMicrotask(() => searchRef.current?.focus());
        return result;
      } catch (error) {
        if (requestId !== searchRequestRef.current) return null;
        setStartup('failed');
        showToast(
          'טעינת דלפק השאלות',
          error instanceof Error ? error.message : 'הטעינה נכשלה',
          'error',
        );
        if (deskVisibleRef.current) queueMicrotask(() => startupRetryRef.current?.focus());
        return null;
      }
    },
    [showToast],
  );

  const initialize = useCallback(async () => {
    setStartup('loading');
    const recovery = await initializeFrozenAttemptRecovery(localStorage, sendFrozenBorrowerAttempt);
    if (!recovery.ready) {
      setStartup('failed');
      showToast('שחזור פעולה', 'לא ניתן לקבוע בוודאות את מצב הפעולה. נסו שוב.', 'error');
      if (deskVisibleRef.current) queueMicrotask(() => startupRetryRef.current?.focus());
      return;
    }
    if (recovery.results.length > 0)
      showToast('שחזור פעולה', 'הפעולה הממתינה נבדקה מול השרת.', 'warning');
    await loadSearch('', deskVisibleRef.current);
  }, [loadSearch, showToast]);

  const refreshDirectoryAfterCreation = async (query: string) => {
    const requestId = ++searchRequestRef.current;
    try {
      const result = await fetchBorrowerSearch(query);
      if (requestId === searchRequestRef.current) {
        setSearchSnapshot(result);
        setResolvedSearch(query);
      }
    } catch {
      if (requestId !== searchRequestRef.current) return;
      showToast(
        'רענון רשימת השואלים',
        'השואל נוצר, אך רשימת השואלים לא התרעננה. ניתן לנסות לחפש שוב.',
        'warning',
      );
    }
  };

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => onStartupChange?.(startup), [onStartupChange, startup]);

  useEffect(() => {
    if (!deskVisible || startup !== 'ready' || selectedBorrower || createOpen || stack.depth > 0)
      return;
    const timer = window.setTimeout(() => {
      if (operation?.phase.kind === 'refresh-required') directoryRecoveryRef.current?.focus();
      else searchRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [createOpen, deskVisible, operation, selectedBorrower, stack.depth, startup]);

  useEffect(() => {
    if (!deskVisible || startup !== 'failed') return;
    const timer = window.setTimeout(() => startupRetryRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [deskVisible, startup]);

  useEffect(() => {
    if (!selectedBorrower || !cardLoadFailed) return;
    const timer = window.setTimeout(() => retryCardRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [cardLoadFailed, selectedBorrower]);

  useEffect(() => {
    if (!selectedBorrower || cardLoadFailed || !operation) return;
    const timer = window.setTimeout(() => {
      if (operation.focus === 'item-search') itemSearchRef.current?.focus();
      else if (operation.focus === 'retry-refresh') retryRefreshRef.current?.focus();
      else if (operation.focus === 'borrower-search') searchRef.current?.focus();
      else if (
        operation.phase.kind === 'ready' &&
        initiallyFocusedBorrowerRef.current !== operation.borrowerId
      ) {
        initiallyFocusedBorrowerRef.current = operation.borrowerId;
        cardOverviewRef.current?.focus();
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [cardLoadFailed, operation, selectedBorrower]);

  useEffect(() => {
    if (
      !createOpen ||
      !creation ||
      !['unknown', 'storage-recovery', 'reload-required'].includes(creation.phase.kind)
    )
      return;
    const timer = window.setTimeout(() => creationRecoveryRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [createOpen, creation]);

  useEffect(() => {
    if (
      !createOpen ||
      !creation ||
      !['editing', 'conflicted'].includes(creation.phase.kind) ||
      creation.fieldErrors.length === 0
    )
      return;
    const field = creation.fieldErrors[0]?.field ?? 'username';
    const timer = window.setTimeout(
      () => document.querySelector<HTMLInputElement>(`[name="${field}"]`)?.focus(),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [createOpen, creation]);

  useEffect(() => {
    if (startup !== 'ready' || resolvedSearch === search) return;
    const timer = window.setTimeout(() => {
      void loadSearch(search);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [loadSearch, resolvedSearch, search, startup]);

  const removeSentinel = useCallback((after?: () => void) => {
    if (!sentinelRef.current) {
      after?.();
      return;
    }
    sentinelRef.current = false;
    suppressPopRef.current = true;
    navigationRef.current = after ?? null;
    history.back();
  }, []);

  const resetCard = useCallback(() => {
    cardLoadRequestRef.current += 1;
    initiallyFocusedBorrowerRef.current = null;
    setSelectedBorrower(null);
    setOperation(null);
    setCardLoadFailed(false);
    setItemSearch('');
    setQuantity(null);
    setReviewOpen(false);
    setCreation(null);
  }, []);

  const closeCard = useCallback(
    (after?: () => void) => {
      const returnToSummary = after ? null : summaryReturnRef.current;
      summaryReturnRef.current = null;
      resetCard();
      removeSentinel(() => {
        if (deskVisible) searchRef.current?.focus();
        after?.();
        returnToSummary?.();
      });
    },
    [deskVisible, removeSentinel, resetCard],
  );

  const closeCreation = useCallback(
    (after?: () => void) => {
      setCreateOpen(false);
      setCreation(null);
      removeSentinel(() => {
        searchRef.current?.focus();
        after?.();
      });
    },
    [removeSentinel],
  );

  const requestExit = useCallback(
    (initiator: HTMLElement | null, complete?: () => void) => {
      if (createOpen && creation) {
        if (stack.depth > 1) {
          showToast('סיום חלון פעיל', 'יש להשלים או לבטל את החלון הפנימי תחילה.', 'warning');
          return;
        }
        if (creationLocks(creation).dismissal) {
          showToast('הפעולה מוגנת', 'לא ניתן לצאת בזמן שמצב השמירה אינו ודאי.', 'warning');
          return;
        }
        if (
          desktop &&
          (creation.values.name || creation.values.username || creation.values.contact) &&
          !window.confirm('לבטל את טיוטת השואל ולצאת?')
        )
          return;
        closeInitiatorRef.current = initiator;
        closeCreation(complete);
        return;
      }
      if (!selectedBorrower) {
        if (operation && !operationPresentation(operation).searchEnabled) {
          showToast('הפעולה מוגנת', 'יש לאמת את נתוני האמת לפני היציאה.', 'warning');
          return;
        }
        complete?.();
        return;
      }
      if (stack.depth > 1 || quantity || discardOpen) {
        showToast('סיום חלון פעיל', 'יש להשלים או לבטל את החלון הפנימי תחילה.', 'warning');
        return;
      }
      if (operation && operationLocks(operation).exit) {
        showToast('הפעולה מוגנת', 'לא ניתן לצאת בזמן שמצב השמירה אינו ודאי.', 'warning');
        return;
      }
      if (
        summaryReturnRef.current &&
        operation?.phase.kind === 'refresh-required' &&
        operation.phase.intent === 'save-and-close'
      ) {
        showToast('הפעולה מוגנת', 'יש לאמת את נתוני האמת לפני היציאה.', 'warning');
        return;
      }
      closeInitiatorRef.current = initiator;
      navigationRef.current = complete ?? null;
      if (operation?.staged.length) {
        setDiscardOpen(true);
        return;
      }
      closeCard(complete);
    },
    [
      closeCard,
      closeCreation,
      createOpen,
      creation,
      discardOpen,
      operation,
      quantity,
      selectedBorrower,
      showToast,
      stack.depth,
    ],
  );

  useEffect(
    () =>
      desktop?.onResume(() => {
        // Existing frozen-envelope initialization reconciles the exact original keys.
        if (!selectedBorrower && !createOpen) void initialize();
        else showToast('חזרה לעבודה', 'בדקו שמירה ממתינה לפני המשך העבודה.', 'warning');
      }),
    [createOpen, initialize, selectedBorrower, showToast],
  );

  useImperativeHandle(ref, () => ({
    requestNavigation: (complete) => {
      if (desktop && startup !== 'ready') {
        showToast('הפעולה מוגנת', 'יש להשלים שחזור לפני היציאה.', 'warning');
        return;
      }
      requestExit(null, complete);
    },
    openFromSummary: (borrower, onReturn) => {
      if (startup !== 'ready') {
        showToast('פתיחת כרטיס שואל', 'יש להשלים את שחזור הפעולות לפני פתיחת כרטיס.', 'warning');
        return;
      }
      if (selectedBorrower || createOpen || operation?.phase.kind === 'refresh-required') {
        showToast('פתיחת כרטיס שואל', 'יש להשלים את הפעולה הפעילה תחילה.', 'warning');
        return;
      }
      summaryReturnRef.current = onReturn;
      void openBorrower(borrower);
    },
    retryStartup: () => void initialize(),
  }));

  useEffect(() => {
    const protectedCreation = Boolean(createOpen && creation && creationLocks(creation).dismissal);
    const protectedState =
      protectedCreation ||
      Boolean(operation?.staged.length) ||
      Boolean(operation && operationLocks(operation).exit) ||
      Boolean(
        summaryReturnRef.current &&
        operation?.phase.kind === 'refresh-required' &&
        operation.phase.intent === 'save-and-close',
      );
    if (!protectedState) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [createOpen, creation, operation]);

  useEffect(() => {
    const pop = () => {
      if (suppressPopRef.current) {
        suppressPopRef.current = false;
        const complete = navigationRef.current;
        navigationRef.current = null;
        complete?.();
        return;
      }
      if (!sentinelRef.current) return;
      sentinelRef.current = false;
      const protectedCreation = Boolean(
        createOpen && creation && creationLocks(creation).dismissal,
      );
      const exitNeedsGuard =
        protectedCreation ||
        Boolean(operation?.staged.length) ||
        Boolean(operation && operationLocks(operation).exit) ||
        Boolean(
          summaryReturnRef.current &&
          operation?.phase.kind === 'refresh-required' &&
          operation.phase.intent === 'save-and-close',
        ) ||
        stack.depth > 1 ||
        Boolean(quantity) ||
        discardOpen;
      if (exitNeedsGuard) {
        history.pushState({ mapatzBorrowerWorkflow: true }, '', location.href);
        sentinelRef.current = true;
        requestExit(null);
      } else {
        requestExit(null);
      }
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [createOpen, creation, discardOpen, operation, quantity, requestExit, stack.depth]);

  useEffect(() => {
    const feedback = operation?.feedback ?? creation?.feedback;
    if (!feedback) {
      feedbackRef.current = null;
      return;
    }
    if (feedback === feedbackRef.current) return;
    feedbackRef.current = feedback;
    showToast(
      titleForFeedback[feedback.kind],
      translatedFeedback[feedback.code] ?? feedback.message,
      feedback.kind,
    );
  }, [creation?.feedback, operation?.feedback, showToast]);

  useEffect(() => {
    if (!operation || operation.phase.kind !== 'conflicted') return;
    const timer = window.setTimeout(() => {
      document.querySelector<HTMLElement>('[data-compatible="false"]')?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [operation]);

  const openBorrower = async (borrower: Borrower) => {
    const requestId = ++cardLoadRequestRef.current;
    setSelectedBorrower(borrower);
    setCardLoadFailed(false);
    setOperation(null);
    try {
      const snapshot = await fetchBorrowerDeskSnapshot(borrower.id);
      if (requestId !== cardLoadRequestRef.current) return;
      setSelectedBorrower(snapshot.borrower);
      setOperation(createOperationState(snapshot.borrower.id, snapshot));
      if (!sentinelRef.current) {
        history.pushState({ mapatzBorrowerWorkflow: true }, '', location.href);
        sentinelRef.current = true;
      }
    } catch (error) {
      if (requestId !== cardLoadRequestRef.current) return;
      setCardLoadFailed(true);
      showToast(
        'פתיחת כרטיס שואל',
        error instanceof Error ? error.message : 'הטעינה נכשלה',
        'error',
      );
      queueMicrotask(() => retryCardRef.current?.focus());
    }
  };

  const itemOptions = useMemo<ComboboxOption<BorrowerDeskSnapshot['inventory'][number]>[]>(() => {
    if (!operation) return [];
    const query = itemSearch.trim().toLocaleLowerCase();
    return operation.snapshot.inventory
      .filter(
        (item) =>
          item.selectable &&
          (!query ||
            [item.name, String(item.code), ...item.aliases]
              .join(' ')
              .toLocaleLowerCase()
              .includes(query)),
      )
      .map((item) => {
        const available = projectItem(operation, item.id)?.projectedAvailability ?? 0;
        return {
          id: `item-option-${item.id}`,
          value: item,
          label: (
            <>
              <bdi dir="ltr">{item.code}</bdi> — {item.name}
              {item.kind === 'consumable' ? ' · מתכלה' : ''}
            </>
          ),
          description: `זמין: ${available}`,
          disabled: available <= 0,
        };
      });
  }, [itemSearch, operation]);

  const quantityItem =
    quantity && operation
      ? operation.snapshot.inventory.find((item) => item.id === quantity.itemId)
      : undefined;
  if (quantity && operation && !quantityItem)
    throw new Error(`Quantity dialog item ${quantity.itemId} is missing from operation inventory`);

  const submitQuantity = (event: FormEvent) => {
    event.preventDefault();
    if (!operation || !quantity) return;
    const returnKey =
      quantity.condition === 'mark-lost'
        ? `${quantity.itemId}-more`
        : `${quantity.itemId}-${quantity.condition ?? 'usable'}`;
    const returnIndex = [...returnButtonRefs.current.keys()].indexOf(returnKey);
    if (quantity.direction === 'borrow' || quantity.direction === 'issue') {
      const amount = Number(quantity.quantity);
      if (!Number.isSafeInteger(amount) || amount < 1) {
        setQuantity({ ...quantity, error: 'יש להזין כמות חיובית ושלמה' });
        queueMicrotask(() => quantityErrorRef.current?.focus());
        return;
      }
      const available = projectItem(operation, quantity.itemId)?.projectedAvailability;
      if (available == null || amount > available) {
        setQuantity({
          ...quantity,
          error: `ניתן לבחור עד ${available ?? 0} יחידות עבור ${quantityItem?.name ?? ''}`,
        });
        queueMicrotask(() => quantityErrorRef.current?.focus());
        return;
      }
      setOperation(
        operationReducer(operation, {
          type: quantity.direction === 'issue' ? 'stage-issue' : 'stage-borrow',
          itemId: quantity.itemId,
          part: { quantity: amount, note: quantity.note },
        }),
      );
    } else {
      const amount = Number(quantity.quantity);
      const projection = projectItem(operation, quantity.itemId);
      const max =
        quantity.condition === 'found'
          ? (projection?.lostNow ?? 0)
          : (projection?.returnableNow ?? 0);
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > max) {
        setQuantity({
          ...quantity,
          error: `ניתן ${quantity.condition === 'mark-lost' ? 'לסמן כאבוד' : 'להחזיר'} בין 1 ל־${max} יחידות`,
        });
        queueMicrotask(() => quantityErrorRef.current?.focus());
        return;
      }
      setOperation(
        operationReducer(
          operation,
          quantity.condition === 'found'
            ? {
                type: 'stage-lost-credit',
                itemId: quantity.itemId,
                part: {
                  quantity: amount,
                  condition: quantity.damaged ? 'damaged' : 'usable',
                  note: quantity.note,
                },
              }
            : quantity.condition === 'mark-lost'
              ? {
                  type: 'stage-lost',
                  itemId: quantity.itemId,
                  part: { quantity: amount, note: quantity.note },
                }
              : {
                  type: 'stage-return',
                  itemId: quantity.itemId,
                  part: {
                    usable: quantity.damaged ? 0 : amount,
                    damaged: quantity.damaged ? amount : 0,
                    note: quantity.note,
                  },
                },
        ),
      );
      showToast(
        'הפעולה נוספה',
        quantity.condition === 'mark-lost'
          ? 'הכמות הועברה לציוד האבוד וממתינה לשמירה.'
          : 'הפעולה נוספה לרשימת הפעולות הממתינות.',
        'success',
      );
    }
    setQuantity(null);
    window.setTimeout(() => {
      const trigger =
        quantity.direction === 'return'
          ? returnButtonRefs.current.get(returnKey)
          : itemSearchRef.current;
      // Dialog cleanup restores the trigger first. If the operator has already
      // moved elsewhere, this deferred fallback must not steal their focus.
      const active = document.activeElement;
      if (active && active !== document.body && active !== trigger) return;
      if (quantity.direction === 'return') {
        const preferred = returnButtonRefs.current.get(returnKey);
        const remaining = [...returnButtonRefs.current.values()];
        const next = remaining
          .slice(preferred ? remaining.indexOf(preferred) + 1 : Math.max(returnIndex, 0))
          .find((button) => !button.disabled);
        focusWithFallback(
          preferred,
          next ?? document.getElementById('holdings-heading') ?? itemSearchRef.current,
        );
      } else itemSearchRef.current?.focus();
    }, 0);
  };

  const closeQuantity = () => {
    const current = quantity;
    setQuantity(null);
    queueMicrotask(() => {
      if (current?.direction === 'return')
        focusWithFallback(
          returnButtonRefs.current.get(
            current.condition === 'mark-lost'
              ? `${current.itemId}-more`
              : `${current.itemId}-${current.condition ?? 'usable'}`,
          ),
          itemSearchRef.current,
        );
      else itemSearchRef.current?.focus();
    });
  };

  const applyOperationResult = async (
    result: FrozenDispatchResult<FrozenOperationAttempt>,
    source = operation,
  ) => {
    if (!source) return;
    const key = result.attempt.idempotencyKey;
    if (result.kind === 'ambiguous') {
      setOperation(operationReducer(source, { type: 'ambiguous', attemptKey: key }));
      return;
    }
    if (result.kind === 'authorization') {
      setOperation(operationReducer(source, { type: 'authorization', attemptKey: key }));
      return;
    }
    if (result.kind === 'storage-failure') {
      setOperation(
        operationReducer(source, {
          type: 'storage-failure',
          attemptKey: key,
          operation: result.failure.operation === 'remove' ? 'clear' : 'persist',
        }),
      );
      return;
    }
    let next = operationReducer(source, { type: 'result', attemptKey: key, result: result.result });
    setOperation(next);
    if ('outcome' in result.result && result.result.outcome === 'committed') {
      const refreshId = uuid();
      next = operationReducer(next, { type: 'refresh-started', refreshId });
      setOperation(next);
      try {
        const snapshot = await fetchBorrowerDeskSnapshot(source.borrowerId);
        const refreshed = operationReducer(next, {
          type: 'refresh-succeeded',
          refreshId,
          snapshot,
        });
        setOperation(refreshed);
        if (refreshed.phase.kind === 'closed') {
          feedbackRef.current = refreshed.feedback;
          showToast('הפעולה הושלמה', translatedFeedback.operation_saved!, 'success');
          setSearch('');
          closeCard();
        } else if (!operationPresentation(refreshed).cardOpen) {
          setSearch('');
          setSelectedBorrower(null);
          removeSentinel(() => window.setTimeout(() => directoryRecoveryRef.current?.focus(), 0));
        } else queueMicrotask(() => itemSearchRef.current?.focus());
      } catch {
        const failed = operationReducer(next, { type: 'refresh-failed', refreshId });
        setOperation(failed);
        if (summaryReturnRef.current) {
          queueMicrotask(() => retryRefreshRef.current?.focus());
        } else if (!operationPresentation(failed).cardOpen) {
          setSearch('');
          setSelectedBorrower(null);
          removeSentinel(() => window.setTimeout(() => directoryRecoveryRef.current?.focus(), 0));
        } else queueMicrotask(() => retryRefreshRef.current?.focus());
      }
    }
  };

  const save = async (intent: SaveIntent) => {
    if (!operation || !canSave(operation)) return;
    const idempotencyKey = uuid();
    const attempt: FrozenOperationAttempt = {
      version: 1,
      kind: 'operation',
      endpoint: `/borrowers/${operation.borrowerId}/operations`,
      subjectId: operation.borrowerId,
      asOfEventId: operation.snapshot.asOfEventId,
      ledgerEpoch: operation.snapshot.ledgerEpoch,
      intent,
      idempotencyKey,
      body: operationRequest(operation),
    };
    frozenAttemptRef.current = attempt;
    const dispatched = operationReducer(operation, {
      type: 'dispatch',
      attemptKey: idempotencyKey,
      intent,
    });
    setOperation(dispatched);
    await applyOperationResult(
      await dispatchFrozenAttempt(localStorage, attempt, sendFrozenBorrowerAttempt),
      dispatched,
    );
  };

  const retryFrozen = async () => {
    const attempt = frozenAttemptRef.current;
    if (!attempt) return;
    if (attempt.kind === 'operation' && operation?.phase.kind === 'storage-recovery') {
      if (operation.phase.operation === 'persist') {
        const persisted = persistFrozenAttempt(localStorage, attempt);
        if (!persisted.ok) {
          showToast('הפעולה נכשלה', 'לא ניתן לשמור את הפעולה לשחזור.', 'error');
          return;
        }
      }
      const reconciled = operationReducer(operation, {
        type: 'storage-reconciled',
        attemptKey: attempt.idempotencyKey,
        record: 'recoverable',
      });
      setOperation(reconciled);
      await applyOperationResult(
        await resolveFrozenAttempt(localStorage, attempt, sendFrozenBorrowerAttempt),
        reconciled,
      );
      return;
    }
    if (attempt.kind === 'create' && creation?.phase.kind === 'storage-recovery') {
      if (creation.phase.operation === 'clear') {
        const cleared = clearFrozenAttempt(localStorage, attempt);
        if (!cleared.ok) {
          showToast('הפעולה נכשלה', 'לא ניתן לנקות את הפעולה השמורה.', 'error');
          return;
        }
        const reconciled = creationReducer(creation, {
          type: 'storage-reconciled',
          attemptKey: attempt.idempotencyKey,
          record: 'absent',
        });
        try {
          const snapshot = await fetchBorrowerSearch('');
          setSearchSnapshot(snapshot);
          setResolvedSearch('');
          setCreation(
            snapshot.ledgerEpoch === reconciled.values.ledgerEpoch
              ? reconciled
              : createCreationState({
                  ...reconciled.values,
                  ledgerEpoch: snapshot.ledgerEpoch,
                }),
          );
          frozenAttemptRef.current = null;
        } catch {
          showToast('נדרשת תשומת לב', 'הפעולה אושרה, אך נתוני האמת טרם נטענו.', 'warning');
        }
        return;
      }
      const persisted = persistFrozenAttempt(localStorage, attempt);
      if (!persisted.ok) {
        showToast('הפעולה נכשלה', 'לא ניתן לשמור את הפעולה לשחזור.', 'error');
        return;
      }
      const reconciled = creationReducer(creation, {
        type: 'storage-reconciled',
        attemptKey: attempt.idempotencyKey,
        record: 'recoverable',
      });
      setCreation(reconciled);
      await applyCreateResult(
        await resolveFrozenAttempt(localStorage, attempt, sendFrozenBorrowerAttempt),
        reconciled,
      );
      return;
    }
    const result = await resolveFrozenAttempt(localStorage, attempt, sendFrozenBorrowerAttempt);
    if (attempt.kind === 'operation')
      await applyOperationResult(result as FrozenDispatchResult<FrozenOperationAttempt>);
    else await applyCreateResult(result as FrozenDispatchResult<FrozenCreateAttempt>);
  };

  const refreshOperation = async () => {
    if (!operation || operation.phase.kind !== 'refresh-required') return;
    const refreshId = uuid();
    const started = operationReducer(operation, { type: 'refresh-started', refreshId });
    setOperation(started);
    try {
      const snapshot = await fetchBorrowerDeskSnapshot(operation.borrowerId);
      const refreshed = operationReducer(started, {
        type: 'refresh-succeeded',
        refreshId,
        snapshot,
      });
      setOperation(refreshed);
      if (refreshed.phase.kind === 'closed') {
        showToast('הפעולה הושלמה', translatedFeedback.operation_saved!, 'success');
        setSearch('');
        closeCard();
      } else if (!operationPresentation(refreshed).cardOpen)
        queueMicrotask(() => directoryRecoveryRef.current?.focus());
      else queueMicrotask(() => itemSearchRef.current?.focus());
    } catch {
      setOperation(operationReducer(started, { type: 'refresh-failed', refreshId }));
      queueMicrotask(() =>
        (selectedBorrower ? retryRefreshRef : directoryRecoveryRef).current?.focus(),
      );
    }
  };

  const reloadOperation = async () => {
    if (!operation || operation.phase.kind !== 'reload-required') return;
    const reloadId = uuid();
    const started = operationReducer(operation, { type: 'reload-started', reloadId });
    setOperation(started);
    try {
      const snapshot = await fetchBorrowerDeskSnapshot(operation.borrowerId);
      const reloaded = operationReducer(started, { type: 'reload-succeeded', reloadId, snapshot });
      if (reloaded.phase.kind === 'reload-required' && reloaded.phase.reloadId) {
        setOperation(operationReducer(started, { type: 'reload-failed', reloadId }));
        queueMicrotask(() =>
          (selectedBorrower ? retryRefreshRef : directoryRecoveryRef).current?.focus(),
        );
        return;
      }
      setOperation(reloaded);
      if (reloaded.phase.kind === 'closed') {
        feedbackRef.current = reloaded.feedback;
        showToast('הפעולה הושלמה', translatedFeedback.operation_saved!, 'success');
        setSearch('');
        closeCard();
      } else if (!operationPresentation(reloaded).cardOpen)
        queueMicrotask(() => directoryRecoveryRef.current?.focus());
      else queueMicrotask(() => itemSearchRef.current?.focus());
    } catch {
      setOperation(operationReducer(started, { type: 'reload-failed', reloadId }));
      queueMicrotask(() =>
        (selectedBorrower ? retryRefreshRef : directoryRecoveryRef).current?.focus(),
      );
    }
  };

  const beginCreate = () => {
    if (!searchSnapshot) return;
    setCreation(
      createCreationState({
        contractVersion: 1,
        ledgerEpoch: searchSnapshot.ledgerEpoch,
        username: '',
        name: '',
        contact: '',
        type: 'individual',
      }),
    );
    setCreateOpen(true);
    if (!sentinelRef.current) {
      history.pushState({ mapatzBorrowerWorkflow: true }, '', location.href);
      sentinelRef.current = true;
    }
  };

  const loadCreatedCard = async (committed: CreationState) => {
    if (committed.phase.kind !== 'committed') return;
    const requestId = ++cardLoadRequestRef.current;
    const { borrower, loadId } = committed.phase;
    setCreateOpen(false);
    setSelectedBorrower(borrower);
    setCardLoadFailed(false);
    try {
      const snapshot = await fetchBorrowerDeskSnapshot(borrower.id);
      if (requestId !== cardLoadRequestRef.current) return;
      const loaded = creationReducer(committed, { type: 'card-loaded', loadId, snapshot });
      setCreation(loaded);
      if (loaded.phase.kind !== 'opened' || !loaded.openCardSnapshot || !loaded.openCardBorrower) {
        feedbackRef.current = loaded.feedback;
        setCardLoadFailed(true);
        queueMicrotask(() => retryCardRef.current?.focus());
        return;
      }
      setSelectedBorrower(loaded.openCardBorrower);
      setOperation(createOperationState(loaded.openCardBorrower.id, loaded.openCardSnapshot));
      if (!sentinelRef.current) {
        history.pushState({ mapatzBorrowerWorkflow: true }, '', location.href);
        sentinelRef.current = true;
      }
    } catch {
      if (requestId !== cardLoadRequestRef.current) return;
      const failed = creationReducer(committed, { type: 'card-load-failed', loadId });
      feedbackRef.current = failed.feedback;
      setCreation(failed);
      setCardLoadFailed(true);
      queueMicrotask(() => retryCardRef.current?.focus());
    }
  };

  const retryCreatedCard = async () => {
    if (!creation || creation.phase.kind !== 'card-load-failed') return;
    const committed = creationReducer(creation, { type: 'card-load-retry', loadId: uuid() });
    setCreation(committed);
    await loadCreatedCard(committed);
  };

  const reloadCreation = async () => {
    if (!creation || creation.phase.kind !== 'reload-required') return;
    const reloadId = uuid();
    const started = creationReducer(creation, { type: 'reload-started', reloadId });
    setCreation(started);
    try {
      const snapshot = await fetchBorrowerSearch('');
      setSearchSnapshot(snapshot);
      setResolvedSearch('');
      const reloaded = creationReducer(started, {
        type: 'reload-succeeded',
        reloadId,
        ledgerEpoch: snapshot.ledgerEpoch,
      });
      if (reloaded.phase.kind === 'reload-required' && reloaded.phase.reloadId) {
        setCreation(creationReducer(started, { type: 'reload-failed', reloadId }));
        queueMicrotask(() => creationRecoveryRef.current?.focus());
      } else {
        setCreation(reloaded);
        queueMicrotask(() => createFirstRef.current?.focus());
      }
    } catch {
      setCreation(creationReducer(started, { type: 'reload-failed', reloadId }));
      queueMicrotask(() => creationRecoveryRef.current?.focus());
    }
  };

  const applyCreateResult = async (
    result: FrozenDispatchResult<FrozenCreateAttempt>,
    source = creation,
  ) => {
    if (!source) return;
    const key = result.attempt.idempotencyKey;
    if (result.kind === 'ambiguous') {
      setCreation(creationReducer(source, { type: 'ambiguous', attemptKey: key }));
      return;
    }
    if (result.kind === 'authorization') {
      setCreation(creationReducer(source, { type: 'authorization', attemptKey: key }));
      return;
    }
    if (result.kind === 'storage-failure') {
      setCreation(
        creationReducer(source, {
          type: 'storage-failure',
          attemptKey: key,
          operation: result.failure.operation === 'remove' ? 'clear' : 'persist',
        }),
      );
      return;
    }
    const loadId =
      'outcome' in result.result && result.result.outcome === 'committed' ? uuid() : undefined;
    const next = creationReducer(source, {
      type: 'result',
      attemptKey: key,
      result: result.result,
      loadId,
    });
    setCreation(next);
    if ('outcome' in result.result && result.result.outcome === 'committed') {
      feedbackRef.current = next.feedback;
      showToast('הפעולה הושלמה', translatedFeedback.borrower_created!, 'success');
      if (next.phase.kind !== 'committed') return;
      const createdBorrower = next.phase.borrower;
      setSearch('');
      setResolvedSearch('');
      setSearchSnapshot((current) =>
        current ? { ...current, active: [createdBorrower], archivedMatches: [] } : current,
      );
      void refreshDirectoryAfterCreation('');
      await loadCreatedCard(next);
    } else if (next.phase.kind === 'editing' || next.phase.kind === 'conflicted')
      queueMicrotask(() => {
        const field = next.fieldErrors[0]?.field;
        document.querySelector<HTMLInputElement>(`[name="${field ?? 'username'}"]`)?.focus();
      });
  };

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!creation || creationLocks(creation).dispatch) return;
    let normalized = creation;
    for (const field of ['username', 'name', 'contact'] as const) {
      const value = normalized.values[field].trim();
      if (value !== normalized.values[field])
        normalized = creationReducer(normalized, { type: 'change', field, value });
    }
    const idempotencyKey = uuid();
    const attempt: FrozenCreateAttempt = {
      version: 1,
      kind: 'create',
      endpoint: '/borrowers',
      subjectId: null,
      intent: 'create',
      idempotencyKey,
      ledgerEpoch: normalized.values.ledgerEpoch,
      body: { ...normalized.values },
    };
    const dispatched = creationReducer(normalized, {
      type: 'dispatch',
      attemptKey: idempotencyKey,
    });
    setCreation(dispatched);
    if (dispatched.phase.kind !== 'pending') {
      queueMicrotask(() => createFirstRef.current?.focus());
      return;
    }
    frozenAttemptRef.current = attempt;
    await applyCreateResult(
      await dispatchFrozenAttempt(localStorage, attempt, sendFrozenBorrowerAttempt),
      dispatched,
    );
  };

  if (startup !== 'ready' || !searchSnapshot)
    return (
      <section className="borrower-workflow-entry" aria-labelledby="borrower-workflow-title">
        <h2 id="borrower-workflow-title">דלפק השאלות</h2>
        {startup === 'loading' ? (
          <p role="status">בודק פעולות קודמות וטוען נתונים…</p>
        ) : (
          <button
            ref={startupRetryRef}
            type="button"
            className="primary-button"
            onClick={() => void initialize()}
          >
            ניסיון טעינה מחדש
          </button>
        )}
      </section>
    );

  const locked = operation ? operationLocks(operation).mutation : true;
  const deskBlocked = Boolean(operation && !operationPresentation(operation).searchEnabled);
  const directoryResolved = resolvedSearch === search;
  return (
    <section className="borrower-workflow-entry" aria-labelledby="borrower-workflow-title">
      <div className="borrower-workflow-header">
        <div className="borrower-workflow-heading">
          <h2 id="borrower-workflow-title">דלפק השאלות</h2>
          <p>חיפוש שואל, השאלה והחזרה במקום אחד</p>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={!searchSnapshot || deskBlocked}
          onClick={beginCreate}
        >
          יצירת שואל חדש
        </button>
      </div>
      <div className="borrower-search-row">
        <label className="field-label" htmlFor="borrower-directory-search">
          חיפוש שואל
        </label>
        <input
          ref={searchRef}
          id="borrower-directory-search"
          className="input-field"
          type="search"
          value={search}
          onChange={(event) => {
            searchRequestRef.current += 1;
            setSearch(event.target.value);
          }}
          placeholder="שם, שם משתמש או פרטי קשר"
          disabled={deskBlocked}
          aria-describedby="borrower-directory-summary"
        />
      </div>
      <div className="borrower-directory" aria-labelledby="borrower-directory-heading">
        <div className="borrower-directory-summary">
          <h3 id="borrower-directory-heading">שואלים פעילים</h3>
          <p id="borrower-directory-summary" role="status" aria-live="polite">
            {!directoryResolved
              ? 'טוען תוצאות…'
              : searchSnapshot.active.length === 0
                ? search.trim()
                  ? 'לא נמצאו שואלים פעילים מתאימים'
                  : 'אין שואלים פעילים להצגה'
                : searchSnapshot.active.length === 1
                  ? 'שואל פעיל אחד'
                  : `${searchSnapshot.active.length} שואלים פעילים`}
          </p>
        </div>
        <table className="borrower-directory-table">
          <caption className="sr-only">ספריית שואלים פעילים</caption>
          <thead>
            <tr>
              <th scope="col">שם</th>
              <th scope="col">שם משתמש</th>
              <th scope="col">פרטי קשר</th>
              <th scope="col">סוג</th>
            </tr>
          </thead>
          <tbody>
            {!directoryResolved ? (
              <tr>
                <td className="borrower-directory-empty" colSpan={4}>
                  טוען תוצאות…
                </td>
              </tr>
            ) : searchSnapshot.active.length === 0 ? (
              <tr>
                <td className="borrower-directory-empty" colSpan={4}>
                  {search.trim()
                    ? 'נסו שם, שם משתמש או פרטי קשר אחרים.'
                    : 'ניתן ליצור שואל חדש מהפעולה שבראש העמוד.'}
                </td>
              </tr>
            ) : (
              searchSnapshot.active.map((borrower) => (
                <tr
                  key={borrower.id}
                  className="borrower-directory-row"
                  aria-disabled={deskBlocked || undefined}
                  onClick={() => {
                    if (!deskBlocked) void openBorrower(borrower);
                  }}
                >
                  <td data-label="שם">
                    <button
                      type="button"
                      className="borrower-directory-action"
                      disabled={deskBlocked}
                      aria-label={`פתיחת כרטיס שואל — ${borrower.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void openBorrower(borrower);
                      }}
                    >
                      {borrower.name}
                    </button>
                  </td>
                  <td data-label="שם משתמש">
                    <bdi dir="ltr">{borrower.username}</bdi>
                  </td>
                  <td data-label="פרטי קשר">
                    {borrower.contact ? <bdi dir="ltr">{borrower.contact}</bdi> : '—'}
                  </td>
                  <td data-label="סוג">{borrowerTypeNames[borrower.type]}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {directoryResolved && searchSnapshot.archivedMatches.length > 0 && (
        <aside className="borrower-archived-notice" aria-labelledby="archived-match-heading">
          <h3 id="archived-match-heading">התאמות בארכיון</h3>
          <p>השואלים הבאים אינם פעילים ולא ניתן לפתוח אותם מדלפק ההשאלות:</p>
          <ul>
            {searchSnapshot.archivedMatches.map(({ borrower }) => (
              <li key={borrower.id}>
                {borrower.name} · <bdi dir="ltr">{borrower.username}</bdi>
              </li>
            ))}
          </ul>
        </aside>
      )}
      {deskBlocked && operation?.phase.kind === 'refresh-required' && (
        <div className="workflow-recovery-action">
          <button
            ref={directoryRecoveryRef}
            type="button"
            className="primary-button"
            onClick={() => void refreshOperation()}
          >
            אימות נתוני האמת לפני המשך
          </button>
        </div>
      )}
      {deskBlocked && operation?.phase.kind === 'reload-required' && (
        <div className="workflow-recovery-action">
          <button
            ref={directoryRecoveryRef}
            type="button"
            className="primary-button"
            onClick={() => void reloadOperation()}
          >
            טעינת אמת עדכנית
          </button>
        </div>
      )}

      {selectedBorrower && (
        <Dialog
          title={`כרטיס שואל — ${selectedBorrower.name}`}
          level="root"
          role="dialog"
          variant="workspace"
          busy={Boolean(operation && operation.phase.kind === 'saving')}
          dismissible={
            !operation ||
            (!operationLocks(operation).exit &&
              !(
                summaryReturnRef.current &&
                operation.phase.kind === 'refresh-required' &&
                operation.phase.intent === 'save-and-close'
              ))
          }
          onClose={() => requestExit(document.activeElement as HTMLElement | null)}
          returnFocusRef={searchRef}
          initialFocusRef={cardLoadFailed ? retryCardRef : cardOverviewRef}
          actions={
            operation ? (
              <>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={
                    operationLocks(operation).exit ||
                    Boolean(
                      summaryReturnRef.current &&
                      operation.phase.kind === 'refresh-required' &&
                      operation.phase.intent === 'save-and-close',
                    )
                  }
                  onClick={(event) => requestExit(event.currentTarget)}
                >
                  סגירה
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={!canSave(operation)}
                  onClick={() => setReviewOpen(true)}
                >
                  <ClipboardCheck className="size-4" aria-hidden="true" />
                  אישור פעולות
                </button>
              </>
            ) : undefined
          }
        >
          <p ref={cardOverviewRef} className="borrower-identity-meta" tabIndex={-1}>
            <bdi dir="ltr">{selectedBorrower.username}</bdi> · {selectedBorrower.contact}
          </p>
          {cardLoadFailed ? (
            <div className="card-load-failure">
              <button
                ref={retryCardRef}
                type="button"
                className="primary-button"
                onClick={() =>
                  void (creation?.phase.kind === 'card-load-failed'
                    ? retryCreatedCard()
                    : openBorrower(selectedBorrower))
                }
              >
                ניסיון פתיחת הכרטיס מחדש
              </button>
              <button type="button" className="secondary-button" onClick={() => closeCard()}>
                סגירה בטוחה
              </button>
            </div>
          ) : operation ? (
            <div className="borrower-workspace">
              <div className="borrower-item-search">
                <ActiveDescendantCombobox
                  label="חיפוש פריט"
                  value={itemSearch}
                  onChange={setItemSearch}
                  options={itemOptions}
                  onSelect={(item) => {
                    setQuantity({
                      direction: item.kind === 'consumable' ? 'issue' : 'borrow',
                      itemId: item.id,
                      quantity: '1',
                      note: '',
                      error: '',
                      damaged: false,
                    });
                    setItemSearch('');
                  }}
                  placeholder="שם, כינוי או קוד"
                  disabled={locked}
                  openOnFocus
                  inputRef={itemSearchRef}
                />
              </div>
              {operation.phase.kind === 'refresh-required' && (
                <div className="workflow-recovery-action">
                  <button
                    ref={retryRefreshRef}
                    type="button"
                    className="secondary-button"
                    onClick={() => void refreshOperation()}
                  >
                    אימות נתוני האמת מחדש
                  </button>
                </div>
              )}
              <div className="workflow-command-state" aria-live="polite">
                {operation.phase.kind === 'saving' && <span>שומר פעולה…</span>}
                {operation.phase.kind === 'unknown' && (
                  <button
                    ref={retryRefreshRef}
                    type="button"
                    className="secondary-button"
                    onClick={() => void retryFrozen()}
                  >
                    בדיקת תוצאת השמירה
                  </button>
                )}
                {operation.phase.kind === 'storage-recovery' && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void retryFrozen()}
                  >
                    בדיקה חוזרת של הפעולה השמורה
                  </button>
                )}
                {operation.phase.kind === 'reload-required' && (
                  <button
                    ref={retryRefreshRef}
                    type="button"
                    className="secondary-button"
                    onClick={() => void reloadOperation()}
                  >
                    טעינת אמת עדכנית
                  </button>
                )}
              </div>
              <BorrowerOperationalTables
                state={operation}
                disabled={locked}
                returnButtonRefs={returnButtonRefs}
                rollbackButtonRefs={rollbackButtonRefs}
                onReturn={(itemId, condition) => {
                  const projection = projectItem(operation, itemId);
                  const defaultQuantity =
                    condition === 'mark-lost'
                      ? 1
                      : condition === 'found'
                        ? projection?.lostNow
                        : projection?.returnableNow;
                  setQuantity({
                    direction: 'return',
                    condition,
                    itemId,
                    quantity: String(defaultQuantity ?? 1),
                    note: '',
                    error: '',
                    damaged: false,
                  });
                }}
                onRollback={(itemId, direction, condition) => {
                  const keys = [...rollbackButtonRefs.current.keys()];
                  const currentIndex = keys.indexOf(`${itemId}-${direction}-${condition ?? ''}`);
                  setOperation(
                    operationReducer(operation, { type: 'rollback', itemId, direction, condition }),
                  );
                  window.setTimeout(() => {
                    const remaining = [...rollbackButtonRefs.current.values()];
                    const next =
                      remaining[Math.min(Math.max(currentIndex, 0), remaining.length - 1)];
                    if (next) next.focus();
                    else {
                      const heading = document.getElementById('staged-heading');
                      if (heading) heading.focus();
                      else itemSearchRef.current?.focus();
                    }
                  }, 0);
                }}
              />
              <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                {operation.announcement}
              </div>
            </div>
          ) : (
            <p role="status">טוען כרטיס…</p>
          )}
        </Dialog>
      )}

      {quantity && operation && quantityItem && (
        <Dialog
          title={
            quantity.direction === 'issue'
              ? 'ניפוק ציוד מתכלה'
              : quantity.direction === 'borrow'
                ? 'הוספת השאלה'
                : quantity.condition === 'mark-lost'
                  ? 'סמן כאבוד'
                  : quantity.condition === 'found'
                    ? 'נמצא והוחזר'
                    : 'החזרת ציוד'
          }
          description={
            <span className="quantity-dialog-item">
              <span className="quantity-dialog-item-label">פריט: </span>
              <strong className="quantity-dialog-item-name">
                <bdi>{quantityItem.name}</bdi>
              </strong>
            </span>
          }
          level="subordinate"
          role="dialog"
          variant="standard"
          busy={false}
          dismissible={!locked}
          onClose={closeQuantity}
          initialFocusRef={quantityErrorRef}
          actions={
            <>
              <button type="button" className="secondary-button" onClick={closeQuantity}>
                ביטול
              </button>
              <button type="submit" form="quantity-form" className="primary-button">
                אישור
              </button>
            </>
          }
        >
          <form
            id="quantity-form"
            onSubmit={submitQuantity}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              event.currentTarget.requestSubmit();
            }}
            className="dialog-form"
            noValidate
          >
            <label className="field-label">
              כמות
              <input
                ref={quantityErrorRef}
                className="input-field"
                type="number"
                min="1"
                max={
                  quantity.direction === 'return'
                    ? quantity.condition === 'found'
                      ? projectItem(operation, quantity.itemId)?.lostNow
                      : projectItem(operation, quantity.itemId)?.returnableNow
                    : (projectItem(operation, quantity.itemId)?.projectedAvailability ?? undefined)
                }
                aria-invalid={Boolean(quantity.error)}
                value={quantity.quantity}
                onChange={(event) =>
                  setQuantity({ ...quantity, quantity: event.target.value, error: '' })
                }
              />
            </label>
            {quantity.direction === 'return' && quantity.condition !== 'mark-lost' && (
              <label className="quantity-condition-checkbox">
                <input
                  type="checkbox"
                  checked={quantity.damaged}
                  onChange={(event) => setQuantity({ ...quantity, damaged: event.target.checked })}
                />
                <TriangleAlert className="size-4" aria-hidden="true" />
                הציוד הוחזר פגום
              </label>
            )}
            <label className="field-label">
              הערה (רשות)
              <input
                className="input-field"
                value={quantity.note}
                maxLength={500}
                onChange={(event) => setQuantity({ ...quantity, note: event.target.value })}
              />
            </label>
            {quantity.error && (
              <p className="field-error" role="alert">
                {quantity.error}
              </p>
            )}
          </form>
        </Dialog>
      )}

      {reviewOpen && operation && (
        <Dialog
          title="אישור פעולות"
          description="יש לבדוק את כל הפעולות לפני השמירה הסופית."
          level="subordinate"
          role="dialog"
          variant="standard"
          busy={operation.phase.kind === 'saving'}
          dismissible={!operationLocks(operation).exit}
          onClose={() => setReviewOpen(false)}
          initialFocusRef={reviewConfirmRef}
          actions={
            <>
              <button
                type="button"
                className="secondary-button"
                disabled={operationLocks(operation).exit}
                onClick={() => setReviewOpen(false)}
              >
                <Undo2 className="size-4" aria-hidden="true" />
                חזרה לעריכה
              </button>
              <button
                ref={reviewConfirmRef}
                type="button"
                className="primary-button"
                disabled={!canSave(operation)}
                onClick={() => {
                  setReviewOpen(false);
                  void save('save-and-close');
                }}
              >
                <Check className="size-4" aria-hidden="true" />
                אישור ושמירה
              </button>
            </>
          }
        >
          <OperationReview state={operation} />
        </Dialog>
      )}

      {discardOpen && (
        <Dialog
          title="ביטול פעולות ממתינות?"
          description="הפעולות שטרם נשמרו יימחקו."
          level="subordinate"
          role="alertdialog"
          variant="destructive"
          busy={false}
          dismissible
          onClose={() => {
            setDiscardOpen(false);
            queueMicrotask(() =>
              focusWithFallback(closeInitiatorRef.current, itemSearchRef.current),
            );
          }}
          actions={
            <>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setDiscardOpen(false);
                  queueMicrotask(() =>
                    focusWithFallback(closeInitiatorRef.current, itemSearchRef.current),
                  );
                }}
              >
                המשך עבודה
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => {
                  setDiscardOpen(false);
                  const complete = navigationRef.current ?? undefined;
                  window.setTimeout(() => closeCard(complete), 0);
                }}
              >
                מחיקת הפעולות וסגירה
              </button>
            </>
          }
        >
          <p>לא ניתן לשחזר את הפעולות לאחר המחיקה.</p>
        </Dialog>
      )}

      {createOpen && creation && (
        <Dialog
          title="יצירת שואל חדש"
          level="root"
          role="dialog"
          variant="standard"
          busy={creation.phase.kind === 'pending'}
          dismissible={!creationLocks(creation).dismissal}
          onClose={() => requestExit(document.activeElement as HTMLElement | null)}
          returnFocusRef={searchRef}
          initialFocusRef={createFirstRef}
          actions={
            <>
              <button
                type="button"
                className="secondary-button"
                disabled={creationLocks(creation).dismissal}
                onClick={(event) => requestExit(event.currentTarget)}
              >
                ביטול
              </button>
              {creation.phase.kind === 'unknown' || creation.phase.kind === 'storage-recovery' ? (
                <button
                  ref={creationRecoveryRef}
                  type="button"
                  className="primary-button"
                  onClick={() => void retryFrozen()}
                >
                  בדיקת הפעולה
                </button>
              ) : creation.phase.kind === 'reload-required' ? (
                <button
                  ref={creationRecoveryRef}
                  type="button"
                  className="primary-button"
                  disabled={Boolean(creation.phase.reloadId)}
                  onClick={() => void reloadCreation()}
                >
                  טעינת אמת עדכנית
                </button>
              ) : (
                <button
                  type="submit"
                  form="create-borrower-form"
                  className="primary-button"
                  disabled={creationLocks(creation).dispatch}
                >
                  יצירה
                </button>
              )}
            </>
          }
        >
          <form
            id="create-borrower-form"
            className="dialog-form"
            onSubmit={(event) => void submitCreate(event)}
          >
            {(['username', 'name', 'contact'] as const).map((field, index) => (
              <label className="field-label" key={field}>
                {field === 'username' ? 'שם משתמש' : field === 'name' ? 'שם מלא' : 'פרטי קשר'}
                <input
                  ref={index === 0 ? createFirstRef : undefined}
                  name={field}
                  required={field !== 'contact'}
                  minLength={field === 'username' ? 2 : field === 'name' ? 1 : undefined}
                  maxLength={field === 'username' ? 40 : field === 'name' ? 100 : 500}
                  dir={field === 'username' ? 'ltr' : undefined}
                  className="input-field"
                  value={creation.values[field]}
                  onChange={(event) =>
                    setCreation(
                      creationReducer(creation, {
                        type: 'change',
                        field,
                        value: event.target.value,
                      }),
                    )
                  }
                />
                {creation.fieldErrors
                  .filter((error) => error.field === field)
                  .map((error) => (
                    <span key={error.code} className="field-error">
                      {error.message}
                    </span>
                  ))}
              </label>
            ))}
            <label className="field-label">
              סוג
              <select
                name="type"
                className="input-field"
                value={creation.values.type}
                onChange={(event) =>
                  setCreation(
                    creationReducer(creation, {
                      type: 'change',
                      field: 'type',
                      value: event.target.value,
                    }),
                  )
                }
              >
                <option value="individual">יחיד</option>
                <option value="camp_organization">ארגון מחנה</option>
                <option value="other">אחר</option>
              </select>
            </label>
            {creation.phase.kind === 'conflicted' && (
              <div className="creation-matches">
                <p>נמצאו שואלים אפשריים תואמים:</p>
                <ul>
                  {('matches' in creation.phase.validation
                    ? creation.phase.validation.matches
                    : creation.phase.validation.currentValidation.matches
                  ).map(({ borrower, status }) => (
                    <li key={borrower.id}>
                      {borrower.name} — {status === 'archived' ? 'בארכיון' : 'פעיל'}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </form>
        </Dialog>
      )}
    </section>
  );
});
