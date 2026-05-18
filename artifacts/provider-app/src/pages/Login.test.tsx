import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test-utils/render";

const signInMock = vi.fn();
const navigateMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: null,
    loading: false,
    signIn: signInMock,
    signOut: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("wouter", async () => {
  const actual = await vi.importActual<typeof import("wouter")>("wouter");
  return {
    ...actual,
    useLocation: () => ["/login", navigateMock],
  };
});

// vi.mock factories are hoisted above the module's top-level code, so the
// stand-in ApiError class needs to be hoisted with `vi.hoisted` to be in
// scope when the factory runs.
const { FakeApiError } = vi.hoisted(() => {
  class FakeApiError extends Error {
    override readonly name = "ApiError";
    constructor(
      readonly status: number,
      readonly headers: Headers = new Headers(),
    ) {
      super(`HTTP ${status}`);
    }
  }
  return { FakeApiError };
});

vi.mock("@workspace/api-client-react", () => ({
  ApiError: FakeApiError,
}));

import { LoginPage } from "./Login";

describe("LoginPage", () => {
  beforeEach(() => {
    signInMock.mockReset();
    navigateMock.mockReset();
  });

  it("submits and navigates to / on success", async () => {
    signInMock.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "alice@x");
    await user.type(screen.getByLabelText(/password/i), "secret");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() =>
      expect(signInMock).toHaveBeenCalledWith("alice@x", "secret", undefined),
    );
    expect(navigateMock).toHaveBeenCalledWith("/");
  });

  it("blocks empty submission with a client-side message", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    // Bypass the native `required` check so we exercise our own validation.
    screen.getByLabelText(/email/i).removeAttribute("required");
    screen.getByLabelText(/password/i).removeAttribute("required");

    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(
      await screen.findByText(/enter your email and password/i),
    ).toBeInTheDocument();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("shows 'Invalid email or password.' on 401", async () => {
    signInMock.mockRejectedValue(new FakeApiError(401));
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "alice@x");
    await user.type(screen.getByLabelText(/password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(
      await screen.findByText(/invalid email or password/i),
    ).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("parses Retry-After on 429 and surfaces a minute count", async () => {
    const headers = new Headers({ "retry-after": "120" });
    signInMock.mockRejectedValue(new FakeApiError(429, headers));
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "alice@x");
    await user.type(screen.getByLabelText(/password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(
      await screen.findByText(/try again in 2 minutes/i),
    ).toBeInTheDocument();
  });

  it("falls back to a generic message when Retry-After is missing", async () => {
    signInMock.mockRejectedValue(new FakeApiError(429));
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "alice@x");
    await user.type(screen.getByLabelText(/password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(
      await screen.findByText(/try again later/i),
    ).toBeInTheDocument();
  });

  it("disables the submit button while the request is in flight", async () => {
    let resolveSignIn: () => void = () => {};
    signInMock.mockImplementation(
      () => new Promise<void>((r) => (resolveSignIn = r)),
    );
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "alice@x");
    await user.type(screen.getByLabelText(/password/i), "secret");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    const btn = await screen.findByRole("button", { name: /signing in/i });
    expect(btn).toBeDisabled();

    resolveSignIn();
    await waitFor(() => expect(navigateMock).toHaveBeenCalled());
  });
});

// ?next= resume target tests — drives the Cerner SMART launch
// continuation after the resident signs into HaloNote.
//
// LoginPage reads window.location.search ONCE on mount, so each test
// patches it before importing/rendering. We use Object.defineProperty
// to swap a clean Location-like over jsdom's default. window.location
// .assign is the seam we assert on (full-page nav for /api/* targets).
describe("LoginPage — ?next= resume target", () => {
  let assignMock: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    signInMock.mockReset();
    navigateMock.mockReset();
    originalLocation = window.location;
    assignMock = vi.fn();
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  function patchLocation(search: string) {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        ...originalLocation,
        href: `http://localhost:3000/login${search}`,
        pathname: "/login",
        search,
        origin: "http://localhost:3000",
        protocol: "http:",
        assign: assignMock,
      } as unknown as Location,
    });
  }

  it("continues to a same-origin /api Cerner launch URL after sign-in", async () => {
    const launchUrl =
      "/api/auth/ehr/cerner/launch?iss=https%3A%2F%2Ffhir.example%2Fr4&launch=opaque";
    patchLocation(`?next=${encodeURIComponent(launchUrl)}`);
    signInMock.mockResolvedValue(undefined);

    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "alice@x");
    await user.type(screen.getByLabelText(/password/i), "secret");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(signInMock).toHaveBeenCalled());
    // Full-page nav for /api/* — wouter's SPA navigate must NOT fire.
    expect(assignMock).toHaveBeenCalledWith(launchUrl);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("falls back to '/' when ?next= points off-origin (open-redirect defense)", async () => {
    patchLocation(`?next=${encodeURIComponent("https://evil.example/steal")}`);
    signInMock.mockResolvedValue(undefined);

    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "alice@x");
    await user.type(screen.getByLabelText(/password/i), "secret");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(signInMock).toHaveBeenCalled());
    // External target must be rejected → SPA fallback to "/".
    expect(assignMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith("/");
  });

  it("falls back to '/' when ?next= is protocol-relative (//evil.example)", async () => {
    patchLocation(`?next=${encodeURIComponent("//evil.example/path")}`);
    signInMock.mockResolvedValue(undefined);

    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "alice@x");
    await user.type(screen.getByLabelText(/password/i), "secret");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(signInMock).toHaveBeenCalled());
    expect(assignMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith("/");
  });

  it("preserves the original behavior when ?next= is absent", async () => {
    patchLocation("");
    signInMock.mockResolvedValue(undefined);

    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "alice@x");
    await user.type(screen.getByLabelText(/password/i), "secret");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/"));
    expect(assignMock).not.toHaveBeenCalled();
  });
});
