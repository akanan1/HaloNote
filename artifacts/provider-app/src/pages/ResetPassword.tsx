import { useMemo, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import {
  ApiError,
  confirmPasswordReset,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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

  if (!token) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
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
    setError(null);
    setSubmitting(true);
    try {
      await confirmPasswordReset({ token, password });
      await refresh();
      navigate("/");
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError(
          "This reset link is invalid or has expired. Request a new one.",
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
    <div className="flex min-h-[70vh] items-center justify-center">
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
