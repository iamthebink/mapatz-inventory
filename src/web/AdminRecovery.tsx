import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Dialog } from './Dialog';
import { Toast, type ToastMessage } from './Toast';
import { api } from './api';
import {
  acceptsRecoveryPhrase,
  additionOperands,
  createRecoveryExercises,
  parseRecoveryNumber,
  type RecoveryStage,
} from './admin-password-recovery';

const celebrationDurationMs = 1400;

const copy = {
  welcome: 'ברוכים הבאים לתהליך שחזור סיסמת המנהל. לחצו להמשך:',
  phrase:
    'יופי, מודעות עצמית היא הצעד הראשון לשחזור סיסמה מוצלח. להצגת הסיסמה, אנא הקלידו ״תראה לי את הסיסמה בבקשה״, ולחצו לאישור.',
  addition:
    'מעולה, כל הכבוד שהבעת את רצונך. חשוב ומבורך. ביטוי עצמי רדיקלי. תיכף אראה לך את הסיסמה, אבל בזמן שאני הולך להביא אותה, סכמו את המספרים הבאים:',
  changed: 'וופס, שיט, סליחה, התכוונתי למספרים האלה:',
  integral: 'מעולה, עכשיו שעשינו חימום, מצאו את האינטגרל המסוים הבא:',
  skip: 'טוב ביץ׳, נעבור לשלב הבא. שתדע.י, אלה שפתרו את האינטגרל ראו מיד את הסיסמה. לך יש עוד שלב אחד פשוט:',
  solved: 'טוב, לא באמת היית אמור.ה לפתור את האינטגרל, אבל בגלל שהשקעת, בבקשה:',
  compliment: 'הסיסמה אצלי. אבל כל הזמן הזה רק ביקשת דברים. מה איתי? תגידו משהו נחמד.',
  refused: 'מצטער שנתתי רושם שאני מציע. אני לא. תיתן.י לי מחמאה, מדרפאקר.',
  forced:
    'אתה ליטרלי התוכנה הכי טובה שהשתמשתי בה בחיים. כל לחיצת כפתור היא תענוג עילאי ואני מוקיר תודה תודה על זה שמותר לי אפילו לגעת בך.',
  thanked: 'תודה. הייתי צריך לשמוע את זה. הנה הסיסמה.',
};
const errors = {
  phrase: 'זאת לא הבקשה. העתקה מהמסך עדיין מותרת, גאון.ית.',
  addition: 'לא ממש. שני מספרים, חיבור אחד. עוד ניסיון?',
  integral: 'לא זה. האינטגרל נשאר, אבל גם כפתור הוויתור.',
};

type RecoveryCelebration = 'star' | 'stamp' | 'clap' | 'confetti';
type ComplimentState =
  | { kind: 'choice'; selected: 'no' | 'interface' | 'inventory' | null }
  | { kind: 'forced'; selected: boolean };
const complimentOptions = [
  { value: 'no', text: 'לא' },
  { value: 'interface', text: 'יש לך ממשק מהמם' },
  { value: 'inventory', text: 'אתה ממש טוב בלנהל מלאי' },
] as const;

