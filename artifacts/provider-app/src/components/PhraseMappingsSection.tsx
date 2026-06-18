import { useState } from "react";
import { ArrowRight, Loader2, Plus, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ApiError,
  getListPhraseMappingsQueryKey,
  useCreatePhraseMapping,
  useDeletePhraseMapping,
  useListPhraseMappings,
  useUpdatePhraseMapping,
  type PhraseMapping,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Per-provider terminology overrides. The provider tells the AI:
// "when I say <spoken>, write <documented> in the note instead."
// The mapping is applied during the structuring pass in the
// recording pipeline; ordering here is informational only (server
// returns rows in stable order).
export function PhraseMappingsSection() {
  const queryClient = useQueryClient();
  const query = useListPhraseMappings({
    query: { queryKey: getListPhraseMappingsQueryKey() },
  });

  const create = useCreatePhraseMapping();
  const [creating, setCreating] = useState(false);

  function invalidate() {
    void queryClient.invalidateQueries({
      queryKey: getListPhraseMappingsQueryKey(),
    });
  }

  const mappings = query.data?.data ?? [];

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-lg font-medium">Personal vocabulary</h2>
        <p className="text-sm text-(--color-muted-foreground)">
          Teach the AI your preferred documentation terms. When the
          transcript contains the spoken phrase, the generated note
          will use your preferred term instead.
        </p>
      </header>

      <Card className="overflow-hidden">
        {query.isPending ? (
          <ul
            className="divide-y divide-(--color-border)"
            role="status"
            aria-label="Loading phrase mappings"
          >
            {[0, 1].map((i) => (
              <li key={i} className="space-y-2 px-4 py-3">
                <div className="h-4 w-1/2 animate-pulse rounded bg-(--color-muted)" />
                <div className="h-3 w-1/3 animate-pulse rounded bg-(--color-muted)" />
              </li>
            ))}
          </ul>
        ) : query.isError ? (
          <p
            role="alert"
            className="px-4 py-6 text-sm text-(--color-destructive)"
          >
            Couldn't load your phrase mappings.
          </p>
        ) : mappings.length === 0 ? (
          <p className="px-4 py-6 text-sm text-(--color-muted-foreground)">
            No mappings yet. Add your first below — for example,{" "}
            <span className="font-mono">tummy ache → abdominal pain</span>.
          </p>
        ) : (
          <ul
            className="divide-y divide-(--color-border)"
            aria-label="Phrase mappings"
          >
            {mappings.map((m) => (
              <PhraseMappingRow
                key={m.id}
                mapping={m}
                onChanged={invalidate}
              />
            ))}
          </ul>
        )}

        <div className="border-t border-(--color-border) bg-(--color-muted)/40 px-4 py-3">
          {creating ? (
            <CreateMappingForm
              busy={create.isPending}
              onCancel={() => setCreating(false)}
              onSubmit={async (spoken, documented) => {
                try {
                  await create.mutateAsync({
                    data: { spoken, documented },
                  });
                  toast.success(`Added "${spoken}" → "${documented}"`);
                  setCreating(false);
                  invalidate();
                } catch (err) {
                  if (err instanceof ApiError && err.status === 409) {
                    toast.error(
                      `You already have a mapping for "${spoken}".`,
                    );
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
              Add mapping
            </Button>
          )}
        </div>
      </Card>
    </section>
  );
}

function PhraseMappingRow({
  mapping,
  onChanged,
}: {
  mapping: PhraseMapping;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [spoken, setSpoken] = useState(mapping.spoken);
  const [documented, setDocumented] = useState(mapping.documented);
  const update = useUpdatePhraseMapping();
  const remove = useDeletePhraseMapping();

  async function save() {
    const s = spoken.trim();
    const d = documented.trim();
    if (!s || !d) return;
    try {
      await update.mutateAsync({
        id: mapping.id,
        data: { spoken: s, documented: d },
      });
      setEditing(false);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.error(`You already have a mapping for "${s}".`);
      } else {
        toast.error(err instanceof Error ? err.message : "Couldn't save");
      }
    }
  }

  async function handleDelete() {
    try {
      await remove.mutateAsync({ id: mapping.id });
      toast.success(`Removed "${mapping.spoken}"`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete");
    }
  }

  if (editing) {
    return (
      <li className="space-y-2 px-4 py-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_1fr]">
          <div className="space-y-1">
            <Label htmlFor={`spoken-${mapping.id}`} className="text-xs">
              When I say
            </Label>
            <Input
              id={`spoken-${mapping.id}`}
              value={spoken}
              onChange={(e) => setSpoken(e.target.value)}
              disabled={update.isPending}
              autoFocus
            />
          </div>
          <ArrowRight
            className="hidden self-end pb-2.5 text-(--color-muted-foreground) sm:block"
            aria-hidden="true"
          />
          <div className="space-y-1">
            <Label htmlFor={`documented-${mapping.id}`} className="text-xs">
              Document as
            </Label>
            <Input
              id={`documented-${mapping.id}`}
              value={documented}
              onChange={(e) => setDocumented(e.target.value)}
              disabled={update.isPending}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSpoken(mapping.spoken);
              setDocumented(mapping.documented);
              setEditing(false);
            }}
            disabled={update.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={
              update.isPending ||
              !spoken.trim() ||
              !documented.trim()
            }
          >
            {update.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : null}
            Save
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="min-w-0 flex-1 text-left"
        aria-label={`Edit mapping ${mapping.spoken} to ${mapping.documented}`}
      >
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="truncate font-medium text-(--color-foreground)">
            {mapping.spoken}
          </span>
          <ArrowRight
            className="h-3.5 w-3.5 shrink-0 text-(--color-muted-foreground)"
            aria-hidden="true"
          />
          <span className="truncate text-(--color-muted-foreground)">
            {mapping.documented}
          </span>
        </div>
      </button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void handleDelete()}
        disabled={remove.isPending}
        aria-label="Delete mapping"
        className="text-(--color-destructive)"
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </Button>
    </li>
  );
}

function CreateMappingForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (spoken: string, documented: string) => Promise<void>;
}) {
  const [spoken, setSpoken] = useState("");
  const [documented, setDocumented] = useState("");

  async function handle(e: React.FormEvent) {
    e.preventDefault();
    const s = spoken.trim();
    const d = documented.trim();
    if (!s || !d) return;
    await onSubmit(s, d);
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => void handle(e)}
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_1fr]">
        <div className="space-y-1">
          <Label htmlFor="new-spoken" className="text-xs">
            When I say
          </Label>
          <Input
            id="new-spoken"
            value={spoken}
            onChange={(e) => setSpoken(e.target.value)}
            placeholder="tummy ache"
            disabled={busy}
            autoFocus
          />
        </div>
        <ArrowRight
          className="hidden self-end pb-2.5 text-(--color-muted-foreground) sm:block"
          aria-hidden="true"
        />
        <div className="space-y-1">
          <Label htmlFor="new-documented" className="text-xs">
            Document as
          </Label>
          <Input
            id="new-documented"
            value={documented}
            onChange={(e) => setDocumented(e.target.value)}
            placeholder="abdominal pain"
            disabled={busy}
          />
        </div>
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
          disabled={busy || !spoken.trim() || !documented.trim()}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : null}
          Add
        </Button>
      </div>
    </form>
  );
}
