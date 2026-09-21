import { useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { Dialog } from './Dialog';
import { RECOVERY_IMPORT_CONFIRMATION, RESET_IMPORT_CONFIRMATION } from './import-confirmation';

export type Item = {
  id: number;
  code: number;
  name: string;
  kind: 'consumable' | 'non_consumable' | 'camp_equipment';
  lotSize: number | null;
  locationId: number | null;
  aliases: string[];
  available: number;
  damaged: number;
  archived: boolean;
};

export type Borrower = {
  id: number;
  username: string;
  name: string;
  contact: string;
  type: 'individual' | 'camp_organization' | 'other';
  archived: boolean;
};

export type Loan = {
  checkoutId: number;
  code: number;
  itemName: string;
  borrowerName: string;
  outstanding: number;
  lost: number;
};

export type Location = { id: number; code: string; name: string; archived: boolean };

export type ActiveDialog =
  | { kind: 'lost'; loan: Loan }
  | { kind: 'edit-item'; item: Item }
  | { kind: 'edit-borrower'; borrower: Borrower }
  | { kind: 'edit-location'; location: Location }
  | { kind: 'import'; mode: 'reset' | 'recovery'; file: File };

export type DialogSubmission =
  | { kind: 'lost'; checkoutId: number; quantity: number; lost: true; note: string }
  | {
      kind: 'edit-item';
      itemId: number;
      name: string;
      aliases: string[];
      lotSize: number | null;
      locationId: number | null;
    }
  | {
      kind: 'edit-borrower';
      borrowerId: number;
      name: string;
      username: string;
      contact: string;
      borrowerType: Borrower['type'];
    }
  | { kind: 'edit-location'; locationId: number; name: string; code: string; archived: boolean }
  | { kind: 'import'; mode: 'reset' | 'recovery'; file: File };

function value(form: FormData, name: string): string {
  return String(form.get(name) ?? '');
}

function integer(form: FormData, name: string): number {
  return Number(value(form, name));
}

function ErrorMessage({ error, id }: { error: string; id: string }) {
  return error ? (
    <p className="dialog-form-error" role="alert" id={id}>
      {error}
    </p>
  ) : null;
}

function Actions({ onClose }: { onClose: () => void }) {
  return (
    <div className="dialog-actions">
      <button type="submit" className="primary-button">
        שמירה
      </button>
      <button type="button" className="secondary-button" onClick={onClose}>
        ביטול
      </button>
    </div>
  );
}

function FormDialog({
  title,
  description,
  pending,
  onClose,
  initialFocusRef,
  returnFocusRef,
  fallbackFocusRef,
  onSubmit,
  children,
  error,
}: {
  title: string;
  description: string;
  pending: boolean;
  onClose: () => void;
  initialFocusRef: RefObject<HTMLElement | null>;
  returnFocusRef: RefObject<HTMLElement | null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
  error: string;
}) {
  const errorId = useId();
  return (
    <Dialog
      title={title}
      description={description}
      level="root"
      role="dialog"
      variant="standard"
      busy={pending}
      dismissible={!pending}
      onClose={onClose}
      initialFocusRef={initialFocusRef}
      returnFocusRef={returnFocusRef}
      returnFocusFallbackRef={fallbackFocusRef}
    >
      <form className="dialog-form" noValidate onSubmit={onSubmit}>
        <fieldset
          disabled={pending}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? errorId : undefined}
        >
          <div className="dialog-fields">{children}</div>
          <ErrorMessage error={error} id={errorId} />
          <Actions onClose={onClose} />
        </fieldset>
      </form>
    </Dialog>
  );
}

function LostDialog({
  active,
  pending,
  onClose,
  onSubmit,
  returnFocusRef,
  fallbackFocusRef,
}: DialogProps<{ kind: 'lost'; loan: Loan }>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const maximum = active.loan.outstanding;
  return (
    <FormDialog
      title="סימון ציוד כאבוד"
      description={`${active.loan.itemName} · ${active.loan.borrowerName}`}
      pending={pending}
      onClose={onClose}
      initialFocusRef={inputRef}
      returnFocusRef={returnFocusRef}
      fallbackFocusRef={fallbackFocusRef}
      error={error}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const form = new FormData(event.currentTarget);
        const quantity = integer(form, 'quantity');
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > maximum) {
          setError(`הכמות חייבת להיות מספר שלם בין 1 ל־${maximum}.`);
          return;
        }
        setError('');
        void onSubmit({
          kind: 'lost',
          checkoutId: active.loan.checkoutId,
          quantity,
          lost: true,
          note: value(form, 'note'),
        });
      }}
    >
      <label className="field-label">
        כמות
        <input
          ref={inputRef}
          className="input-field"
          name="quantity"
          type="number"
          min={1}
          max={maximum}
          step={1}
          defaultValue={maximum}
          required
        />
      </label>
      <NoteField />
    </FormDialog>
  );
}

