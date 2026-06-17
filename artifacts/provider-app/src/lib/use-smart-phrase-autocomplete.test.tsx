import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";

const customFetchMock = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  customFetch: (...args: unknown[]) => customFetchMock(...args),
  useListSmartPhrases: () => ({
    data: {
      data: [
        {
          id: "smt_htn",
          shortcut: "htn",
          body: "Hypertension, well-controlled.",
          description: "Hypertension A&P",
          usageCount: 5,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: "smt_hpi",
          shortcut: "hpi",
          body: "Patient presents with...",
          description: null,
          usageCount: 2,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    },
    isPending: false,
    isError: false,
  }),
  getListSmartPhrasesQueryKey: () => ["/api/smart-phrases"],
}));

import { useSmartPhraseAutocomplete } from "./use-smart-phrase-autocomplete";
import { SmartPhraseDropdown } from "@/components/SmartPhraseDropdown";

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

// Test harness: a minimal page hosting the textarea + dropdown the same
// way NewNote does. Lets us drive the hook with real keyboard events
// so the dot-token regex and key handling actually exercise.
function Host() {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [value, setValue] = useState("");
  const ac = useSmartPhraseAutocomplete({
    textareaRef: ref,
    value,
    setValue,
  });
  return (
    <div className="relative">
      <textarea
        ref={ref}
        aria-label="note"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={ac.onKeyDown}
      />
      <SmartPhraseDropdown
        open={ac.open}
        suggestions={ac.suggestions}
        activeIndex={ac.activeIndex}
        onPick={ac.pick}
        onHover={ac.setActiveIndex}
      />
    </div>
  );
}

describe("useSmartPhraseAutocomplete", () => {
  beforeEach(() => {
    customFetchMock.mockReset();
    customFetchMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the dropdown after a dot-token is typed", async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <Host />
      </Wrapper>,
    );
    const ta = screen.getByLabelText("note");
    await user.click(ta);
    await user.keyboard(".h");

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    // Both .htn and .hpi start with "h".
    expect(options).toHaveLength(2);
  });

  it("does not open on a dot in the middle of a word", async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <Host />
      </Wrapper>,
    );
    const ta = screen.getByLabelText("note");
    await user.click(ta);
    await user.keyboard("abc.h");

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Enter expands the active suggestion and replaces the .shortcut", async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <Host />
      </Wrapper>,
    );
    const ta = screen.getByLabelText<HTMLTextAreaElement>("note");
    await user.click(ta);
    await user.keyboard(".htn{Enter}");

    // rAF + state flush
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });

    expect(ta.value).toBe("Hypertension, well-controlled.");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(customFetchMock).toHaveBeenCalledWith(
      "/api/smart-phrases/smt_htn/used",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("Escape dismisses without inserting", async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <Host />
      </Wrapper>,
    );
    const ta = screen.getByLabelText<HTMLTextAreaElement>("note");
    await user.click(ta);
    await user.keyboard(".htn{Escape}");

    expect(ta.value).toBe(".htn");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("ArrowDown moves activeIndex and Enter picks the second option", async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <Host />
      </Wrapper>,
    );
    const ta = screen.getByLabelText<HTMLTextAreaElement>("note");
    await user.click(ta);
    await user.keyboard(".h{ArrowDown}{Enter}");

    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });

    // .htn was first (usageCount 5); ArrowDown moves to .hpi.
    expect(ta.value).toBe("Patient presents with...");
  });

  it("preserves a leading space when expanding mid-line", async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <Host />
      </Wrapper>,
    );
    const ta = screen.getByLabelText<HTMLTextAreaElement>("note");
    await user.click(ta);
    await user.keyboard("hello .htn{Enter}");

    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });

    expect(ta.value).toBe("hello Hypertension, well-controlled.");
  });
});
