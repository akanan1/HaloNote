import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test-utils/render";

const signupMock = vi.fn();
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
  signup: (...args: unknown[]) => signupMock(...args),
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
    useLocation: () => ["/signup", navigateMock],
  };
});

import { SignupPage } from "./Signup";

describe("SignupPage", () => {
  beforeEach(() => {
    signupMock.mockReset();
    refreshMock.mockClear();
    navigateMock.mockReset();
  });

  it("creates an account and navigates to / on success", async () => {
    signupMock.mockResolvedValue({
      id: "usr_1",
      email: "x@y.test",
      displayName: "X",
    });
    const user = userEvent.setup();
    renderWithProviders(<SignupPage />);

    await user.type(screen.getByLabelText(/full name/i), "Dr. New");
    await user.type(screen.getByLabelText(/email/i), "new@halonote.test");
    await user.type(screen.getByLabelText(/password/i), "long enough password");
    await user.click(
      screen.getByRole("button", { name: /create account/i }),
    );

    await waitFor(() =>
      expect(signupMock).toHaveBeenCalledWith({
        email: "new@halonote.test",
        password: "long enough password",
        displayName: "Dr. New",
      }),
    );
    expect(refreshMock).toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith("/");
  });

  it("blocks too-short passwords client-side with a message", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SignupPage />);

    await user.type(screen.getByLabelText(/full name/i), "Dr. New");
    await user.type(screen.getByLabelText(/email/i), "new@halonote.test");
    await user.type(screen.getByLabelText(/password/i), "short");
    await user.click(
      screen.getByRole("button", { name: /create account/i }),
    );

    expect(
      await screen.findByText(/at least 8 characters/i),
    ).toBeInTheDocument();
    expect(signupMock).not.toHaveBeenCalled();
  });

  it("shows a friendly message on 409", async () => {
    signupMock.mockRejectedValue(new FakeApiError(409));
    const user = userEvent.setup();
    renderWithProviders(<SignupPage />);

    await user.type(screen.getByLabelText(/full name/i), "Dr. New");
    await user.type(screen.getByLabelText(/email/i), "taken@halonote.test");
    await user.type(screen.getByLabelText(/password/i), "long enough password");
    await user.click(
      screen.getByRole("button", { name: /create account/i }),
    );

    expect(
      await screen.findByText(/account with this email already exists/i),
    ).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
