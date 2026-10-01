import {
  ChevronDown,
  CircleCheck,
  CircleHelp,
  SearchCheck,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { projectItem, projectedItems, type OperationState } from './borrower-workflow-state';

const conflictLabels: Record<string, string> = {
  borrower_inactive: 'השואל אינו פעיל',
  item_not_found: 'הפריט אינו קיים עוד',
  item_archived: 'הפריט הועבר לארכיון',
  wrong_item_kind: 'סוג הפריט אינו מתאים להשאלה',
  insufficient_stock: 'אין די מלאי זמין',
  returnable_balance_changed: 'יתרת ההחזרה השתנתה',
  held_balance_changed: 'יתרת הציוד אצל השואל השתנתה',
  lost_balance_changed: 'יתרת הציוד האבוד השתנתה',
};

export type ReturnCondition = 'usable' | 'mark-lost' | 'found';

const actions: Record<ReturnCondition, { label: string; icon: LucideIcon; description: string }> = {
  usable: {
    label: 'החזרת ציוד',
    icon: CircleCheck,
    description: 'הציוד התקבל תקין בדלפק ויוסר מאחריות השואל.',
  },
  'mark-lost': {
    label: 'סמן כאבוד',
    icon: CircleHelp,
    description: 'הכמות תעבור לרשימת הציוד האבוד ותישאר באחריות השואל.',
  },
  found: {
    label: 'נמצא והוחזר',
    icon: SearchCheck,
    description: 'הציוד האבוד התקבל בדלפק ויוסר מאחריות השואל.',
  },
};

export function BorrowerOperationalTables({
  state,
  disabled,
  onReturn,
  onRollback,
  returnButtonRefs,
  rollbackButtonRefs,
}: {
  state: OperationState;
  disabled: boolean;
  onReturn: (itemId: number, condition: ReturnCondition) => void;
  onRollback: (
    itemId: number,
    direction: 'borrow' | 'issue' | 'usable' | 'damaged' | 'lost' | 'lostCredit',
    condition?: 'usable' | 'damaged',
  ) => void;
  returnButtonRefs?: RefObject<Map<string, HTMLButtonElement>>;
  rollbackButtonRefs?: RefObject<Map<string, HTMLButtonElement>>;
}) {
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inventory = new Map(state.snapshot.inventory.map((item) => [item.id, item]));
  const projections = state.unverifiedProjection ?? projectedItems(state);
  const held = projections.filter((projection) => projection.projectedHeld > 0);
  const lost = projections.filter((projection) => projection.lostNow > 0);
  const lostTotal = lost.reduce((sum, projection) => sum + projection.lostNow, 0);

  useEffect(() => {
    if (openMenu === null) return;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenMenu(null);
      else if (!(event.target as Element).closest('.borrower-more-actions')) setOpenMenu(null);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [openMenu]);

  const setButtonRef = (key: string, node: HTMLButtonElement | null) => {
    if (node) returnButtonRefs?.current.set(key, node);
    else returnButtonRefs?.current.delete(key);
  };
  const open = (itemId: number, condition: ReturnCondition) => {
    setOpenMenu(null);
    onReturn(itemId, condition);
  };
  const handleMenuKeys = (event: KeyboardEvent<HTMLDivElement>, itemId: number) => {
    const choices = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];
    const current = choices.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpenMenu(null);
      returnButtonRefs?.current.get(`${itemId}-more`)?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? choices.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
    choices[next]?.focus();
  };

  return (
    <div ref={rootRef} className="borrower-work-segment">
      <section className="operational-section staged-section" aria-labelledby="staged-heading">
        <h3 id="staged-heading" tabIndex={-1}>
          פעולות ממתינות
        </h3>
        {state.staged.length === 0 ? (
          <p className="operational-empty">אין פעולות ממתינות</p>
        ) : (
          <div className="borrower-pending-list">
            {state.staged.flatMap((group) => {
              const projection = projectItem(state, group.itemId);
              const rows: Array<{
                direction: 'borrow' | 'issue' | 'usable' | 'damaged' | 'lost' | 'lostCredit';
                condition?: 'usable' | 'damaged';
                quantity: number;
                label: string;
                notes: string[];
              }> = [];
              if (group.borrow.length)
                rows.push({
                  direction: 'borrow',
                  quantity: projection?.stagedBorrow ?? 0,
                  label: 'השאלה',
                  notes: group.borrow.map((part) => part.note),
                });
              if ((group.issue ?? []).length)
                rows.push({
                  direction: 'issue',
                  quantity: (group.issue ?? []).reduce((sum, part) => sum + part.quantity, 0),
                  label: 'ניפוק · מתכלה',
                  notes: (group.issue ?? []).map((part) => part.note),
                });
              const usable = group.return.reduce((total, part) => total + part.usable, 0);
              if (usable > 0)
                rows.push({
                  direction: 'usable',
                  quantity: usable,
                  label: actions.usable.label,
                  notes: group.return.filter((part) => part.usable > 0).map((part) => part.note),
                });
              const damaged = group.return.reduce((total, part) => total + part.damaged, 0);
              if (damaged > 0)
                rows.push({
                  direction: 'damaged',
                  quantity: damaged,
                  label: 'החזרת ציוד · פגום',
                  notes: group.return.filter((part) => part.damaged > 0).map((part) => part.note),
                });
              if ((group.lost ?? []).length)
                rows.push({
                  direction: 'lost',
                  quantity: projection?.stagedLost ?? 0,
                  label: actions['mark-lost'].label,
                  notes: (group.lost ?? []).map((part) => part.note),
                });
              for (const condition of ['usable', 'damaged'] as const) {
                const parts = (group.lostCredit ?? []).filter(
                  (part) => part.condition === condition,
                );
                if (parts.length)
                  rows.push({
                    direction: 'lostCredit',
                    condition,
                    quantity: parts.reduce((sum, part) => sum + part.quantity, 0),
                    label: condition === 'damaged' ? 'נמצא והוחזר · פגום' : actions.found.label,
                    notes: parts.map((part) => part.note),
                  });
              }
              return rows.map((row) => (
                <div
                  className="borrower-pending-row"
                  key={`${group.itemId}-${row.direction}-${row.condition ?? ''}`}
                  data-compatible={projection?.compatible}
                  tabIndex={projection?.compatible ? undefined : -1}
                >
                  <div>
                    <strong>{inventory.get(group.itemId)?.name ?? 'פריט לא זמין'}</strong>
                    <p>
                      {(row.direction === 'damaged' || row.condition === 'damaged') && (
                        <TriangleAlert className="size-4 inline-block" aria-hidden="true" />
                      )}{' '}
                      {row.label} · {Math.abs(row.quantity)}
                    </p>
                    {row.notes.filter(Boolean).map((note, index) => (
                      <p className="borrower-pending-note" key={index}>
                        {note}
                      </p>
                    ))}
                    {projection && !projection.compatible && (
                      <div className="field-error" role="alert">
                        <p>הפעולה אינה תואמת עוד למצב המלאי</p>
                        {projection.conflicts.map((conflict, index) => (
                          <span key={`${conflict.code}-${index}`}>
                            {conflictLabels[conflict.code] ?? conflict.code}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    ref={(node) => {
                      const key = `${group.itemId}-${row.direction}-${row.condition ?? ''}`;
                      if (node) rollbackButtonRefs?.current.set(key, node);
                      else rollbackButtonRefs?.current.delete(key);
                    }}
                    type="button"
                    className="small-button"
                    disabled={disabled}
                    onClick={() => onRollback(group.itemId, row.direction, row.condition)}
                  >
                    <Undo2 className="size-4" aria-hidden="true" />
                    ביטול פעולה
                  </button>
                </div>
              ));
            })}
          </div>
        )}
      </section>

      <div className="borrower-status-column">
        <section
          className="operational-section holdings-section"
          aria-labelledby="holdings-heading"
        >
          <h3 id="holdings-heading" tabIndex={-1}>
            ציוד אצל השואל
            {state.unverifiedProjection && <span className="unverified-label"> — טרם אומת</span>}
          </h3>
          {held.length === 0 ? (
            <p className="operational-empty">אין ציוד אצל השואל</p>
          ) : (
            <table
              className="operational-table borrower-equipment-table"
              aria-labelledby="holdings-heading"
            >
              <thead>
                <tr>
                  <th scope="col">פריט</th>
                  <th scope="col" aria-label="אצל השואל">
                    <span className="borrower-held-header-full">אצל השואל</span>
                    <span className="borrower-held-header-compact" aria-hidden="true">
                      כמות
                    </span>
                  </th>
                  <th scope="col">פעולות</th>
                </tr>
              </thead>
              <tbody>
                {held.map((projection) => {
                  const itemName = inventory.get(projection.itemId)?.name ?? 'פריט לא זמין';
                  const menuOpen = openMenu === projection.itemId;
                  return (
                    <tr key={projection.itemId}>
                      <th scope="row">{itemName}</th>
                      <td>
                        <bdi dir="ltr" className="operational-quantity">
                          {projection.projectedHeld}
                        </bdi>
                      </td>
                      <td>
                        <div className="holding-return-actions">
                          <button
                            ref={(node) => setButtonRef(`${projection.itemId}-usable`, node)}
                            type="button"
                            className="small-button"
                            disabled={
                              disabled ||
                              projection.returnableNow < 1 ||
                              !inventory.get(projection.itemId)?.selectable
                            }
                            onClick={() => open(projection.itemId, 'usable')}
                          >
                            <CircleCheck className="size-4" aria-hidden="true" />
                            החזרת ציוד
                          </button>
                          <div
                            className="borrower-more-actions"
                            onBlur={(event) => {
                              if (!event.currentTarget.contains(event.relatedTarget))
                                setOpenMenu(null);
                            }}
                          >
                            <button
                              ref={(node) => setButtonRef(`${projection.itemId}-more`, node)}
                              id={`borrower-more-trigger-${projection.itemId}`}
                              type="button"
                              className="small-button"
                              aria-haspopup="menu"
                              aria-expanded={menuOpen}
                              aria-controls={`borrower-more-menu-${projection.itemId}`}
                              disabled={disabled || projection.returnableNow < 1}
                              onClick={() => {
                                const next = menuOpen ? null : projection.itemId;
                                setOpenMenu(next);
                                if (next !== null)
                                  queueMicrotask(() =>
                                    document
                                      .querySelector<HTMLButtonElement>(
                                        `#borrower-more-menu-${projection.itemId} [role="menuitem"]`,
                                      )
                                      ?.focus(),
                                  );
                              }}
                              onKeyDown={(event) => {
                                if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
                                event.preventDefault();
                                setOpenMenu(projection.itemId);
                                queueMicrotask(() => {
                                  const choices = document.querySelectorAll<HTMLButtonElement>(
                                    `#borrower-more-menu-${projection.itemId} [role="menuitem"]`,
                                  );
                                  choices[
                                    event.key === 'ArrowUp' ? choices.length - 1 : 0
                                  ]?.focus();
                                });
                              }}
                            >
                              <ChevronDown className="size-4" aria-hidden="true" />
                              אפשרויות נוספות
                            </button>
                            {menuOpen && (
                              <div
                                id={`borrower-more-menu-${projection.itemId}`}
                                className="borrower-action-menu"
                                role="menu"
                                aria-labelledby={`borrower-more-trigger-${projection.itemId}`}
                                onKeyDown={(event) => handleMenuKeys(event, projection.itemId)}
                              >
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => open(projection.itemId, 'mark-lost')}
                                >
                                  <CircleHelp className="size-4" aria-hidden="true" />
                                  סמן כאבוד
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <details className="operational-section lost-equipment-section">
          <summary
            id="lost-equipment-heading"
            aria-label={`ציוד אבוד של השואל, ${lostTotal} ${lostTotal === 1 ? 'יחידה' : 'יחידות'}`}
          >
            <span>ציוד אבוד של השואל</span>
            <bdi dir="ltr">({lostTotal})</bdi>
          </summary>
          {lost.length === 0 ? (
            <p className="operational-empty">אין ציוד אבוד לשואל</p>
          ) : (
            <table
              className="operational-table borrower-equipment-table"
              aria-labelledby="lost-equipment-heading"
            >
              <thead>
                <tr>
                  <th scope="col">פריט</th>
                  <th scope="col">אבוד</th>
                  <th scope="col">פעולות</th>
                </tr>
              </thead>
              <tbody>
                {lost.map((projection) => {
                  const itemName = inventory.get(projection.itemId)?.name ?? 'פריט לא זמין';
                  return (
                    <tr key={projection.itemId}>
                      <th scope="row">{itemName}</th>
                      <td>
                        <bdi dir="ltr" className="operational-quantity">
                          {projection.lostNow}
                        </bdi>
                      </td>
                      <td>
                        <button
                          ref={(node) => setButtonRef(`${projection.itemId}-found`, node)}
                          type="button"
                          className="small-button"
                          disabled={
                            disabled ||
                            projection.lostNow < 1 ||
                            !inventory.get(projection.itemId)?.selectable
                          }
                          onClick={() => open(projection.itemId, 'found')}
                        >
                          <SearchCheck className="size-4" aria-hidden="true" />
                          נמצא והוחזר
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </details>
      </div>
    </div>
  );
}
