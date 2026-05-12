import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test-utils/render";

const confirmMock = vi.fn();
const refreshMock = vi.fn().mockResolvedValue(undefined);
const navigateMock = vi.fn();

const { FakeApiError } = vi.hoisted(() => {
  class FakeApiError extends Error {
    override readonly name = "ApiError";
    constructor(readonly status: number) {
      super(`HTTP ${status}`);
    }
  }
  return { FakeApiError };
});

vi.mock("@workspace/api-client-react", () => ({
  ApiError: FakeApiError,
  confirmPasswordReset: (...args: unknown[]) => confirmMock(...args),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: null,
    loading: false,
    signIn: vi.fn(),
    signOut: vi.fn(),
    refresh: refreshMock,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("wouter", async () => {
  const actual = await vi.importActual<typeof import("wouter")>("wouter");
  return {
    ...actual,
    useLocation: () => ["/reset-password", navigateMock],
  };
});

import { ResetPasswordPage } from "./ResetPassword";

// JSDOM lets us tweak window.location.search to feed the token to the page.
const originalSearch = window.location.search;
function setQuery(search: string) {
  window.history.replaceState({}, "", `/reset-password${search}`);
}

describe("ResetPasswordPage", () => {
  beforeEach(() => {
    confirmMock.mockReset();
    refreshMock.mockClear();
    navigateMock.mockReset();
  });

  afterEach(() => {
    window.history.replaceState({}, "", `/${originalSearch}`);
  });

  it("renders the missing-token fallback when there's no ?token=", () => {
    setQuery("");
    renderWithProviders(<ResetPasswordPage />);
    expect(screen.getByText(/reset link missing/i)).toBeInTheDocument();
  });

  it("rejects mismatched passwords client-side", async () => {
    setQuery("?token=valid-test-token");
    const user = userEvent.setup();
    renderWithProviders(<ResetPasswordPage />);

    await user.type(screen.getByLabelText(/^new password$/i), "the new password");
    await user.type(
      screen.getByLabelText(/confirm new password/i),
      "different password",
    );
    await user.click(screen.getByRole("button", { name: /save new password/i }));

    expect(await screen.findByText(/passwords don't match/i)).toBeInTheDocument();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("submits the token + new password, refreshes auth, and navigates home", async () => {
    setQuery("?token=valid-test-token");
    confirmMock.mockResolvedValue({
      id: "usr_1",
      email: "x@y.test",
      displayName: "X",
    });
    const user = userEvent.setup();
    renderWithProviders(<ResetPasswordPage />);

    await user.type(screen.getByLabelText(/^new password$/i), "the new password");
    await user.type(
      screen.getByLabelText(/confirm new password/i),
      "the new password",
    );
    await user.click(screen.getByRole("button", { name: /save new password/i }));

    await waitFor(() =>
      expect(confirmMock).toHaveBeenCalledWith({
        token: "valid-test-token",
        password: "the new password",
      }),
    );
    expect(refreshMock).toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith("/");
  });

  it("surfaces an expired/invalid token error on 400", async () => {
    setQuery("?token=expired-token");
    confirmMock.mockRejectedValue(new FakeApiError(400));
    const user = userEvent.setup();
    renderWithProviders(<ResetPasswordPage />);

    await user.type(screen.getByLabelText(/^new password$/i), "the new password");
    await user.type(
      screen.getByLabelText(/confirm new password/i),
      "the new password",
    );
    await user.click(screen.getByRole("button", { name: /save new password/i }));

    expect(
      await screen.findByText(/invalid or has expired/i),
    ).toBeInTheDocument();
  });
});
