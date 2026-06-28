import { useMemo, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import {
  ApiError,
  confirmPasswordReset,
  customFetch,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Mirror of the backend response when a 2FA-protected account tries
// to reset without supplying a TOTP code. The backend ships
// { error: "totp_required", code: "TOTP_REQUIRED" } at 400; we key
// off the structured `code` field rather than string-matching error.
interface TotpRequiredError {
  code?: string;
  error?: string;
}

function getQueryToken(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("token") ?? "";
}

export function ResetPasswordPage() {
  const { refresh } = useAuth();
  const [, navigate] = useLocation();
  // Snapshot the token from the URL once on mount. Even if the user fiddles
  // with the address bar, we keep using the link they followed in.
  const token = useMemo(() => getQueryToken(), []);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 2FA accounts: the first submit returns 400 TOTP_REQUIRED and we
  // reveal the TOTP input. The user re-submits with the same
  // password fields plus the code.
  const [totpRequired, setTotpRequired] = useState(false);
  const [totpCode, setTotpCode] = useState("");

  if (!token) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6">
        <img
          src="/halonote-logo-on-light.svg"
          alt="HaloNote"
          className="h-8 w-auto"
        />
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-2xl">Reset link missing</CardTitle>
            <p className="text-sm text-(--color-muted-foreground)">
              This page needs a reset token. Open the link from your email.
            </p>
          </CardHeader>
          <CardContent>
            <Link href="/forgot-password">
              <Button variant="outline" className="w-full">
                Send me a new link
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (password.length < 8) {
      setError("Pick a password with at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    if (totpRequired && !/^\d{6}$/.test(totpCode)) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      // The generated client doesn't carry the optional `totpCode`
      // field (we follow the same "inline totpCode without schema
      // change" convention as /auth/login). Hit the same endpoint
      // through customFetch when 2FA is in play; the response shape
      // is identical to confirmPasswordReset's success path.
      if (totpRequired) {
        await customFetch("/api/auth/password-reset/confirm", {
          method: "POST",
          body: JSON.stringify({ token, password, totpCode }),
        });
      } else {
        await confirmPasswordReset({ token, password });
      }
      await refresh();
      navigate("/");
    } catch (err) {
      // Structured 400 with code:"TOTP_REQUIRED" means the target
      // user has 2FA on and we need a fresh authenticator code.
      // We surface the input rather than failing the whole flow.
      if (err instanceof ApiError && err.status === 400) {
        const data = err.data as TotpRequiredError | null;
        if (data?.code === "TOTP_REQUIRED") {
          setTotpRequired(true);
          setError(
            "This account has two-factor auth on. Enter the 6-digit code from your authenticator app to finish resetting.",
          );
          return;
        }
        setError(
          "This reset link is invalid or has expired. Request a new one.",
        );
      } else if (err instanceof ApiError && err.status === 401) {
        // Wrong TOTP code. Don't clear the totpRequired flag so the
        // input stays visible for retry.
        setError("That code didn't match. Try the next one.");
      } else if (err instanceof ApiError && err.status === 429) {
        setError(
          "Too many attempts on this reset link. Request a new one.",
        );
      } else {
        setError(
          err instanceof Error ? err.message : "Couldn't reset your password.",
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6">
      <img
        src="/halonote-logo-on-light.svg"
        alt="HaloNote"
        className="h-8 w-auto"
      />
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">Choose a new password</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                required
                disabled={submitting}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirm new password</Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                disabled={submitting}
              />
            </div>
            {totpRequired ? (
              <div className="space-y-2">
                <Label htmlFor="totp-code">Authenticator code</Label>
                <Input
                  id="totp-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) =>
                    setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  placeholder="123456"
                  required
                  disabled={submitting}
                  autoFocus
                />
              </div>
            ) : null}
            {error ? (
              <p className="text-sm text-(--color-destructive)">{error}</p>
            ) : null}
            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={submitting}
            >
              {submitting ? "Saving…" : "Save new password"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
