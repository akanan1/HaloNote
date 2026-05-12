import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { requestPasswordReset } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // The endpoint always returns 204 (no user enumeration). We just
      // need to confirm the request was made.
      await requestPasswordReset({ email: email.trim() });
      setSubmitted(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't send the reset email.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">Reset your password</CardTitle>
          <p className="text-sm text-(--color-muted-foreground)">
            We'll email you a link to set a new one.
          </p>
        </CardHeader>
        <CardContent>
          {submitted ? (
            <div className="space-y-4">
              <p>
                If an account exists for{" "}
                <span className="font-medium">{email.trim()}</span>, a reset
                link is on its way. Check your inbox.
              </p>
              <p className="text-sm text-(--color-muted-foreground)">
                The link expires in 1 hour. You can request another if needed.
              </p>
              <Link href="/login">
                <Button variant="outline" className="w-full">
                  Back to sign in
                </Button>
              </Link>
            </div>
          ) : (
            <form className="space-y-5" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <Label htmlFor="forgot-email">Email</Label>
                <Input
                  id="forgot-email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@clinic.example"
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
                {submitting ? "Sending…" : "Send reset link"}
              </Button>
              <p className="text-center text-sm text-(--color-muted-foreground)">
                Remembered it?{" "}
                <Link
                  href="/login"
                  className="font-medium text-(--color-foreground) underline-offset-2 hover:underline"
                >
                  Sign in
                </Link>
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
