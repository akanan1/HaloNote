import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  customFetch,
  getListSmartPhrasesQueryKey,
  useListSmartPhrases,
  type SmartPhrase,
} from "@workspace/api-client-react";

// Regex that picks the "current dot-token" sitting at the cursor:
// optional leading whitespace, a literal '.', then 1+ shortcut chars
// (letters/digits/_/-), with the match anchored at end-of-string. We
// run it against the text BEFORE the cursor.
//
// Anchoring at the end of the slice means we only ever match the token
// the cursor is sitting in — typing in the middle of a word elsewhere
// in the note doesn't accidentally trigger autocomplete.
const DOT_TOKEN_RE = /(?:^|\s)\.([a-z0-9_-]*)$/i;

// Maximum dropdown size. Hard cap so a provider with hundreds of
// phrases never paints a screen-full of suggestions; only the top N
// after ranking are rendered.
const MAX_SUGGESTIONS = 6;

export interface UseSmartPhraseAutocompleteParams {
  /** Ref to the textarea being edited. Required for cursor + selection ops. */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Current body text. */
  value: string;
  /** Setter the host page uses for the textarea's controlled value. */
  setValue: Dispatch<SetStateAction<string>>;
  /**
   * When false (page busy, recording, etc.), the hook silently does
   * nothing — no fetches, no key handling, no dropdown. The hook still
   * mounts so re-enabling doesn't lose React state.
   */
  enabled?: boolean;
}

export interface SmartPhraseSuggestion {
  id: string;
  shortcut: string;
  body: string;
  description: string | null;
}

export interface UseSmartPhraseAutocompleteResult {
  /** Drop directly into the textarea's onKeyDown. */
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  /** True when the dropdown should be rendered. */
  open: boolean;
  /** Top-N suggestions, ranked. */
  suggestions: SmartPhraseSuggestion[];
  /** Index of the highlighted row in `suggestions`. */
  activeIndex: number;
  /** Click-to-pick handler for individual suggestion rows. */
  pick: (index: number) => void;
  /** Used by the dropdown for hover-to-highlight. */
  setActiveIndex: (i: number) => void;
  /** Dismiss the dropdown without inserting (Esc, outside click). */
  dismiss: () => void;
}

/**
 * Editor-time dot-phrase expansion. The hook listens for `.shortcut`
 * tokens typed into a textarea, surfaces a ranked dropdown of matching
 * smart phrases, and replaces the `.shortcut` with the phrase body
 * when the provider commits (Enter / Tab / click).
 *
 * - All matching is local; the server only sees the final note body.
 * - Server is told asynchronously when a phrase fires (best-effort);
 *   failures are swallowed so the editor never surfaces a toast for a
 *   ranking signal.
 * - Ranking is "longest matching prefix wins, ties broken by
 *   usageCount desc, then shortcut asc."
 */
