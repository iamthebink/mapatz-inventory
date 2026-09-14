import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

export type ComboboxOption<T> = {
  id: string;
  value: T;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  group?: string;
};

export function ActiveDescendantCombobox<T>({
  label,
  value,
  onChange,
  options,
  onSelect,
  placeholder,
  disabled = false,
  invalid = false,
  openOnFocus = false,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption<T>[];
  onSelect: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  openOnFocus?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const generatedId = useId();
  const listboxId = `${generatedId}-listbox`;
  const internalRef = useRef<HTMLInputElement>(null);
  const targetRef = inputRef ?? internalRef;
  const [expanded, setExpanded] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [announcement, setAnnouncement] = useState('');
  const previousCount = useRef<number | null>(null);
  const enabledIndexes = useMemo(
    () => options.flatMap((option, index) => (option.disabled ? [] : [index])),
    [options],
  );

  useEffect(() => {
    setActiveIndex(enabledIndexes[0] ?? -1);
    if (value.trim() && previousCount.current !== options.length) {
      setAnnouncement(`${options.length} תוצאות`);
      previousCount.current = options.length;
    }
  }, [enabledIndexes, options.length, value]);

  const move = (direction: -1 | 1) => {
    if (enabledIndexes.length === 0) return;
    const current = enabledIndexes.indexOf(activeIndex);
    const next = Math.max(0, Math.min(enabledIndexes.length - 1, current + direction));
    setActiveIndex(enabledIndexes[current < 0 ? 0 : next]!);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      event.stopPropagation();
      setExpanded(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setExpanded(true);
      move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter' && expanded && activeIndex >= 0) {
      const option = options[activeIndex];
      if (option && !option.disabled) {
        event.preventDefault();
        onSelect(option.value);
        setExpanded(false);
      }
    }
  };

  const groups = [...new Set(options.map((option) => option.group ?? ''))];
  return (
    <div className="active-combobox">
      <label className="field-label">
        {label}
        <input
          ref={targetRef}
          className="input-field"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-invalid={invalid || undefined}
          aria-controls={listboxId}
          aria-activedescendant={expanded ? options[activeIndex]?.id : undefined}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          onFocus={() => {
            if (openOnFocus || value.trim()) setExpanded(true);
          }}
          onChange={(event) => {
            onChange(event.target.value);
            setExpanded(openOnFocus || Boolean(event.target.value.trim()));
          }}
          onBlur={() => setExpanded(false)}
          onKeyDown={handleKeyDown}
        />
      </label>
      {expanded && (
        <div id={listboxId} className="combobox-list" role="listbox">
          {options.length === 0 && <p className="combobox-empty">לא נמצאו תוצאות</p>}
          {groups.map((group) => (
            <div key={group || 'default'} role="group" aria-label={group || undefined}>
              {group && <div className="combobox-group-label">{group}</div>}
              {options.map((option, index) =>
                (option.group ?? '') === group ? (
                  <div
                    key={option.id}
                    id={option.id}
                    role="option"
                    aria-selected={index === activeIndex}
                    aria-disabled={option.disabled || undefined}
                    className={`combobox-option${index === activeIndex ? ' active' : ''}${option.disabled ? ' disabled' : ''}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      if (option.disabled) return;
                      onSelect(option.value);
                      setExpanded(false);
                      targetRef.current?.focus();
                    }}
                  >
                    <span>{option.label}</span>
                    {option.description && <small>{option.description}</small>}
                  </div>
                ) : null,
              )}
            </div>
          ))}
        </div>
      )}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </div>
  );
}
