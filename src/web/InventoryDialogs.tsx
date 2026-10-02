import { useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { Dialog } from './Dialog';
import { RECOVERY_IMPORT_CONFIRMATION, RESET_IMPORT_CONFIRMATION } from './import-confirmation';

export type Item = {
  id: number;
  name: string;
  kind: 'consumable' | 'non_consumable' | 'camp_equipment';
  lotSize: number | null;
  locationId: number | null;
  aliases: string[];
  available: number;
  borrowed: number;
  lost: number;
  damaged: number;
  stockRevision: number;
  archived: boolean;
};

export type Borrower = {
  id: number;
  playaName: string;
  fullName: string;
  phoneNumber: string;
  campDepartment: string;
  archived: boolean;
};

export type Location = { id: number; code: string; name: string; archived: boolean };

export type ActiveDialog =
  | { kind: 'edit-borrower'; borrower: Borrower }
  | { kind: 'import'; mode: 'reset' | 'recovery'; file: File };

export type DialogSubmission =
  | {
      kind: 'edit-borrower';
      borrowerId: number;
      fullName: string;
      playaName: string;
      phoneNumber: string;
      campDepartment: string;
    }
  | { kind: 'import'; mode: 'reset' | 'recovery'; file: File };

function value(form: FormData, name: string): string {
  return String(form.get(name) ?? '');
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
        const fullName = value(form, 'fullName').trim();
        const playaName = value(form, 'playaName').trim();
        const phoneNumber = value(form, 'phoneNumber').trim();
        const campDepartment = value(form, 'campDepartment').trim();
        if (
          !fullName ||
          [fullName, playaName, phoneNumber, campDepartment].some((entry) => entry.length > 100)
        ) {
          setError('שם מלא הוא חובה וכל שדה יכול להכיל עד 100 תווים.');
          return;
        }
        setError('');
        void onSubmit({
          kind: 'edit-borrower',
          borrowerId: borrower.id,
          fullName,
          playaName,
          phoneNumber,
          campDepartment,
        });
      }}
    >
      <label className="field-label">
        שם מלא
        <input
          ref={inputRef}
          className="input-field"
          name="fullName"
          required
          maxLength={100}
          defaultValue={borrower.fullName}
        />
      </label>
      <label className="field-label">
        שם פלאיה
        <input
          className="input-field"
          name="playaName"
          maxLength={100}
          defaultValue={borrower.playaName}
        />
      </label>
      <label className="field-label dialog-field-wide">
        מספר טלפון
        <input
          className="input-field"
          name="phoneNumber"
          type="tel"
          dir="ltr"
          maxLength={100}
          defaultValue={borrower.phoneNumber}
        />
      </label>
      <label className="field-label dialog-field-wide">
        מחנה / מחלקה
        <input
          className="input-field"
          name="campDepartment"
          maxLength={100}
          defaultValue={borrower.campDepartment}
          list="borrower-camp-suggestions"
        />
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
  onClose,
  onSubmit,
  returnFocusRef,
  fallbackFocusRef,
}: {
  active: ActiveDialog;
  pending: boolean;
  onClose: () => void;
  onSubmit: (submission: DialogSubmission) => Promise<boolean>;
  returnFocusRef: RefObject<HTMLElement | null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
}) {
  const props = { pending, onClose, onSubmit, returnFocusRef, fallbackFocusRef };
  switch (active.kind) {
    case 'edit-borrower':
      return <EditBorrowerDialog active={active} {...props} />;
    case 'import':
      return <ImportDialog active={active} {...props} />;
  }
}
