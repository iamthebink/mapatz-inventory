import { StickyNote } from 'lucide-react';

export function ItemNote({ note, itemName }: { note?: string; itemName: string }) {
  if (!note?.trim()) return null;
  return (
    <details className="item-note">
      <summary
        aria-label={`הערות לפריט ${itemName}`}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
        }}
      >
        <StickyNote aria-hidden="true" className="size-4" />
      </summary>
      <p className="item-note-text">{note}</p>
    </details>
  );
}
