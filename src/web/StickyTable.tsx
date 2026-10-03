import { useLayoutEffect, useRef, type ComponentPropsWithoutRef } from 'react';

/** The browser pins the existing cells; JavaScript only measures their layout limits. */
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
    const dialog = table.closest<HTMLElement>('.dialog');
    const nav = dialog ? null : document.querySelector<HTMLElement>('.app-nav');
    // Dialog tables have no horizontal overflow wrapper, so CSS sticky can
    // follow their existing scroll owner directly without any measurements.
    if (dialog) return;

    function update() {
      frame = 0;
      if (!table) return;
      const header = table.tHead;
      if (!header) return;
      // Measure the unmoved row, not its animated cells. Mobile cards keep this
      // row visually hidden and need no pinning animation.
      const headerRect = header.getBoundingClientRect();
      const visible = headerRect.height > 2 && getComputedStyle(header).position !== 'absolute';
      table.style.setProperty('--table-header-animation', visible ? 'pin-table-header' : 'none');
      if (!visible) return;

      const start = headerRect.top + window.scrollY - (nav?.getBoundingClientRect().height ?? 0);
      const travel = Math.max(0, table.getBoundingClientRect().bottom - headerRect.bottom);
      table.style.setProperty('--table-header-start', `${start}px`);
      table.style.setProperty('--table-header-end', `${start + travel}px`);
      table.style.setProperty('--table-header-travel', `${travel}px`);
    }

    function schedule() {
      if (typeof requestAnimationFrame === 'undefined') update();
      else if (!frame) frame = requestAnimationFrame(update);
    }
    scheduleRef.current = schedule;
    window.addEventListener('resize', schedule);
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    for (const element of [table, ...ancestors, nav]) {
      if (element) resizeObserver?.observe(element);
    }
    // Preceding content can move the table without resizing the table itself.
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(document.body, {
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
      window.removeEventListener('resize', schedule);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      for (const property of ['animation', 'start', 'end', 'travel']) {
        table.style.removeProperty(`--table-header-${property}`);
      }
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
