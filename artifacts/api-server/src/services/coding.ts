// Coder service — barrel re-export over the split implementation files.
//
// Existing callers (routes/coding.ts, routes/notes.ts, services/athena-
// ingest.ts) import from "./services/coding"; this barrel keeps those
// imports stable while the actual code lives in single-purpose modules:
//
//   coding-internals    — shared helpers (loadSessionSuggestions,
//                         CONFIDENCE_RANK, suggestionHasBlocker,
//                         sha256Hex, PUSH_CONCURRENCY)
//   coding-generation   — generateCoding + kickCodingForApprovedNote
//                         + getLatestSession + getSessionById
//   coding-approval     — editSuggestion + approveAllHighConfidence
//   coding-refinement   — refineSuggestion + refineAllInSession
//                         + applyRefinement
//   biller-queue        — listBillerQueue
//
// New code should prefer importing from the specific file when only one
// piece is needed; the barrel exists for backward compatibility with
// existing call sites.

export {
  generateCoding,
  getLatestSession,
  getSessionById,
  kickCodingForApprovedNote,
  type GenerateCodingArgs,
  type GenerateCodingResult,
  type GetSessionResult,
  type KickArgs,
} from "./coding-generation";

export {
  approveAllHighConfidence,
  editSuggestion,
  type ApproveAllArgs,
  type ApproveAllResult,
  type EditSuggestionArgs,
  type EditSuggestionResult,
} from "./coding-approval";

export {
  applyRefinement,
  refineAllInSession,
  refineSuggestion,
  type ApplyRefinementResult,
  type RefineAllResult,
  type RefineSuggestionResult,
} from "./coding-refinement";

export { listBillerQueue, type BillerQueueRow } from "./biller-queue";
