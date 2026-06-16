import { useState } from "react";
import { Check, Loader2, Plus, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ApiError,
  getListNoteDefaultsQueryKey,
  useCreateNoteDefault,
  useDeleteNoteDefault,
  useListNoteDefaults,
  useListNoteDefaultSuggestions,
  useUpdateNoteDefault,
  type NoteDefault,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// Per-provider "always apply" encounter assumptions. Composed of two
// surfaces:
//   1. The provider's current defaults (CRUD list).
//   2. A built-in suggestions catalog so onboarding is one-click
//      instead of writing rules from a blank page.
//
// Suggestions become real rows the moment the provider taps "Add" —
// at which point they're indistinguishable from manually-written
// defaults. We dedupe the suggestion list against the live rows by
// matching label text (case-insensitive), so a re-adopted suggestion
// doesn't show up as "Add" a second time.
export function NoteDefaultsSection() {
  const queryClient = useQueryClient();
  const listQuery = useListNoteDefaults({
    query: { queryKey: getListNoteDefaultsQueryKey() },
  });
  const suggestionsQuery = useListNoteDefaultSuggestions();

  const create = useCreateNoteDefault();
  const [creating, setCreating] = useState(false);

  function invalidate() {
    void queryClient.invalidateQueries({
      queryKey: getListNoteDefaultsQueryKey(),
    });
  }

  const defaults = listQuery.data?.data ?? [];
  const suggestions = suggestionsQuery.data?.data ?? [];
  const adoptedLabels = new Set(
    defaults.map((d) => d.label.toLowerCase()),
  );
  const unadoptedSuggestions = suggestions.filter(
    (s) => !adoptedLabels.has(s.label.toLowerCase()),
  );

  async function adoptSuggestion(
    label: string,
    rule: string,
  ): Promise<void> {
    try {
      await create.mutateAsync({ data: { label, rule } });
      toast.success(`Added "${label}"`);
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save");
    }
  }

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-lg font-medium">Note defaults</h2>
        <p className="text-sm text-(--color-muted-foreground)">
          Encounter assumptions the AI bakes into every generated note —
          e.g. "14-point ROS negative unless stated", "vitals block
          always present". The transcript always wins when it
          contradicts a default.
        </p>
      </header>

      <Card className="overflow-hidden">
        {listQuery.isPending ? (
          <ul
            className="divide-y divide-(--color-border)"
            role="status"
            aria-label="Loading note defaults"
          >
            {[0, 1].map((i) => (
              <li key={i} className="space-y-2 px-4 py-3">
                <div className="h-4 w-1/3 animate-pulse rounded bg-(--color-muted)" />
                <div className="h-3 w-3/4 animate-pulse rounded bg-(--color-muted)" />
              </li>
            ))}
          </ul>
        ) : listQuery.isError ? (
          <p
            role="alert"
            className="px-4 py-6 text-sm text-(--color-destructive)"
          >
            Couldn't load your note defaults.
          </p>
        ) : defaults.length === 0 ? (
          <p className="px-4 py-6 text-sm text-(--color-muted-foreground)">
            No defaults yet. Add one of the suggestions below to get
            started, or write your own.
          </p>
        ) : (
          <ul
            className="divide-y divide-(--color-border)"
            aria-label="Note defaults"
          >
            {defaults.map((d) => (
              <NoteDefaultRow
                key={d.id}
                noteDefault={d}
                onChanged={invalidate}
              />
            ))}
          </ul>
        )}

        <div className="border-t border-(--color-border) bg-(--color-muted)/40 px-4 py-3">
          {creating ? (
            <NoteDefaultForm
              busy={create.isPending}
              onCancel={() => setCreating(false)}
              onSubmit={async (label, rule) => {
                try {
                  await create.mutateAsync({ data: { label, rule } });
                  toast.success(`Added "${label}"`);
                  setCreating(false);
                  invalidate();
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "Couldn't save",
                  );
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
              Add default
            </Button>
          )}
        </div>
      </Card>

      {/* Suggestion catalog. Hidden once the provider has adopted them
          all, but otherwise always visible — it doubles as the
          onboarding affordance. */}
      {unadoptedSuggestions.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-(--color-foreground)">
            Suggested defaults
          </h3>
          <p className="text-xs text-(--color-muted-foreground)">
            Quick starts you can adopt one click at a time. You can edit
            them after adding.
          </p>
          <ul className="space-y-2">
            {unadoptedSuggestions.map((s) => (
              <li key={s.key}>
                <Card className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="font-medium text-(--color-foreground)">
                      {s.label}
                    </div>
                    <p className="text-sm text-(--color-muted-foreground)">
                      {s.description ?? s.rule}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void adoptSuggestion(s.label, s.rule)}
                    disabled={create.isPending}
                    aria-label={`Add "${s.label}"`}
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    Add
                  </Button>
                </Card>
              </li>
            ))}
          </ul>
        </div>
      ) : suggestionsQuery.isPending ? null : suggestions.length > 0 ? (
        <p className="inline-flex items-center gap-1.5 text-xs text-(--color-muted-foreground)">
          <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
          You've adopted every suggested default.
        </p>
      ) : null}
    </section>
  );
}