function EditItemDialog({
  active,
  pending,
  onClose,
  onSubmit,
  returnFocusRef,
  fallbackFocusRef,
  locations,
}: DialogProps<{ kind: 'edit-item'; item: Item }> & { locations: Location[] }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const item = active.item;
  const availableLocations = locations.filter(
    (location) => !location.archived || location.id === item.locationId,
  );
  return (
    <FormDialog
      title="עריכת פריט"
      description={`קוד פריט ${item.code}`}
      pending={pending}
      onClose={onClose}
      initialFocusRef={inputRef}
      returnFocusRef={returnFocusRef}
      fallbackFocusRef={fallbackFocusRef}
      error={error}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const form = new FormData(event.currentTarget);
        const name = value(form, 'name').trim();
        const aliases = value(form, 'aliases')
          .split(',')
          .map((alias) => alias.trim())
          .filter(Boolean);
        const lotText = value(form, 'lotSize').trim();
        const lotSize = lotText ? Number(lotText) : null;
        const locationText = value(form, 'locationId');
        const locationId = locationText ? Number(locationText) : null;
        if (name.length < 1 || name.length > 100) {
          setError('שם הפריט חייב להכיל בין 1 ל־100 תווים לאחר הסרת רווחים.');
          return;
        }
        if (aliases.length > 20 || aliases.some((alias) => alias.length > 100)) {
          setError('אפשר להזין עד 20 כינויים, ועד 100 תווים לכל כינוי.');
          return;
        }
        if (lotSize != null && (!Number.isInteger(lotSize) || lotSize < 1)) {
          setError('גודל המארז חייב להיות מספר שלם וחיובי, או להישאר ריק.');
          return;
        }
        setError('');
        void onSubmit({
          kind: 'edit-item',
          itemId: item.id,
          name,
          aliases,
          lotSize,
          locationId,
        });
      }}
    >
      <label className="field-label dialog-field-wide">
        שם פריט
        <input ref={inputRef} className="input-field" name="name" defaultValue={item.name} />
      </label>
      <label className="field-label dialog-field-wide">
        כינויים, מופרדים בפסיק
        <input className="input-field" name="aliases" defaultValue={item.aliases.join(', ')} />
      </label>
      <label className="field-label">
        גודל מארז (רשות)
        <input
          className="input-field"
          name="lotSize"
          type="number"
          min={1}
          step={1}
          defaultValue={item.lotSize ?? ''}
        />
      </label>
      <label className="field-label">
        מיקום
        <select className="input-field" name="locationId" defaultValue={item.locationId ?? ''}>
          <option value="">ללא מיקום</option>
          {availableLocations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
              {location.archived ? ' (בארכיון)' : ''}
            </option>
          ))}
        </select>
      </label>
    </FormDialog>
  );
}

function EditBorrowerDialog({
  active,
  pending,
  onClose,
  onSubmit,
  returnFocusRef,
  fallbackFocusRef,
}: DialogProps<{ kind: 'edit-borrower'; borrower: Borrower }>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const borrower = active.borrower;
  return (
    <FormDialog
      title="עריכת שואל"
      description="עדכון פרטי האדם או הארגון"
      pending={pending}
      onClose={onClose}
      initialFocusRef={inputRef}
      returnFocusRef={returnFocusRef}
      fallbackFocusRef={fallbackFocusRef}
      error={error}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const form = new FormData(event.currentTarget);
        const name = value(form, 'name').trim();
        const username = value(form, 'username').trim();
        const contact = value(form, 'contact');
        if (name.length < 1 || name.length > 100) {
          setError('השם חייב להכיל בין 1 ל־100 תווים לאחר הסרת רווחים.');
          return;
        }
        if (username.length < 2 || username.length > 40) {
          setError('שם המשתמש חייב להכיל בין 2 ל־40 תווים לאחר הסרת רווחים.');
          return;
        }
        if (contact.length > 500) {
          setError('פרטי הקשר יכולים להכיל עד 500 תווים.');
          return;
        }
        setError('');
        void onSubmit({
          kind: 'edit-borrower',
          borrowerId: borrower.id,
          name,
          username,
          contact,
          borrowerType: value(form, 'type') as Borrower['type'],
        });
      }}
    >
      <label className="field-label">
        שם
        <input ref={inputRef} className="input-field" name="name" defaultValue={borrower.name} />
      </label>
      <label className="field-label">
        שם משתמש
        <input className="input-field" name="username" dir="ltr" defaultValue={borrower.username} />
      </label>
      <label className="field-label dialog-field-wide">
        פרטי קשר
        <input className="input-field" name="contact" defaultValue={borrower.contact} />
      </label>
      <label className="field-label dialog-field-wide">
        סוג
        <select className="input-field" name="type" defaultValue={borrower.type}>
          <option value="individual">יחיד</option>
          <option value="camp_organization">ארגון מחנה</option>
          <option value="other">אחר</option>
        </select>
      </label>
    </FormDialog>
  );
}

