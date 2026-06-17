import { useState } from "react";
import { Loader2, MessageSquare, Plus, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ApiError,
  getListVerbalCuesQueryKey,
  useCreateVerbalCue,
  useDeleteVerbalCue,
  useListVerbalCues,
  type VerbalCue,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Per-provider verbal end-cues. The streaming transcription bridge
// auto-stops the recorder when one of these phrases shows up in a
// finalized transcript chunk. Empty list → server falls back to a
// hardcoded default set so a new account already has reasonable
// behavior.
export function VerbalCuesSection() {
  const queryClient = useQueryClient();
  const query = useListVerbalCues({
    query: { queryKey: getListVerbalCuesQueryKey() },
  });
  const create = useCreateVerbalCue();
  const [creating, setCreating] = useState(false);

  function invalidate() {
    void queryClient.invalidateQueries({
      queryKey: getListVerbalCuesQueryKey(),
    });
  }

  const cues = query.data?.data ?? [];

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-lg font-medium">Visit end cues</h2>
        <p className="text-sm text-(--color-muted-foreground)">
          Phrases that automatically stop recording when heard. Leave
          empty to use the defaults (
          <span className="italic">"have a great day"</span>,{" "}
          <span className="italic">"take care now"</span>,{" "}
          <span className="italic">"follow up in"</span>, …).
        </p>
      </header>

      <Card className="overflow-hidden">
        {query.isPending ? (
          <ul className="divide-y divide-(--color-border)" role="status">
            {[0, 1].map((i) => (
              <li key={i} className="px-4 py-3">
                <div className="h-4 w-1/2 animate-pulse rounded bg-(--color-muted)" />
              </li>
            ))}
          </ul>
        ) : query.isError ? (
          <p
            role="alert"
            className="px-4 py-6 text-sm text-(--color-destructive)"
          >
            Couldn't load your end cues.
          </p>
        ) : cues.length === 0 ? (
          <p className="px-4 py-6 text-sm text-(--color-muted-foreground)">
            No custom cues. The default list is active.
          </p>
        ) : (
          <ul
            className="divide-y divide-(--color-border)"
            aria-label="Verbal end cues"
          >
            {cues.map((c) => (
              <CueRow key={c.id} cue={c} onChanged={invalidate} />
            ))}
          </ul>
        )}

        <div className="border-t border-(--color-border) bg-(--color-muted)/40 px-4 py-3">
          {creating ? (
            <CreateCueForm
              busy={create.isPending}
              onCancel={() => setCreating(false)}
              onSubmit={async (phrase) => {
                try {
                  await create.mutateAsync({ data: { phrase } });
                  toast.success(`Added "${phrase}"`);
                  setCreating(false);
                  invalidate();
                } catch (err) {
                  if (err instanceof ApiError && err.status === 409) {
                    toast.error(`"${phrase}" is already in your list.`);
                  } else {
                    toast.error(
                      err instanceof Error ? err.message : "Couldn't save",
                    );
                  }
                }
              }}
            />
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCreating(true)}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add cue
            </Button>
          )}
        </div>
      </Card>
    </section>
  );
}

function CueRow({
  cue,
  onChanged,
}: {
  cue: VerbalCue;
  onChanged: () => void;
}) {
  const remove = useDeleteVerbalCue();
  async function handleDelete() {
    try {
      await remove.mutateAsync({ id: cue.id });
      toast.success(`Removed "${cue.phrase}"`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete");
    }
  }
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <MessageSquare
        className="h-4 w-4 shrink-0 text-(--color-muted-foreground)"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate text-sm">
        {cue.phrase}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void handleDelete()}
        disabled={remove.isPending}
        aria-label={`Delete cue ${cue.phrase}`}
        className="text-(--color-destructive)"
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </Button>
    </li>
  );
}

function CreateCueForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (phrase: string) => Promise<void>;
}) {
  const [phrase, setPhrase] = useState("");
  async function handle(e: React.FormEvent) {
    e.preventDefault();
    const p = phrase.trim();
    if (!p) return;
    await onSubmit(p);
  }
  return (
    <form className="space-y-2" onSubmit={(e) => void handle(e)}>
      <div className="space-y-1">
        <Label htmlFor="new-cue" className="text-xs">
          End-of-visit phrase
        </Label>
        <Input
          id="new-cue"
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          placeholder="see you in two weeks"
          disabled={busy}
          autoFocus
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy || !phrase.trim()}>
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : null}
          Add
        </Button>
      </div>
    </form>
  );
}
