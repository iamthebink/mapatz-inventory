import { useLayoutEffect, useRef, type ComponentPropsWithoutRef } from 'react';

/** Moves the existing column cells, preserving semantics, focus and horizontal scrolling. */
export function StickyTable({
  children,
  className = '',
  ...props
}: ComponentPropsWithoutRef<'table'>) {
  const tableRef = useRef<HTMLTableElement>(null);
  const scheduleRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    let frame = 0;
    const ancestors: HTMLElement[] = [];
    for (let ancestor = table.parentElement; ancestor; ancestor = ancestor.parentElement) {
      ancestors.push(ancestor);
    }
    const dialog = table.closest('.dialog');
    const nav = dialog ? null : document.querySelector<HTMLElement>('.app-nav');

    function update() {
      frame = 0;
      if (!table) return;
      const header = table.tHead;
      if (!header) return;
      // Horizontal overflow wrappers also compute overflow-y:auto. They are not
      // vertical scroll owners unless they have an actual vertical scroll range.
      const scrollOwner = ancestors.find((ancestor) => {
        const overflow = getComputedStyle(ancestor).overflowY;
        return /auto|scroll/.test(overflow) && ancestor.scrollHeight > ancestor.clientHeight + 1;
      });
      let boundary = scrollOwner
        ? scrollOwner.getBoundingClientRect().top + scrollOwner.clientTop
        : 0;
      if (dialog) {
        const dialogHeader = dialog.querySelector<HTMLElement>('.dialog-shell-header');
        if (dialogHeader)
          boundary = Math.max(boundary, dialogHeader.getBoundingClientRect().bottom);
      } else if (nav) {
        boundary = Math.max(boundary, nav.getBoundingClientRect().bottom);
      }
      const headerRect = header.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      const visible = headerRect.height > 2 && getComputedStyle(header).position !== 'absolute';
      const translation = visible
        ? Math.max(0, Math.min(boundary - headerRect.top, tableRect.bottom - headerRect.bottom))
        : 0;
      table.style.setProperty('--table-header-offset', `${translation}px`);
    }

    function schedule() {
      if (typeof requestAnimationFrame === 'undefined') update();
      else if (!frame) frame = requestAnimationFrame(update);
    }
    scheduleRef.current = schedule;
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    for (const element of [table, ...ancestors, nav]) {
      if (element) resizeObserver?.observe(element);
    }
    // Changes elsewhere can move this table without changing its own dimensions
    // (expanded details, data loading, a preceding table or a dialog transition).
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(dialog ?? document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'open'],
    });
    update();
    return () => {
      scheduleRef.current = null;
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      table.style.removeProperty('--table-header-offset');
    };
  }, []);

  useLayoutEffect(() => {
    scheduleRef.current?.();
  });

  return (
    <table {...props} ref={tableRef} className={`sticky-table ${className}`}>
      {children}
    </table>
  );
}