function NoteDefaultRow({
  noteDefault,
  onChanged,
}: {
  noteDefault: NoteDefault;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const update = useUpdateNoteDefault();
  const remove = useDeleteNoteDefault();

  async function handleDelete() {
    try {
      await remove.mutateAsync({ id: noteDefault.id });
      toast.success(`Removed "${noteDefault.label}"`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete");
    }
  }

  if (editing) {
    return (
      <li className="px-4 py-3">
        <NoteDefaultForm
          initialLabel={noteDefault.label}
          initialRule={noteDefault.rule}
          busy={update.isPending}
          onCancel={() => setEditing(false)}
          onSubmit={async (label, rule) => {
            try {
              await update.mutateAsync({
                id: noteDefault.id,
                data: { label, rule },
              });
              setEditing(false);
              onChanged();
            } catch (err) {
              if (err instanceof ApiError && err.status === 404) {
                toast.error("This default no longer exists.");
                onChanged();
              } else {
                toast.error(
                  err instanceof Error ? err.message : "Couldn't save",
                );
              }
            }
          }}
        />
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3">
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="min-w-0 flex-1 space-y-1 text-left"
        aria-label={`Edit ${noteDefault.label}`}
      >
        <div className="font-medium text-(--color-foreground)">
          {noteDefault.label}
        </div>
        <p className="text-sm text-(--color-muted-foreground)">
          {noteDefault.rule}
        </p>
      </button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void handleDelete()}
        disabled={remove.isPending}
        aria-label="Delete default"
        className="text-(--color-destructive)"
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </Button>
    </li>
  );
}

function NoteDefaultForm({
  initialLabel = "",
  initialRule = "",
  busy,
  onCancel,
  onSubmit,
}: {
  initialLabel?: string;
  initialRule?: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (label: string, rule: string) => Promise<void>;
}) {
  const [label, setLabel] = useState(initialLabel);
  const [rule, setRule] = useState(initialRule);

  async function handle(e: React.FormEvent) {
    e.preventDefault();
    const l = label.trim();
    const r = rule.trim();
    if (!l || !r) return;
    await onSubmit(l, r);
  }

  return (
    <form className="space-y-2" onSubmit={(e) => void handle(e)}>
      <div className="space-y-1">
        <Label htmlFor="default-label" className="text-xs">
          Short label
        </Label>
        <Input
          id="default-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="ROS default"
          disabled={busy}
          autoFocus
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="default-rule" className="text-xs">
          Rule for the AI
        </Label>
        <Textarea
          id="default-rule"
          value={rule}
          onChange={(e) => setRule(e.target.value)}
          rows={4}
          placeholder="If the review of systems is not explicitly addressed, document a 14-point ROS as negative except as noted in the HPI."
          disabled={busy}
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
        <Button
          type="submit"
          size="sm"
          disabled={busy || !label.trim() || !rule.trim()}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : null}
          Save
        </Button>
      </div>
    </form>
  );
}
