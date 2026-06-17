import type { SmartPhraseSuggestion } from "@/lib/use-smart-phrase-autocomplete";
import { cn } from "@/lib/utils";

interface SmartPhraseDropdownProps {
  open: boolean;
  suggestions: SmartPhraseSuggestion[];
  activeIndex: number;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}

/**
 * Inline dropdown attached directly under the note textarea. We don't
 * try to anchor to the caret position — building a caret-position
 * indicator for a multi-line textarea reliably is a half-dozen edge
 * cases (line wrapping, scrolling, mono vs proportional). Anchoring
 * to the textarea instead means the dropdown is always visible and
 * touch-friendly, even though it's not adjacent to the typed `.`.
 */
export function SmartPhraseDropdown({
  open,
  suggestions,
  activeIndex,
  onPick,
  onHover,
}: SmartPhraseDropdownProps) {
  if (!open || suggestions.length === 0) return null;
  return (
    <div
      role="listbox"
      aria-label="Smart phrase suggestions"
      className="absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-y-auto rounded-md border border-(--color-border) bg-(--color-card) shadow-lg"
    >
      {suggestions.map((s, i) => {
        const isActive = i === activeIndex;
        return (
          <button
            key={s.id}
            type="button"
            role="option"
            aria-selected={isActive}
            // onMouseDown rather than onClick — onClick fires after
            // the textarea blurs, which moves the cursor and loses
            // the selection range we need for the splice.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(i);
            }}
            onMouseEnter={() => onHover(i)}
            className={cn(
              "flex w-full items-start gap-3 px-3 py-2 text-left text-sm",
              isActive
                ? "bg-(--color-muted)"
                : "hover:bg-(--color-muted)/60",
            )}
          >
            <span className="shrink-0 font-mono text-(--color-primary)">
              .{s.shortcut}
            </span>
            <span className="min-w-0 flex-1">
              {s.description ? (
                <span className="block truncate text-(--color-foreground)">
                  {s.description}
                </span>
              ) : null}
              <span
                className={cn(
                  "block truncate text-xs",
                  s.description
                    ? "text-(--color-muted-foreground)"
                    : "text-(--color-foreground)",
                )}
              >
                {s.body.split("\n")[0]}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