function EditLocationDialog({
  active,
  pending,
  onClose,
  onSubmit,
  returnFocusRef,
  fallbackFocusRef,
}: DialogProps<{ kind: 'edit-location'; location: Location }>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const location = active.location;
  return (
    <FormDialog
      title="עריכת מיקום"
      description="עדכון שם וקוד אזור האחסון"
      pending={pending}
      onClose={onClose}
      initialFocusRef={inputRef}
      returnFocusRef={returnFocusRef}
      fallbackFocusRef={fallbackFocusRef}
      error={error}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const form = new FormData(event.currentTarget);
        const name = value(form, 'name').trim();
        const code = value(form, 'code').trim();
        if (name.length < 1 || name.length > 100 || code.length < 1 || code.length > 40) {
          setError('השם והקוד חייבים להיות מלאים, עד 100 ו־40 תווים בהתאמה.');
          return;
        }
        setError('');
        void onSubmit({
          kind: 'edit-location',
          locationId: location.id,
          name,
          code,
          archived: location.archived,
        });
      }}
    >
      <label className="field-label">
        שם
        <input ref={inputRef} className="input-field" name="name" defaultValue={location.name} />
      </label>
      <label className="field-label">
        קוד
        <input className="input-field" name="code" dir="ltr" defaultValue={location.code} />
      </label>
    </FormDialog>
  );
}

function ImportDialog({
  active,
  pending,
  onClose,
  onSubmit,
  returnFocusRef,
  fallbackFocusRef,
}: DialogProps<{ kind: 'import'; mode: 'reset' | 'recovery'; file: File }>) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const reset = active.mode === 'reset';
  return (
    <Dialog
      title={reset ? 'אישור ייבוא איפוס' : 'אישור שחזור מלא'}
      description={reset ? RESET_IMPORT_CONFIRMATION : RECOVERY_IMPORT_CONFIRMATION}
      level="root"
      role="alertdialog"
      variant="destructive"
      busy={pending}
      dismissible={!pending}
      onClose={onClose}
      initialFocusRef={cancelRef}
      returnFocusRef={returnFocusRef}
      returnFocusFallbackRef={fallbackFocusRef}
      showClose={false}
    >
      <p className="dialog-file-name">
        קובץ: <bdi>{active.file.name}</bdi>
      </p>
      <fieldset disabled={pending} className="dialog-actions dialog-actions-destructive">
        <button
          type="button"
          className="danger-button"
          onClick={() => {
            if (!pending) void onSubmit({ kind: 'import', mode: active.mode, file: active.file });
          }}
        >
          {reset ? 'מחק וייבא' : 'החלף ושחזר'}
        </button>
        <button
          ref={cancelRef}
          type="button"
          className="secondary-button"
          onClick={onClose}
          autoFocus
        >
          ביטול
        </button>
      </fieldset>
    </Dialog>
  );
}

function NoteField() {
  return (
    <label className="field-label dialog-field-wide">
      הערה (רשות)
      <textarea className="input-field dialog-textarea" name="note" maxLength={500} />
    </label>
  );
}

type DialogProps<T extends ActiveDialog> = {
  active: T;
  pending: boolean;
  onClose: () => void;
  onSubmit: (submission: DialogSubmission) => Promise<boolean>;
  returnFocusRef: RefObject<HTMLElement | null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
};

export function InventoryDialog({
  active,
  pending,
  locations,
  onClose,
  onSubmit,
  returnFocusRef,
  fallbackFocusRef,
}: {
  active: ActiveDialog;
  pending: boolean;
  locations: Location[];
  onClose: () => void;
  onSubmit: (submission: DialogSubmission) => Promise<boolean>;
  returnFocusRef: RefObject<HTMLElement | null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
}) {
  const props = { pending, onClose, onSubmit, returnFocusRef, fallbackFocusRef };
  switch (active.kind) {
    case 'lost':
      return <LostDialog active={active} {...props} />;
    case 'edit-item':
      return <EditItemDialog active={active} locations={locations} {...props} />;
    case 'edit-borrower':
      return <EditBorrowerDialog active={active} {...props} />;
    case 'edit-location':
      return <EditLocationDialog active={active} {...props} />;
    case 'import':
      return <ImportDialog active={active} {...props} />;
  }
}
