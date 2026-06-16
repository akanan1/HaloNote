export * from "./generated/api";
export * from "./generated/types";

// Re-export `z` so server-side consumers can build ad-hoc schemas
// (e.g. request bodies for routes that aren't in the OpenAPI spec
// yet) without having to declare their own direct zod dependency.
export { z } from "zod/v4";