export function useSmartPhraseAutocomplete({
  textareaRef,
  value,
  setValue,
  enabled = true,
}: UseSmartPhraseAutocompleteParams): UseSmartPhraseAutocompleteResult {
  const phrasesQuery = useListSmartPhrases({
    query: {
      queryKey: getListSmartPhrasesQueryKey(),
      // The library is small (typically <100 rows) and rarely
      // changes mid-session. Don't refetch on every focus — the
      // dropdown should feel instant.
      staleTime: 60_000,
      enabled,
    },
  });
  const phrases = useMemo<SmartPhrase[]>(
    () => phrasesQuery.data?.data ?? [],
    [phrasesQuery.data],
  );

  // Match state. `query` is the lowercased text after the dot; null
  // means the cursor isn't sitting in a dot-token.
  const [query, setQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // The cursor position recorded when we last detected a query. Stored
  // so a key handler that fires before the value/selection update can
  // still recompute the replacement range.
  const matchEndRef = useRef<number | null>(null);

  // Re-scan for a dot-token whenever the textarea value changes. We
  // also scan on selection changes via the selectionchange listener
  // below — typing inside an existing dot-token isn't the only way to
  // enter one; arrow keys to a previously-typed token should also
  // arm autocomplete.
  const rescan = useCallback(() => {
    if (!enabled) {
      setQuery(null);
      return;
    }
    const el = textareaRef.current;
    if (!el || document.activeElement !== el) {
      setQuery(null);
      return;
    }
    const cursor = el.selectionStart ?? 0;
    // Only show suggestions on a collapsed caret. A selection range
    // means the provider is mid-edit; autocomplete would be
    // surprising.
    if (cursor !== (el.selectionEnd ?? 0)) {
      setQuery(null);
      return;
    }
    const before = value.slice(0, cursor);
    const m = DOT_TOKEN_RE.exec(before);
    if (!m) {
      setQuery(null);
      return;
    }
    setQuery((m[1] ?? "").toLowerCase());
    matchEndRef.current = cursor;
  }, [enabled, textareaRef, value]);

  useEffect(() => {
    rescan();
  }, [rescan]);

  useEffect(() => {
    if (!enabled) return;
    function onSelectionChange() {
      rescan();
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [enabled, rescan]);

  // Rank phrases against the current query. Empty query (cursor right
  // after the dot with no chars yet) shows the top phrases ordered by
  // usageCount — the server already returns them in that order.
  const suggestions = useMemo<SmartPhraseSuggestion[]>(() => {
    if (query === null) return [];
    const ranked = phrases
      .filter((p) => p.shortcut.startsWith(query))
      .slice(0, MAX_SUGGESTIONS)
      .map((p) => ({
        id: p.id,
        shortcut: p.shortcut,
        body: p.body,
        description: p.description,
      }));
    return ranked;
  }, [phrases, query]);

  // Clamp the active index when the suggestion set shrinks (e.g. the
  // user typed another character that filtered out the previously
  // active row). Falls back to 0 if the list is now empty.
  useEffect(() => {
    if (activeIndex >= suggestions.length) {
      setActiveIndex(suggestions.length === 0 ? 0 : suggestions.length - 1);
    }
  }, [suggestions.length, activeIndex]);

  const open = enabled && query !== null && suggestions.length > 0;

  const dismiss = useCallback(() => {
    setQuery(null);
  }, []);

  // Apply the chosen suggestion. The shortcut+dot occupy
  // [matchStart, cursor); we splice in the body, then position the
  // cursor at the end of the inserted body.
  const pick = useCallback(
    (index: number) => {
      const el = textareaRef.current;
      const chosen = suggestions[index];
      if (!el || !chosen) return;
      const cursor = matchEndRef.current ?? (el.selectionStart ?? 0);
      const before = value.slice(0, cursor);
      const m = DOT_TOKEN_RE.exec(before);
      if (!m) return;
      // The regex consumes an optional leading whitespace char so we
      // never accidentally splice the space that triggered "start of
      // token." Keep the leading whitespace by computing the dot's
      // index explicitly.
      const dotIndex = before.lastIndexOf(".", cursor - 1);
      if (dotIndex < 0) return;
      const next =
        value.slice(0, dotIndex) + chosen.body + value.slice(cursor);
      setValue(next);
      setQuery(null);
      // Defer cursor reposition until after React paints — the
      // textarea's value prop won't reflect the new string until then.
      const caret = dotIndex + chosen.body.length;
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(caret, caret);
      });
      // Fire-and-forget usage signal. Swallow errors — the editor
      // already inserted the expansion successfully; a ranking-stat
      // failure shouldn't surface a toast.
      void customFetch(`/api/smart-phrases/${chosen.id}/used`, {
        method: "POST",
      }).catch(() => {});
    },
    [setValue, suggestions, textareaRef, value],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (!open) return;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setActiveIndex((i) => (i + 1) % suggestions.length);
          return;
        case "ArrowUp":
          event.preventDefault();
          setActiveIndex((i) =>
            i === 0 ? suggestions.length - 1 : i - 1,
          );
          return;
        case "Enter":
        case "Tab":
          event.preventDefault();
          pick(activeIndex);
          return;
        case "Escape":
          event.preventDefault();
          dismiss();
          return;
        default:
          return;
      }
    },
    [activeIndex, dismiss, open, pick, suggestions.length],
  );

  return {
    onKeyDown,
    open,
    suggestions,
    activeIndex,
    pick,
    setActiveIndex,
    dismiss,
  };
}
