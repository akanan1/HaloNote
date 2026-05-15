import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test-utils/render";

const listAuditLogMock = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useListAuditLog: (params: unknown) => listAuditLogMock(params),
}));

import { AuditLogPage } from "./AuditLog";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "log_a",
    userId: "usr_1",
    userDisplayName: "Dr. Alice",
    action: "list_patients",
    resourceType: "patient",
    resourceId: null,
    metadata: { status: 200, method: "GET" },
    at: "2026-05-12T08:00:00.000Z",
    ...overrides,
  };
}

describe("AuditLogPage", () => {
  beforeEach(() => {
    listAuditLogMock.mockReset();
  });

  it("renders rows with timestamp, user, action, resource, status pill", () => {
    listAuditLogMock.mockReturnValue({
      data: {
        data: [
          entry(),
          entry({
            id: "log_b",
            action: "create_note",
            resourceType: "note",
            resourceId: null,
            metadata: { status: 201, method: "POST" },
          }),
          entry({
            id: "log_c",
            action: "send_note_to_ehr",
            resourceType: "note",
            resourceId: "note_xyz",
            metadata: { status: 502, method: "POST" },
          }),
        ],
        nextCursor: null,
      },
      isPending: false,
      isError: false,
    });

    renderWithProviders(<AuditLogPage />, { initialPath: "/audit-log" });

    expect(screen.getByRole("heading", { name: /audit log/i })).toBeInTheDocument();
    // Each row renders twice in the DOM — once in the mobile card list
    // (md:hidden) and once in the desktop table (hidden md:table) — and
    // action labels also appear as filter chips. jsdom doesn't apply CSS,
    // so all branches are present. Use getAllByText for anything that
    // appears in both branches.
    expect(screen.getAllByText("list_patients").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("create_note").length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getAllByText("send_note_to_ehr").length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/note_xyz/).length).toBeGreaterThanOrEqual(2);
    // Status badges rendered from metadata
    expect(screen.getAllByText(/GET 200/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/POST 201/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/POST 502/).length).toBeGreaterThanOrEqual(2);
  });

  it("shows the empty-state card when no entries match the filters", () => {
    listAuditLogMock.mockReturnValue({
      data: { data: [], nextCursor: null },
      isPending: false,
      isError: false,
    });

    renderWithProviders(<AuditLogPage />, { initialPath: "/audit-log" });

    expect(
      screen.getByText(/no matching audit entries/i),
    ).toBeInTheDocument();
  });

  it("clicking an action filter chip refetches with that action", async () => {
    listAuditLogMock.mockReturnValue({
      data: { data: [], nextCursor: null },
      isPending: false,
      isError: false,
    });
    const user = userEvent.setup();
    renderWithProviders(<AuditLogPage />, { initialPath: "/audit-log" });

    // Initial call: no action filter.
    expect(listAuditLogMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
    const lastInitial = listAuditLogMock.mock.calls.at(-1)![0] as Record<
      string,
      unknown
    >;
    expect(lastInitial.action).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "create_note" }));

    expect(listAuditLogMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "create_note", limit: 100 }),
    );
  });

  it("displays a system-row marker when userDisplayName is null", () => {
    listAuditLogMock.mockReturnValue({
      data: {
        data: [
          entry({ userId: null, userDisplayName: null, action: "system_seed" }),
        ],
        nextCursor: null,
      },
      isPending: false,
      isError: false,
    });

    renderWithProviders(<AuditLogPage />, { initialPath: "/audit-log" });
    expect(screen.getAllByText(/\(system\)/i).length).toBeGreaterThanOrEqual(2);
  });
});
