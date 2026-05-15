import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test-utils/render";

const listUsersMock = vi.fn();
const updateUserMutateMock = vi.fn();
const useUpdateUserMock = vi.fn();
const useAuthMock = vi.fn();

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: (msg: string) => toastSuccessMock(msg),
    error: (msg: string) => toastErrorMock(msg),
  },
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => useAuthMock(),
}));

// vi.mock factories are hoisted above top-level imports — use vi.hoisted so
// the FakeApiError class is constructed in time for the factory to capture it.
const { FakeApiError } = vi.hoisted(() => {
  class FakeApiError extends Error {
    override readonly name = "ApiError";
    constructor(
      readonly status: number,
      readonly data: unknown = null,
    ) {
      super(`HTTP ${status}`);
    }
  }
  return { FakeApiError };
});

vi.mock("@workspace/api-client-react", () => ({
  ApiError: FakeApiError,
  getListUsersQueryKey: () => ["users"],
  useListUsers: () => listUsersMock(),
  useUpdateUser: () => useUpdateUserMock(),
}));

import { AdminUsersPage } from "./AdminUsers";

function adminUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "usr_admin",
    email: "alice@halonote.app",
    displayName: "Dr. Alice",
    role: "admin",
    createdAt: "2026-01-10T12:00:00.000Z",
    ...overrides,
  };
}

function memberUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "usr_member",
    email: "bob@halonote.app",
    displayName: "Dr. Bob",
    role: "member",
    createdAt: "2026-02-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("AdminUsersPage", () => {
  beforeEach(() => {
    listUsersMock.mockReset();
    updateUserMutateMock.mockReset();
    useUpdateUserMock.mockReset();
    useAuthMock.mockReset();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();

    useUpdateUserMock.mockReturnValue({
      mutateAsync: updateUserMutateMock,
      isPending: false,
    });
    useAuthMock.mockReturnValue({
      user: { id: "usr_admin", role: "admin", displayName: "Dr. Alice" },
      loading: false,
    });
  });

  it("renders a row per user with role buttons and a (you) marker for the caller", () => {
    listUsersMock.mockReturnValue({
      data: { data: [adminUser(), memberUser()] },
      isPending: false,
      isError: false,
    });

    renderWithProviders(<AdminUsersPage />, { initialPath: "/admin/users" });

    expect(screen.getByRole("heading", { name: /users/i })).toBeInTheDocument();
    // Each user is rendered twice in the DOM — once in the mobile card
    // list (md:hidden) and once in the desktop table (hidden md:table) —
    // so the same name/email appears twice. jsdom doesn't apply CSS so
    // both branches are present.
    expect(screen.getAllByText("Dr. Alice").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Dr. Bob").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/\(you\)/i).length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getAllByText("alice@halonote.app").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      screen.getAllByText("bob@halonote.app").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("disables the Member button on the caller's own admin row to block self-demotion", () => {
    listUsersMock.mockReturnValue({
      data: { data: [adminUser()] },
      isPending: false,
      isError: false,
    });

    renderWithProviders(<AdminUsersPage />, { initialPath: "/admin/users" });

    // Two role buttons each in mobile + desktop renders → 2 Member buttons.
    // Both must be disabled in the self-demotion case.
    const memberBtns = screen.getAllByRole("button", { name: "Member" });
    expect(memberBtns.length).toBeGreaterThanOrEqual(2);
    for (const btn of memberBtns) expect(btn).toBeDisabled();
  });

  it("calls updateUser when promoting a member to admin and shows success toast", async () => {
    listUsersMock.mockReturnValue({
      data: { data: [memberUser()] },
      isPending: false,
      isError: false,
    });
    updateUserMutateMock.mockResolvedValueOnce({});
    const user = userEvent.setup();

    renderWithProviders(<AdminUsersPage />, { initialPath: "/admin/users" });

    // Clicking either copy fires the same handler — both branches render
    // in jsdom regardless of viewport.
    await user.click(screen.getAllByRole("button", { name: "Admin" })[0]!);

    await waitFor(() => {
      expect(updateUserMutateMock).toHaveBeenCalledWith({
        id: "usr_member",
        data: { role: "admin" },
      });
    });
    expect(toastSuccessMock).toHaveBeenCalledWith(
      expect.stringMatching(/now an admin/i),
    );
  });

  it("shows the cannot_demote_self toast when the server returns 403 with that code", async () => {
    // Render as if a second admin row exists so the Member button isn't UI-disabled.
    listUsersMock.mockReturnValue({
      data: { data: [adminUser({ id: "usr_other", email: "carol@x", displayName: "Dr. Carol" })] },
      isPending: false,
      isError: false,
    });
    updateUserMutateMock.mockRejectedValueOnce(
      new FakeApiError(403, { error: "cannot_demote_self" }),
    );
    const user = userEvent.setup();

    renderWithProviders(<AdminUsersPage />, { initialPath: "/admin/users" });

    await user.click(screen.getAllByRole("button", { name: "Member" })[0]!);

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        expect.stringMatching(/can't demote your own admin role/i),
      );
    });
  });

  it("shows the admins-only card when the list query returns 403", () => {
    listUsersMock.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: new FakeApiError(403),
    });

    renderWithProviders(<AdminUsersPage />, { initialPath: "/admin/users" });

    expect(screen.getByText(/admins only/i)).toBeInTheDocument();
  });
});
