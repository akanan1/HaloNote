import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const getCurrentUserMock = vi.fn();
const loginMock = vi.fn();
const logoutMock = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  getCurrentUser: (...args: unknown[]) => getCurrentUserMock(...args),
  login: (...args: unknown[]) => loginMock(...args),
  logout: (...args: unknown[]) => logoutMock(...args),
}));

import { AuthProvider, useAuth } from "./auth";

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

describe("AuthProvider", () => {
  beforeEach(() => {
    getCurrentUserMock.mockReset();
    loginMock.mockReset();
    logoutMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("starts in loading state, then null when /auth/me 401s", async () => {
    getCurrentUserMock.mockRejectedValue(new Error("401"));

    const { result } = renderHook(() => useAuth(), { wrapper });

    expect(result.current.loading).toBe(true);
    expect(result.current.user).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeNull();
  });

  it("hydrates the user from /auth/me on mount", async () => {
    getCurrentUserMock.mockResolvedValue({
      id: "usr_1",
      email: "alice@x",
      displayName: "Alice",
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toEqual({
      id: "usr_1",
      email: "alice@x",
      displayName: "Alice",
    });
  });

  it("signIn calls login() and stores the returned user", async () => {
    getCurrentUserMock.mockRejectedValue(new Error("401"));
    loginMock.mockResolvedValue({
      id: "usr_1",
      email: "alice@x",
      displayName: "Alice",
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.signIn("alice@x", "secret");
    });

    expect(loginMock).toHaveBeenCalledWith({
      email: "alice@x",
      password: "secret",
    });
    expect(result.current.user?.email).toBe("alice@x");
  });

  it("signOut calls logout() and clears the user, even if logout rejects", async () => {
    getCurrentUserMock.mockResolvedValue({
      id: "usr_1",
      email: "alice@x",
      displayName: "Alice",
    });
    logoutMock.mockRejectedValue(new Error("network blip"));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).not.toBeNull());

    await act(async () => {
      await result.current.signOut();
    });

    expect(logoutMock).toHaveBeenCalled();
    expect(result.current.user).toBeNull();
  });
});