export function AdminRecoveryDialog({
  returnFocusRef,
  onClose,
  onError,
}: {
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  const [exercises] = useState(createRecoveryExercises);
  const [stage, setStage] = useState<RecoveryStage>('welcome');
  const [prank, setPrank] = useState(0);
  const prankRef = useRef(0);
  const [changed, setChanged] = useState(false);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [compliment, setCompliment] = useState<ComplimentState>({ kind: 'choice', selected: null });
  const [confirmExit, setConfirmExit] = useState(false);
  const [transition, setTransition] = useState<RecoveryStage | null>(null);
  const [celebration, setCelebration] = useState<{ id: number; kind: RecoveryCelebration } | null>(
    null,
  );
  const celebrationIdRef = useRef(0);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const exitRef = useRef<HTMLButtonElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const forcedComplimentRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  const closingRef = useRef(false);
  const confirmingRef = useRef(false);
  const lockedRef = useRef(false);
  const deferredRef = useRef<(() => void) | null>(null);
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  confirmingRef.current = confirmExit;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!transition || confirmExit) return;
    const timer = window.setTimeout(
      () => {
        setStage(transition);
        setTransition(null);
        setCelebration(null);
        setAnswer('');
        setError('');
        lockedRef.current = false;
      },
      reducedMotion ? 0 : celebration ? celebrationDurationMs : 250,
    );
    return () => window.clearTimeout(timer);
  }, [transition, confirmExit, celebration, reducedMotion]);

  // The first accepted sum celebrates without advancing; each burst restarts independently.
  useEffect(() => {
    if (celebration === null || transition || confirmExit) return;
    const timer = window.setTimeout(() => setCelebration(null), celebrationDurationMs);
    return () => window.clearTimeout(timer);
  }, [celebration, transition, confirmExit]);

  useEffect(() => {
    if (!confirmExit && closingRef.current) {
      onClose();
      return;
    }
    if (!confirmExit && deferredRef.current) {
      const apply = deferredRef.current;
      deferredRef.current = null;
      apply();
    }
  }, [confirmExit, onClose]);

  useEffect(() => {
    if (!confirmingRef.current) contentRef.current?.focus();
  }, [stage]);

  useEffect(() => {
    if (compliment.kind === 'forced' && !confirmingRef.current)
      forcedComplimentRef.current?.focus();
  }, [compliment.kind]);

  function move(next: RecoveryStage, reward: RecoveryCelebration | null = null) {
    if (lockedRef.current || confirmingRef.current) return;
    lockedRef.current = true;
    if (reward) celebrateSuccess(reward);
    else setCelebration(null);
    setTransition(next);
  }

  function celebrateSuccess(kind: RecoveryCelebration) {
    setCelebration(reducedMotion ? null : { id: ++celebrationIdRef.current, kind });
  }

  function requestExit() {
    setConfirmExit(true);
  }
  function invalid(message: string) {
    setAnswer('');
    setError(message);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (lockedRef.current || confirmingRef.current || pending) return;
    if (stage === 'phrase') {
      if (!acceptsRecoveryPhrase(answer)) return invalid(errors.phrase);
      if (prankRef.current < 2) return;
      move('addition', 'star');
    } else if (stage === 'addition') {
      const operands = additionOperands(exercises, changed);
      if (parseRecoveryNumber(answer) !== operands[0] + operands[1])
        return invalid(errors.addition);
      if (!changed) {
        setChanged(true);
        setAnswer('');
        celebrateSuccess('stamp');
      } else move('integral', 'stamp');
    } else if (stage === 'integral') {
      if (parseRecoveryNumber(answer) !== exercises.integralMultiplier * 2)
        return invalid(errors.integral);
      move('reveal', 'confetti');
    }
  }

  function submitCompliment(event: FormEvent) {
    event.preventDefault();
    if (lockedRef.current || confirmingRef.current || !compliment.selected) return;
    if (compliment.kind === 'choice' && compliment.selected === 'no') {
      setCompliment({ kind: 'forced', selected: false });
      return;
    }
    celebrateSuccess('star');
    void retrieve();
  }

  async function retrieve() {
    if (lockedRef.current || confirmingRef.current || password !== null) return;
    lockedRef.current = true;
    setPending(true);
    setFailed(false);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await api<{ password: string }>('/password/recovery', {
        method: 'POST',
        signal: controller.signal,
      });
      if (!controller.signal.aborted && aliveRef.current) {
        const apply = () => {
          setPassword(response.password);
          setPending(false);
          lockedRef.current = false;
        };
        if (confirmingRef.current) deferredRef.current = apply;
        else apply();
      }
    } catch (cause) {
      if (!controller.signal.aborted && aliveRef.current) {
        const apply = () => {
          setPending(false);
          setFailed(true);
          lockedRef.current = false;
          onError(cause);
        };
        if (confirmingRef.current) deferredRef.current = apply;
        else apply();
      }
    }
  }

  useEffect(() => {
    if (stage === 'reveal') void retrieve();
    // Retrieval begins only on the completed integral route. Retry is explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  async function copyPassword() {
    if (password === null || confirmingRef.current) return;
    try {
      await navigator.clipboard.writeText(password);
      if (aliveRef.current)
        setToast({
          id: Date.now(),
          title: 'העתקת הסיסמה',
          message: 'הסיסמה הועתקה ללוח.',
          tone: 'success',
        });
    } catch {
      if (aliveRef.current)
        setToast({
          id: Date.now(),
          title: 'העתקת הסיסמה',
          message: 'לא ניתן להעתיק ללוח. אפשר לסמן את הסיסמה ולהעתיק ידנית.',
          tone: 'error',
        });
    }
  }

  const exerciseStage = stage === 'phrase' || stage === 'addition' || stage === 'integral';
  const label =
    stage === 'phrase'
      ? 'בקשה להצגת הסיסמה'
      : stage === 'addition'
        ? 'סכום המספרים'
        : 'תוצאת האינטגרל';
  const introduction =
    stage === 'compliment' && password !== null
      ? copy.thanked
      : stage === 'addition'
        ? copy[changed ? 'changed' : 'addition']
        : stage === 'reveal'
          ? copy.solved
          : copy[stage];
  const operands = additionOperands(exercises, changed);
  const multiplier = exercises.integralMultiplier;

  return (
    <>
      <Dialog
        title="שחזור סיסמת המנהל"
        level="root"
        role="dialog"
        variant="recovery"
        busy={false}
        dismissible
        onClose={requestExit}
        initialFocusRef={contentRef}
        returnFocusRef={returnFocusRef}
        returnFocusFallbackRef={returnFocusRef}
      >
        <div
          ref={contentRef}
          className="admin-recovery"
          tabIndex={-1}
          dir="rtl"
          style={
            {
              '--recovery-celebration-duration': `${celebrationDurationMs}ms`,
            } as React.CSSProperties
          }
        >
          <div
            className={`admin-recovery-content recovery-screen-enter${transition ? ' recovery-transition' : ''}`}
            aria-busy={pending || !!transition}
          >
            <p key={introduction} className="recovery-text-enter" role="status" aria-live="polite">
              {introduction}
            </p>
            {stage === 'welcome' && (
              <button
                type="button"
                className="primary-button"
                disabled={!!transition}
                onClick={() => move('phrase')}
              >
                אני אידיוט.ית ושכחתי סיסמה
              </button>
            )}
            {exerciseStage && (
              <form onSubmit={submit}>
                {stage === 'addition' && (
                  <p
                    className="recovery-math"
                    dir="ltr"
                    aria-label={`${operands[0]} ועוד ${operands[1]}`}
                    data-testid="recovery-addition"
                  >
                    {operands[0]} + {operands[1]} = ?
                  </p>
                )}
                {stage === 'integral' && (
                  <div
                    className="recovery-math recovery-integral"
                    dir="ltr"
                    role="math"
                    aria-label={`אינטגרל מסוים מאפס עד שתיים של ${multiplier} איקס בשלישית ועוד ${multiplier} איקס חלקי איקס בריבוע ועוד אחת`}
                  >
                    <span className="recovery-integral-symbol">
                      ∫<sup>2</sup>
                      <sub>0</sub>
                    </span>
                    <span className="recovery-fraction">
                      <span>
                        {multiplier === 1 ? '' : multiplier}x³ +{' '}
                        {multiplier === 1 ? '' : multiplier}x
                      </span>
                      <span>x² + 1</span>
                    </span>
                    <span>dx</span>
                  </div>
                )}
                <div
                  className={`recovery-field-space${stage === 'phrase' && prank === 1 ? ' recovery-field-down' : ''}`}
                >
                  <label className="sr-only" htmlFor="recovery-answer">
                    {label}
                  </label>
                  <input
                    id="recovery-answer"
                    ref={inputRef}
                    className={`input-field${error ? ' recovery-field-error' : ''}`}
                    value={answer}
                    disabled={!!transition}
                    dir={stage === 'phrase' ? 'rtl' : 'ltr'}
                    inputMode={stage === 'phrase' ? 'text' : 'decimal'}
                    autoComplete="off"
                    placeholder={
                      stage === 'phrase'
                        ? ['הקלידו כאן', 'פה פה יא חמור.ה', 'רגע בעצם פה'][prank]
                        : undefined
                    }
                    aria-invalid={!!error}
                    aria-describedby={error ? 'recovery-answer-error' : undefined}
                    onFocus={() => {
                      if (stage === 'phrase' && prankRef.current === 0 && !confirmingRef.current) {
                        prankRef.current = 1;
                        setPrank(1);
                        inputRef.current?.blur();
                      }
                    }}
                    onChange={(event) => {
                      if (confirmingRef.current) return;
                      setError('');
                      if (
                        stage === 'phrase' &&
                        prankRef.current === 1 &&
                        Array.from(event.target.value).length >= 3
                      ) {
                        prankRef.current = 2;
                        setPrank(2);
                        setAnswer('');
                        inputRef.current?.blur();
                      } else setAnswer(event.target.value);
                    }}
                  />
                  {error && (
                    <p id="recovery-answer-error" className="recovery-error" role="alert">
                      {error}
                    </p>
                  )}
                </div>
                <div className="admin-recovery-actions">
                  <button type="submit" className="primary-button" disabled={!!transition}>
                    אישור
                  </button>
                  {stage === 'integral' && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={!!transition}
                      onClick={() => move('skip', 'clap')}
                    >
                      די כבר, הגזמת
                    </button>
                  )}
                </div>
              </form>
            )}
            {stage === 'skip' && (
              <button
                type="button"
                className="primary-button"
                disabled={!!transition}
                onClick={() => move('compliment')}
              >
                לחצו כאן להצגת הסיסמה
              </button>
            )}
            {stage === 'compliment' && password === null && !failed && (
              <form onSubmit={submitCompliment}>
                {compliment.kind === 'forced' && (
                  <p className="recovery-text-enter" role="status">
                    {copy.refused}
                  </p>
                )}
                <fieldset className="recovery-compliments" disabled={pending || !!transition}>
                  <legend className="sr-only">מחמאה למערכת</legend>
                  {compliment.kind === 'forced' ? (
                    <label className="recovery-compliment-option">
                      <input
                        ref={forcedComplimentRef}
                        type="radio"
                        name="recovery-compliment"
                        value="forced"
                        checked={compliment.selected}
                        onChange={() => setCompliment({ kind: 'forced', selected: true })}
                      />
                      <span>{copy.forced}</span>
                    </label>
                  ) : (
                    complimentOptions.map((option) => (
                      <label key={option.value} className="recovery-compliment-option">
                        <input
                          type="radio"
                          name="recovery-compliment"
                          value={option.value}
                          checked={compliment.selected === option.value}
                          onChange={() => setCompliment({ kind: 'choice', selected: option.value })}
                        />
                        <span>{option.text}</span>
                      </label>
                    ))
                  )}
                </fieldset>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={!compliment.selected || pending || !!transition}
                >
                  {pending ? 'מחפש את הסיסמה…' : 'אישור'}
                </button>
              </form>
            )}
            {(stage === 'reveal' || (stage === 'compliment' && failed)) && password === null && (
              <button
                type="button"
                className="primary-button"
                disabled={pending}
                onClick={() => void retrieve()}
              >
                {pending ? 'מחפש את הסיסמה…' : failed ? 'נסו שוב' : 'לחצו כאן להצגת הסיסמה'}
              </button>
            )}
            {password !== null && (
              <>
                <label id="recovery-password-label">סיסמת המנהל</label>
                <output
                  aria-labelledby="recovery-password-label"
                  className="admin-recovery-password"
                  dir="ltr"
                >
                  {password}
                </output>
                <div className="admin-recovery-actions">
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void copyPassword()}
                  >
                    העתקת הסיסמה
                  </button>
                  <button type="button" className="secondary-button" onClick={requestExit}>
                    סגירה
                  </button>
                </div>
              </>
            )}
          </div>
          <button ref={exitRef} type="button" className="admin-recovery-exit" onClick={requestExit}>
            יציאה מהשחזור
          </button>
          {celebration && (
            <div key={celebration.id} className="recovery-celebration" aria-hidden="true">
              {celebration.kind === 'confetti' ? (
                <div className="recovery-confetti">
                  {Array.from({ length: 36 }, (_, index) => (
                    <svg
                      key={index}
                      viewBox="0 0 12 18"
                      focusable="false"
                      style={{ '--piece': index } as React.CSSProperties}
                    >
                      <rect width="12" height="18" rx="1" />
                    </svg>
                  ))}
                </div>
              ) : (
                <div className={`recovery-reward recovery-reward-${celebration.kind}`}>
                  {celebration.kind === 'star' && (
                    <>
                      <svg viewBox="0 0 100 100" focusable="false">
                        <path d="M50 3 61 35 96 36 69 57 79 91 50 71 21 91 31 57 4 36 39 35Z" />
                      </svg>
                      <strong>כל הכבוד! השתמשת במילים!</strong>
                    </>
                  )}
                  {celebration.kind === 'stamp' && <strong>יודע.ת לחבר!</strong>}
                  {celebration.kind === 'clap' && (
                    <>
                      <span>👏</span>
                      <strong>איזה אומץ.</strong>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </Dialog>
      {confirmExit && (
        <Dialog
          title="יציאה משחזור הסיסמה?"
          description={
            password === null
              ? 'ההתקדמות תאבד. פתיחה מחדש תתחיל מההתחלה.'
              : 'הסיסמה תוסתר. פתיחה מחדש תתחיל מההתחלה.'
          }
          level="subordinate"
          role="alertdialog"
          variant="standard"
          busy={false}
          dismissible
          onClose={() => setConfirmExit(false)}
          initialFocusRef={continueRef}
          returnFocusRef={exitRef}
          returnFocusFallbackRef={exitRef}
        >
          <div className="dialog-actions">
            <button
              ref={continueRef}
              type="button"
              className="secondary-button"
              onClick={() => setConfirmExit(false)}
            >
              להמשיך בשחזור
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                aliveRef.current = false;
                abortRef.current?.abort();
                deferredRef.current = null;
                closingRef.current = true;
                setConfirmExit(false);
              }}
            >
              יציאה
            </button>
          </div>
        </Dialog>
      )}
      {toast && <Toast key={toast.id} toast={toast} onDismiss={() => setToast(null)} />}
    </>
  );
}
