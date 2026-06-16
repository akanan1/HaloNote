import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListNotesQueryKey,
  useCreateNote,
  useUpdateNote,
} from "@workspace/api-client-react";

export type AutosaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

export interface UseNoteAutosaveParams {
  body: string;
  patientId: string;
  replacesNoteId?: string;
  /**
   * When the new-note composer is rooted in an encounter (the provider
   * navigated from EncounterReview / clicked Start encounter), pass the
   * encounter id so the autosaved draft is linked to it. The server
   * verifies the encounter belongs to the same patient and tenant.
   */
  encounterId?: string;
  enabled?: boolean;
  debounceMs?: number;
}

export interface UseNoteAutosaveResult {
  status: AutosaveStatus;
  /** The persisted draft's id, once at least one save has succeeded. */
  draftId: string | null;
  error: string | null;
  /** ISO timestamp of the last successful save. */
  lastSavedAt: string | null;
  /** Force pending changes to flush immediately. Returns the draft id. */
  flush(): Promise<string | null>;
}

/**
 * Debounced autosave for the new-note composer.
 *
 * - The first save creates a note row; subsequent saves PATCH that row.
 * - Empty bodies never persist (avoids littering blank drafts).
 * - flush() bypasses the debounce — the explicit Save / Send buttons call
 *   it so the user never sees "saving…" during a button click.
 * - Skips when `enabled` is false (e.g., while the EHR send is in flight).
 */
export function useNoteAutosave(
  params: UseNoteAutosaveParams,
): UseNoteAutosaveResult {
  const {
    body,
    patientId,
    replacesNoteId,
    encounterId,
    enabled = true,
    debounceMs = 1500,
  } = params;
  const queryClient = useQueryClient();
  const createNote = useCreateNote();
  const updateNote = useUpdateNote();

  const [draftId, setDraftId] = useState<string | null>(null);
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

  // Refs survive renders without retriggering effects. lastSavedBodyRef
  // keeps us from POSTing identical content over and over, and inFlightRef
  // serializes overlapping save attempts when a user types faster than
  // the server responds.
  const lastSavedBodyRef = useRef<string>("");
  const inFlightRef = useRef<Promise<string | null> | null>(null);
  const draftIdRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);

  function invalidateNotes() {
    void queryClient.invalidateQueries({
      queryKey: getListNotesQueryKey({ patientId }),
    });
    void queryClient.invalidateQueries({ queryKey: getListNotesQueryKey() });
  }

  // The actual save call. Always returns the draft id (or null on failure).
  const performSave = useCallback(async (): Promise<string | null> => {
    const trimmed = body.trim();
    if (!trimmed) return draftIdRef.current;
    if (trimmed === lastSavedBodyRef.current.trim()) return draftIdRef.current;

    // Coalesce concurrent flush() + debounce-timer calls.
    if (inFlightRef.current) return inFlightRef.current;

    setStatus("saving");
    setError(null);

    const promise = (async () => {
      try {
        if (draftIdRef.current) {
          await updateNote.mutateAsync({
            id: draftIdRef.current,
            data: { body },
          });
        } else {
          const note = await createNote.mutateAsync({
            data: {
              patientId,
              body,
              ...(replacesNoteId ? { replacesNoteId } : {}),
              ...(encounterId ? { encounterId } : {}),
            },
          });
          draftIdRef.current = note.id;
          setDraftId(note.id);
        }
        lastSavedBodyRef.current = body;
        setLastSavedAt(new Date().toISOString());
        setStatus("saved");
        invalidateNotes();
        return draftIdRef.current;
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Autosave failed");
        return draftIdRef.current;
      } finally {
        inFlightRef.current = null;
      }
    })();

    inFlightRef.current = promise;
    return promise;
    // body/patientId/replacesNoteId/encounterId are captured fresh each call;
    // createNote / updateNote are stable react-query mutation handles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, patientId, replacesNoteId, encounterId]);

  // Schedule a debounced save whenever the body changes (and differs from
  // the last persisted content).
  useEffect(() => {
    if (!enabled) return;
    const trimmed = body.trim();
    if (!trimmed) {
      setStatus(draftIdRef.current ? "saved" : "idle");
      return;
    }
    if (trimmed === lastSavedBodyRef.current.trim()) {
      setStatus("saved");
      return;
    }
    setStatus("dirty");
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      void performSave();
    }, debounceMs);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [body, debounceMs, enabled, performSave]);

  const flush = useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    return performSave();
  }, [performSave]);

  return { status, draftId, error, lastSavedAt, flush };
}
