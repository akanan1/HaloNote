import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  getCurrentUser,
  login,
  logout,
  type AuthUser,
} from "@workspace/api-client-react";
import { clearLegacyLocalClaims } from "./appointment-note-links";
import { clearAllForUser as clearAllRecordingsForUser } from "./recording-buffer";

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  signIn: (
    email: string,
    password: string,
    totpCode?: string,
  ) => Promise<void>;
  signOut: () => Promise<void>;
  /** Re-fetch /auth/me. Use after a flow that minted a fresh session
   *  outside of signIn — signup, password-reset confirm, etc. */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getCurrentUser()
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch(() => {
        // 401 = not signed in — leave user null.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(
    async (email: string, password: string, totpCode?: string) => {
      // The generated `login` hook is typed against the LoginRequest
      // schema, which doesn't include totpCode (it's optional and only
      // exists for 2FA-enabled users). Cast to bypass — the server tolerates
      // extra fields, and adding it to the spec just to satisfy the type
      // would balloon this surface.
      const me = await login({
        email,
        password,
        ...(totpCode ? { totpCode } : {}),
      } as Parameters<typeof login>[0]);
      setUser(me);
    },
    [],
  );

  const signOut = useCallback(async () => {
    // Best-effort: clear locally even if the server is unreachable. A
    // logout failure shouldn't strand the user on an authenticated UI
    // when their intent is to leave.
    try {
      await logout();
    } catch {
      // swallow — local state still gets cleared below
    }
    // Scrub any stale localStorage entries from the pre-migration
    // version of appointment claims. Active server-side claims persist
    // (they expire on their own TTL) — different user signing in on
    // the same device authenticates as themselves and only sees their
    // own claims from /api/appointment-claims/mine.
    clearLegacyLocalClaims();
    // Wipe any IndexedDB-buffered recording segments for this user.
    // PHI cleanup on intent-to-leave — a shared device (clinic kiosk,
    // shared laptop) must not surface the prior user's audio to whoever
    // logs in next via the recovery banner.
    const departingUserId = user?.id;
    if (departingUserId) {
      void clearAllRecordingsForUser(departingUserId).catch(() => {});
    }
    setUser(null);
  }, [user?.id]);

  const refresh = useCallback(async () => {
    try {
      const me = await getCurrentUser();
      setUser(me);
    } catch {
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, signIn, signOut, refresh }),
    [user, loading, signIn, signOut, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
