import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// RTL's auto-cleanup only fires when test runners expose globals; we run
// with globals: false, so wire cleanup manually. Without this, every
// `render()` accumulates in the DOM and getByText starts seeing copies
// from previous tests.
afterEach(() => {
  cleanup();
});
