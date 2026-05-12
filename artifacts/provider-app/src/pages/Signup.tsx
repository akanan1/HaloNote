import { useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { ApiError, signup } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SignupPage() {
  const { refresh } = useAuth();
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (password.length < 8) {
      setError("Pick a password with at least 8 characters.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await signup({
        email: email.trim(),
        password,
        displayName: displayName.trim(),
      });
      await refresh();
      navigate("/");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("An account with this email already exists. Try signing in.");
      } else if (err instanceof ApiError && err.status === 400) {
        setError("Check the form values — one or more fields are invalid.");
      } else {
        setError(err instanceof Error ? err.message : "Sign-up failed.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">Create your account</CardTitle>
          <p className="text-sm text-(--color-muted-foreground)">
            HaloNote uses your email to sign you in and recover your password.
          </p>
        </CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="signup-name">Full name</Label>
              <Input
                id="signup-name"
                autoComplete="name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Dr. Jamie Rivera"
                required
                disabled={submitting}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="signup-email">Email</Label>
              <Input
                id="signup-email"
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
              <Label htmlFor="signup-password">Password</Label>
              <Input
                id="signup-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                required
                disabled={submitting}
              />
            </div>
            {error ? (
              <p className="text-sm text-(--color-destructive)">{error}</p>
            ) : null}
            <Button type="submit" size="lg" className="w-full" disabled={submitting}>
              {submitting ? "Creating account…" : "Create account"}
            </Button>
            <p className="text-center text-sm text-(--color-muted-foreground)">
              Already have an account?{" "}
              <Link
                href="/login"
                className="font-medium text-(--color-foreground) underline-offset-2 hover:underline"
              >
                Sign in
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
