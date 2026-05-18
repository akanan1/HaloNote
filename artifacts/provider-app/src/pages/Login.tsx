import { useMemo, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { ApiError } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { redirectAfterLogin, safeNext } from "@/lib/safe-redirect";

export function LoginPage() {
  const { signIn } = useAuth();
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [totpRequired, setTotpRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Resume target for flows that bounce through /login — currently
  // the Cerner SMART EHR launch (api-server 303s unauthenticated
  // residents here with ?next=/api/auth/ehr/cerner/launch?...).
  // Validated once on mount; invalid values fall back to "/".
  const nextTarget = useMemo(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return safeNext(params.get("next"));
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!email.trim() || !password.trim()) {
      setError("Enter your email and password.");
      return;
    }
    if (totpRequired && !totpCode.trim()) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await signIn(
        email.trim(),
        password,
        totpRequired ? totpCode.trim() : undefined,
      );
      // If a validated resume target survived the safeNext gate, do
      // a full-page nav to it (required for /api/* targets like the
      // Cerner launch). Otherwise wouter SPA-nav to "/".
      redirectAfterLogin(nextTarget, () => navigate("/"));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        const code =
          err.data && typeof err.data === "object" && "error" in err.data
            ? (err.data as { error: unknown }).error
            : null;
        if (code === "totp_required") {
          setTotpRequired(true);
          setError(null);
          return;
        }
        if (code === "invalid_totp_code") {
          setError("That code didn't match. Try the next one.");
          return;
        }
        setError("Invalid email or password.");
      } else if (err instanceof ApiError && err.status === 429) {
        const retryAfter = err.headers.get("retry-after");
        const minutes = retryAfter
          ? Math.max(1, Math.ceil(Number(retryAfter) / 60))
          : null;
        setError(
          minutes
            ? `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`
            : "Too many sign-in attempts. Try again later.",
        );
      } else {
        setError(err instanceof Error ? err.message : "Sign-in failed.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">Sign in</CardTitle>
          <p className="text-sm text-(--color-muted-foreground)">
            Use your provider credentials to access HaloNote.
          </p>
        </CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@clinic.example"
                required
                disabled={submitting}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
                    setTotpCode(e.target.value.replace(/[^\d]/g, ""))
                  }
                  placeholder="123456"
                  required
                  autoFocus
                  disabled={submitting}
                />
                <p className="text-xs text-(--color-muted-foreground)">
                  Enter the 6-digit code from your authenticator app.
                </p>
              </div>
            ) : null}
            {error ? (
              <p className="text-sm text-(--color-destructive)">{error}</p>
            ) : null}
            <Button type="submit" size="lg" className="w-full" disabled={submitting}>
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
            <div className="flex items-center justify-between text-sm">
              <Link
                href="/forgot-password"
                className="text-(--color-muted-foreground) underline-offset-2 hover:text-(--color-foreground) hover:underline"
              >
                Forgot password?
              </Link>
              <Link
                href="/signup"
                className="font-medium text-(--color-foreground) underline-offset-2 hover:underline"
              >
                Create account
              </Link>
            </div>
            <p className="text-center text-xs text-(--color-muted-foreground)">
              Dev accounts: <code>alice@halonote.example</code> /{" "}
              <code>bob@halonote.example</code> · password{" "}
              <code>hunter2</code>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
