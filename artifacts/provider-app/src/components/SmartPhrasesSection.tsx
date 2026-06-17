import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ApiError,
  getListSmartPhrasesQueryKey,
  useCreateSmartPhrase,
  useDeleteSmartPhrase,
  useListSmartPhrases,
  useUpdateSmartPhrase,
  type SmartPhrase,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// Editor-time dot-phrases. The provider types `.shortcut` in the note
// textarea and it expands to `body`. Mirrors the templates / phrase-
// mappings UX pattern: card + list rows + inline create form.
export function SmartPhrasesSection() {
  const queryClient = useQueryClient();
  const query = useListSmartPhrases({
    query: { queryKey: getListSmartPhrasesQueryKey() },
  });
  const create = useCreateSmartPhrase();
  const [creating, setCreating] = useState(false);

  function invalidate() {
    void queryClient.invalidateQueries({
      queryKey: getListSmartPhrasesQueryKey(),
    });
  }

  const phrases = query.data?.data ?? [];

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-lg font-medium">Smart phrases</h2>
        <p className="text-sm text-(--color-muted-foreground)">
          Type a leading{" "}
          <span className="font-mono">.shortcut</span> in any note and it
          expands to your saved text. Stays on your device — the AI
          pipeline never sees the shortcut you typed.
        </p>
      </header>

      <Card className="overflow-hidden">
        {query.isPending ? (
          <ul
            className="divide-y divide-(--color-border)"
            role="status"
            aria-label="Loading smart phrases"
          >
            {[0, 1].map((i) => (
              <li key={i} className="space-y-2 px-4 py-3">
                <div className="h-4 w-1/3 animate-pulse rounded bg-(--color-muted)" />
                <div className="h-3 w-2/3 animate-pulse rounded bg-(--color-muted)" />
              </li>
            ))}
          </ul>
        ) : query.isError ? (
          <p
            role="alert"
            className="px-4 py-6 text-sm text-(--color-destructive)"
          >
            Couldn't load your smart phrases.
          </p>
        ) : phrases.length === 0 ? (
          <p className="px-4 py-6 text-sm text-(--color-muted-foreground)">
            No phrases yet. Add your first below — for example,{" "}
            <span className="font-mono">.htn</span> → "Hypertension,
            well-controlled on current regimen."
          </p>
        ) : (
          <ul
            className="divide-y divide-(--color-border)"
            aria-label="Smart phrases"
          >
            {phrases.map((p) => (
              <SmartPhraseRow key={p.id} phrase={p} onChanged={invalidate} />
            ))}
          </ul>
        )}

        <div className="border-t border-(--color-border) bg-(--color-muted)/40 px-4 py-3">
          {creating ? (
            <CreatePhraseForm
              busy={create.isPending}
              onCancel={() => setCreating(false)}
              onSubmit={async (shortcut, body, description) => {
                try {
                  await create.mutateAsync({
                    data: { shortcut, body, description },
                  });
                  toast.success(`Added .${shortcut}`);
                  setCreating(false);
                  invalidate();
                } catch (err) {
                  if (err instanceof ApiError && err.status === 409) {
                    toast.error(`Shortcut .${shortcut} is already in use.`);
                  } else if (err instanceof ApiError && err.status === 400) {
                    toast.error(
                      "Shortcut can't include spaces or dots.",
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
              Add phrase
            </Button>
          )}
        </div>
      </Card>
    </section>
  );
}

function SmartPhraseRow({
  phrase,
  onChanged,
}: {
  phrase: SmartPhrase;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [shortcut, setShortcut] = useState(phrase.shortcut);
  const [body, setBody] = useState(phrase.body);
  const [description, setDescription] = useState(phrase.description ?? "");
  const update = useUpdateSmartPhrase();
  const remove = useDeleteSmartPhrase();

  async function save() {
    const s = shortcut.trim();
    const b = body.trim();
    if (!s || !b) return;
    try {
      await update.mutateAsync({
        id: phrase.id,
        data: {
          shortcut: s,
          body: b,
          // Send null to explicitly clear an emptied description —
          // omitting it would leave the existing one in place.
          description: description.trim() === "" ? null : description.trim(),
        },
      });
      setEditing(false);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.error(`Shortcut .${s} is already in use.`);
      } else if (err instanceof ApiError && err.status === 400) {
        toast.error("Shortcut can't include spaces or dots.");
      } else {
        toast.error(err instanceof Error ? err.message : "Couldn't save");
      }
    }
  }

  async function handleDelete() {
    try {
      await remove.mutateAsync({ id: phrase.id });
      toast.success(`Removed .${phrase.shortcut}`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete");
    }
  }

  if (editing) {
    return (
      <li className="space-y-3 px-4 py-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[10rem_1fr]">
          <div className="space-y-1">
            <Label htmlFor={`shortcut-${phrase.id}`} className="text-xs">
              Shortcut
            </Label>
            <Input
              id={`shortcut-${phrase.id}`}
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value)}
              disabled={update.isPending}
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`description-${phrase.id}`} className="text-xs">
              Description (optional)
            </Label>
            <Input
              id={`description-${phrase.id}`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={update.isPending}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`body-${phrase.id}`} className="text-xs">
            Expansion
          </Label>
          <Textarea
            id={`body-${phrase.id}`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            disabled={update.isPending}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setShortcut(phrase.shortcut);
              setBody(phrase.body);
              setDescription(phrase.description ?? "");
              setEditing(false);
            }}
            disabled={update.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={update.isPending || !shortcut.trim() || !body.trim()}
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
    <li className="flex flex-wrap items-start gap-3 px-4 py-3">
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="min-w-0 flex-1 text-left"
        aria-label={`Edit smart phrase .${phrase.shortcut}`}
      >
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span className="font-mono text-sm font-medium text-(--color-primary)">
            .{phrase.shortcut}
          </span>
          {phrase.description ? (
            <span className="text-sm text-(--color-foreground)">
              {phrase.description}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs text-(--color-muted-foreground) whitespace-pre-wrap">
          {phrase.body}
        </p>
      </button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void handleDelete()}
        disabled={remove.isPending}
        aria-label="Delete smart phrase"
        className="text-(--color-destructive)"
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </Button>
    </li>
  );
}

function CreatePhraseForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (
    shortcut: string,
    body: string,
    description: string | null,
  ) => Promise<void>;
}) {
  const [shortcut, setShortcut] = useState("");
  const [body, setBody] = useState("");
  const [description, setDescription] = useState("");

  async function handle(e: React.FormEvent) {
    e.preventDefault();
    const s = shortcut.trim();
    const b = body.trim();
    if (!s || !b) return;
    await onSubmit(s, b, description.trim() === "" ? null : description.trim());
  }

  return (
    <form className="space-y-3" onSubmit={(e) => void handle(e)}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[10rem_1fr]">
        <div className="space-y-1">
          <Label htmlFor="new-shortcut" className="text-xs">
            Shortcut
          </Label>
          <Input
            id="new-shortcut"
            value={shortcut}
            onChange={(e) => setShortcut(e.target.value)}
            placeholder="htn"
            disabled={busy}
            autoFocus
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="new-description" className="text-xs">
            Description (optional)
          </Label>
          <Input
            id="new-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Hypertension A&P"
            disabled={busy}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="new-body" className="text-xs">
          Expansion
        </Label>
        <Textarea
          id="new-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Hypertension, well-controlled on current regimen. Continue lisinopril 20 mg daily, follow up in 3 months."
          rows={4}
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
          disabled={busy || !shortcut.trim() || !body.trim()}
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
