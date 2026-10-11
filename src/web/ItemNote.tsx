import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { StickyNote, X } from './icons';

export function ItemNote({ note, itemName }: { note?: string; itemName: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const reader = useRef<HTMLSpanElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const position = useCallback(() => {
    const panel = reader.current;
    const button = trigger.current;
    if (!panel || !button) return;
    const anchor = button.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    if (!bounds.width) return;
    if (anchor.bottom < 0 || anchor.top > window.innerHeight) {
      panel.hidePopover();
      return;
    }
    const margin = 16;
    const left = Math.max(
      margin,
      Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - margin),
    );
    const top =
      anchor.bottom + 8 + bounds.height <= window.innerHeight - margin
        ? anchor.bottom + 8
        : Math.max(margin, anchor.top - bounds.height - 8);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }, []);

  useEffect(() => {
    function dismiss() {
      reader.current?.hidePopover();
    }
    function followAnchor(event: Event) {
      if (event.target instanceof Node && reader.current?.contains(event.target)) return;
      position();
    }
    window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', followAnchor, true);
    return () => {
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('scroll', followAnchor, true);
    };
  }, [position]);

  function close() {
    reader.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
  }

  function toggle() {
    if (open) return close();
    reader.current?.showPopover();
    position();
    closeButton.current?.focus({ preventScroll: true });
  }

  if (!note?.trim()) return null;
  return (
    <span
      className="item-note"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) reader.current?.hidePopover();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="item-note-trigger"
        aria-label={`הערות לפריט ${itemName}`}
        aria-expanded={open}
        aria-controls={id}
        popoverTarget={id}
        onClick={(event) => {
          // Associate the trigger with the popover so native light dismissal does
          // not close it before this click can toggle it.
          event.preventDefault();
          toggle();
        }}
      >
        <StickyNote aria-hidden="true" className="size-4" />
        הערות
      </button>
      <span
        ref={reader}
        id={id}
        popover="auto"
        role="region"
        aria-labelledby={`${id}-title`}
        className="item-note-popover"
        onBeforeToggle={(event) => setOpen(event.newState === 'open')}
      >
        <span className="item-note-heading">
          <strong id={`${id}-title`}>הערות · {itemName}</strong>
          <button
            ref={closeButton}
            type="button"
            className="item-note-close"
            aria-label="סגירת הערות"
            onClick={close}
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </span>
        <span className="item-note-text" tabIndex={0}>
          {note}
        </span>
      </span>
    </span>
  );
}
