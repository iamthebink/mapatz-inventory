import type { RefObject } from 'react';
import { CircleCheck, SearchCheck, TriangleAlert, type LucideIcon } from 'lucide-react';
import { projectItem, projectedItems, type OperationState } from './borrower-workflow-state';

const conflictLabels: Record<string, string> = {
  borrower_inactive: 'השואל אינו פעיל',
  item_not_found: 'הפריט אינו קיים עוד',
  item_archived: 'הפריט הועבר לארכיון',
  wrong_item_kind: 'סוג הפריט אינו מתאים להשאלה',
  insufficient_stock: 'אין די מלאי זמין',
  returnable_balance_changed: 'יתרת ההחזרה השתנתה',
  lost_balance_changed: 'יתרת הציוד האבוד השתנתה',
};

export type ReturnCondition = 'usable' | 'lost' | 'damaged';

const returnActions: ReadonlyArray<{
  condition: ReturnCondition;
  label: string;
  icon: LucideIcon;
}> = [
  { condition: 'usable', label: 'תקין', icon: CircleCheck },
  { condition: 'lost', label: 'אבוד', icon: SearchCheck },
  { condition: 'damaged', label: 'פגום', icon: TriangleAlert },
];

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
  onRollback: (itemId: number, direction: 'borrow' | 'usable' | 'damaged' | 'lostCredit') => void;
  returnButtonRefs?: RefObject<Map<string, HTMLButtonElement>>;
  rollbackButtonRefs?: RefObject<Map<string, HTMLButtonElement>>;
}) {
  const inventory = new Map(state.snapshot.inventory.map((item) => [item.id, item]));
  const projections = state.unverifiedProjection ?? projectedItems(state);
  const holdings = projections.filter(
    (projection) => projection.projectedHeld > 0 || projection.lostNow > 0,
  );
  return (
    <div className="borrower-work-segment">
      <section className="operational-section staged-section" aria-labelledby="staged-heading">
        <h3 id="staged-heading" tabIndex={-1}>
          פעולות ממתינות
        </h3>
        {state.staged.length === 0 ? (
          <p className="operational-empty">אין פעולות ממתינות</p>
        ) : (
          <table className="operational-table">
            <thead>
              <tr>
                <th>פריט</th>
                <th>פעולה</th>
                <th>כמות</th>
                <th>הערות</th>
                <th>פעולות</th>
              </tr>
            </thead>
            <tbody>
              {state.staged.flatMap((group) => {
                const projection = projectItem(state, group.itemId);
                const rows: Array<{
                  direction: 'borrow' | 'usable' | 'damaged' | 'lostCredit';
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
                const usable = group.return.reduce((total, part) => total + part.usable, 0);
                if (usable > 0)
                  rows.push({
                    direction: 'usable',
                    quantity: usable,
                    label: 'החזרה תקינה',
                    notes: group.return.filter((part) => part.usable > 0).map((part) => part.note),
                  });
                const damaged = group.return.reduce((total, part) => total + part.damaged, 0);
                if (damaged > 0)
                  rows.push({
                    direction: 'damaged',
                    quantity: damaged,
                    label: 'החזרה פגומה',
                    notes: group.return.filter((part) => part.damaged > 0).map((part) => part.note),
                  });
                if ((group.lostCredit ?? []).length)
                  rows.push({
                    direction: 'lostCredit',
                    quantity: projection?.stagedLostCredit ?? 0,
                    label: 'החזרת אבוד',
                    notes: (group.lostCredit ?? []).map((part) => part.note),
                  });
                return rows.map((row) => (
                  <tr
                    key={`${group.itemId}-${row.direction}`}
                    data-compatible={projection?.compatible}
                    tabIndex={projection?.compatible ? undefined : -1}
                  >
                    <td>{inventory.get(group.itemId)?.name ?? `#${group.itemId}`}</td>
                    <td>{row.label}</td>
                    <td>
                      <bdi dir="ltr" className="operational-quantity">
                        {Math.abs(row.quantity)}
                      </bdi>
                    </td>
                    <td>
                      {row.notes.filter(Boolean).map((note, index) => (
                        <div key={index}>{note}</div>
                      ))}
                    </td>
                    <td>
                      <button
                        ref={(node) => {
                          const key = `${group.itemId}-${row.direction}`;
                          if (node) rollbackButtonRefs?.current.set(key, node);
                          else rollbackButtonRefs?.current.delete(key);
                        }}
                        type="button"
                        className="small-button"
                        disabled={disabled}
                        onClick={() => onRollback(group.itemId, row.direction)}
                      >
                        ביטול פעולה
                      </button>
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
                    </td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        )}
      </section>
      <section className="operational-section holdings-section" aria-labelledby="holdings-heading">
        <h3 id="holdings-heading" tabIndex={-1}>
          ציוד באחריות השואל
          {state.unverifiedProjection && <span className="unverified-label"> — טרם אומת</span>}
        </h3>
        {holdings.length === 0 ? (
          <p className="operational-empty">אין ציוד באחריות השואל</p>
        ) : (
          <table className="operational-table">
            <thead>
              <tr>
                <th>פריט</th>
                <th>תקין</th>
                <th>אבוד</th>
                <th>פעולות החזרה</th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((projection) => (
                <tr key={projection.itemId}>
                  <td>{inventory.get(projection.itemId)?.name ?? `#${projection.itemId}`}</td>
                  <td>
                    <bdi dir="ltr" className="operational-quantity">
                      {projection.projectedHeld}
                    </bdi>
                  </td>
                  <td>
                    <bdi dir="ltr" className="operational-quantity">
                      {projection.lostNow}
                    </bdi>
                  </td>
                  <td>
                    <div className="holding-return-actions">
                      {returnActions.map(({ condition, label, icon: Icon }) => {
                        const balance =
                          condition === 'lost' ? projection.lostNow : projection.returnableNow;
                        return (
                          <button
                            key={condition}
                            ref={(node) => {
                              const key = `${projection.itemId}-${condition}`;
                              if (node) returnButtonRefs?.current.set(key, node);
                              else returnButtonRefs?.current.delete(key);
                            }}
                            type="button"
                            className="small-button"
                            disabled={
                              disabled ||
                              balance < 1 ||
                              !inventory.get(projection.itemId)?.selectable
                            }
                            onClick={() => onReturn(projection.itemId, condition)}
                          >
                            <Icon className="size-3.5" aria-hidden="true" />
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
