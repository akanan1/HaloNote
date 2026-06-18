import { useEffect, useRef } from "react";
import { Loader2, Radio } from "lucide-react";
import type { StreamingTranscriptState } from "@/lib/use-streaming-transcript";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface LiveTranscriptRibbonProps {
  state: StreamingTranscriptState;
}

// Sits above the RecordingPanel during an active visit. Shows the last
// few finalized lines plus the unconfirmed partial in a dimmer color,
// with auto-scroll so the newest text is always visible. Hidden when
// the stream is idle.
//
// Renders nothing on error or before the connection is open so a
// failed token mint or auth doesn't push a half-broken ribbon onto the
// screen — the recording still proceeds (the existing upload-then-
// transcribe pipeline is the source of truth for the structured note).
export function LiveTranscriptRibbon({ state }: LiveTranscriptRibbonProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Pin to bottom whenever new text arrives. ScrollTop = scrollHeight
  // is the simplest implementation that avoids the "user scrolled up
  // to read history" trap when the ribbon's only as tall as ~3 lines.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [state.finals.length, state.partial]);

  if (state.status === "idle") return null;
  if (state.status === "error") return null;

  const showSpinner = state.status === "connecting";
  // Keep only the trailing window so the ribbon doesn't grow without
  // bound on a long visit; the full transcript still flows through to
  // the post-visit structuring pipeline.
  const recentFinals = state.finals.slice(-12);

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-(--color-border) bg-(--color-muted)/40 px-4 py-2 text-xs font-medium uppercase tracking-wide text-(--color-muted-foreground)">
        {showSpinner ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Radio
            className="h-3.5 w-3.5 text-emerald-600"
            aria-hidden="true"
          />
        )}
        Live transcript
      </div>
      <div
        ref={scrollRef}
        className="max-h-32 overflow-y-auto px-4 py-3 text-sm leading-relaxed"
        aria-live="polite"
        aria-label="Live visit transcript"
      >
        {recentFinals.length === 0 && !state.partial ? (
          <p className="text-(--color-muted-foreground) italic">
            Listening…
          </p>
        ) : (
          <>
            {recentFinals.map((line, i) => (
              <p
                key={i}
                className="text-(--color-foreground) whitespace-pre-wrap"
              >
                {line}
              </p>
            ))}
            {state.partial ? (
              <p
                className={cn(
                  "text-(--color-muted-foreground) whitespace-pre-wrap",
                  "italic",
                )}
              >
                {state.partial}
              </p>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}
