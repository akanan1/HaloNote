import { useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { ApiError, customFetch } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EhrConnectionSection } from "@/components/EhrConnectionSection";
import { AutoPushSection } from "@/components/AutoPushSection";
import { OrdersAutoPushSection } from "@/components/OrdersAutoPushSection";
import { SilenceAutoStopSection } from "@/components/SilenceAutoStopSection";
import { VerbalCuesSection } from "@/components/VerbalCuesSection";
import { TemplatesSection } from "@/components/TemplatesSection";
import { SmartPhrasesSection } from "@/components/SmartPhrasesSection";
import { PhraseMappingsSection } from "@/components/PhraseMappingsSection";
import { NoteDefaultsSection } from "@/components/NoteDefaultsSection";
import { LegalSection } from "@/components/LegalSection";

interface SetupResponse {
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
}

export function SettingsPage() {
  const { user, refresh } = useAuth();

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-(--color-muted-foreground) hover:text-(--color-foreground)"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to patients
        </Link>
      </div>

      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="text-(--color-muted-foreground)">
          {user?.email}
        </p>
      </header>

      <EhrConnectionSection />

      <AutoPushSection />

      <OrdersAutoPushSection />

      <SilenceAutoStopSection />

      <VerbalCuesSection />

      <TemplatesSection />

      <SmartPhrasesSection />

      <PhraseMappingsSection />

      <NoteDefaultsSection />

      <LegalSection />

      <TwoFactorSection
        initiallyEnabled={Boolean(user?.twoFactorEnabled)}
        onChange={async () => {
          // The enabled flag rides on /auth/me — refresh pulls it.
          await refresh();
        }}
      />
    </div>
  );
}

type TwoFactorState =
  | { phase: "idle" }
  | { phase: "setting-up"; setup: SetupResponse; code: string }
  | { phase: "enabled" }
  // Disable now requires both factors. We track them as separate
  // string fields and submit `{ password, totpCode }` to the API.
  | { phase: "disabling"; password: string; code: string };

function TwoFactorSection({
  initiallyEnabled,
  onChange,
}: {
  initiallyEnabled: boolean;
  onChange: () => Promise<void>;
}) {
  const [state, setState] = useState<TwoFactorState>(
    initiallyEnabled ? { phase: "enabled" } : { phase: "idle" },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startSetup() {
    setBusy(true);
    setError(null);
    try {
      const setup = await customFetch<SetupResponse>("/api/auth/2fa/setup", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setState({ phase: "setting-up", setup, code: "" });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Already enabled — flip UI to enabled state.
        setState({ phase: "enabled" });
      } else {
        setError(err instanceof Error ? err.message : "Couldn't start setup");
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup(code: string) {
    setBusy(true);
    setError(null);
    try {
      await customFetch("/api/auth/2fa/verify-setup", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      toast.success("Two-factor authentication enabled");
      setState({ phase: "enabled" });
      await onChange();
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError("That code didn't match. Try the next one.");
      } else {
        setError(err instanceof Error ? err.message : "Couldn't verify code");
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirmDisable(password: string, code: string) {
    setBusy(true);
    setError(null);
    try {
      // Backend contract is `{ password, totpCode }` — both factors
      // are required to flip 2FA off. A 401 on either failure means
      // "wrong password or wrong code" — we surface a single message
      // because the backend deliberately doesn't disambiguate (so an
      // attacker can't use the error to find out which half they got
      // right).
      await customFetch("/api/auth/2fa/disable", {
        method: "POST",
        body: JSON.stringify({ password, totpCode: code }),
      });
      toast.success("Two-factor authentication disabled");
      setState({ phase: "idle" });
      await onChange();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError("Password or code didn't match. Try again.");
      } else if (err instanceof ApiError && err.status === 429) {
        setError(
          "Too many attempts. Wait an hour and try again, or contact support.",
        );
      } else {
        setError(err instanceof Error ? err.message : "Couldn't disable");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-start gap-3">
        <ShieldCheck
          className="h-6 w-6 mt-0.5 text-(--color-muted-foreground)"
          aria-hidden="true"
        />
        <div className="flex-1">
          <h2 className="text-lg font-medium">Two-factor authentication</h2>
          <p className="text-sm text-(--color-muted-foreground)">
            Adds a 6-digit code from your authenticator app to every sign-in.
          </p>
        </div>
      </div>

      {state.phase === "idle" ? (
        <div className="space-y-2">
          <p className="text-sm text-(--color-muted-foreground)">
            Currently <strong>off</strong>.
          </p>
          <Button onClick={() => void startSetup()} disabled={busy}>
            {busy ? "Starting…" : "Set up"}
          </Button>
          {error ? (
            <p className="text-sm text-(--color-destructive)" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}

      {state.phase === "setting-up" ? (
        <div className="space-y-4">
          <p className="text-sm">
            Scan the QR code in your authenticator app, then enter the
            6-digit code it generates.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 items-start">
            <img
              src={state.setup.qrDataUrl}
              alt="TOTP QR code"
              className="h-44 w-44 rounded-md border border-(--color-border) p-2 bg-white"
            />
            <div className="space-y-1 text-xs">
              <p className="text-(--color-muted-foreground)">
                Can't scan? Manual entry secret:
              </p>
              <code className="block break-all rounded bg-(--color-muted) px-2 py-1">
                {state.setup.secret}
              </code>
            </div>
          </div>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void confirmSetup(state.code);
            }}
          >
            <Label htmlFor="setup-code">Verification code</Label>
            <Input
              id="setup-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              value={state.code}
              onChange={(e) =>
                setState({
                  ...state,
                  code: e.target.value.replace(/[^\d]/g, ""),
                })
              }
              placeholder="123456"
              required
              disabled={busy}
            />
            {error ? (
              <p className="text-sm text-(--color-destructive)" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex gap-2 pt-1">
              <Button type="submit" disabled={busy || state.code.length !== 6}>
                {busy ? "Verifying…" : "Confirm + enable"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setState({ phase: "idle" })}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
          </form>
        </div>
      ) : null}

      {state.phase === "enabled" ? (
        <div className="space-y-2">
          <p className="text-sm">
            Currently <strong>on</strong>. Sign-in will prompt for a code
            from your authenticator app.
          </p>
          <Button
            variant="outline"
            onClick={() =>
              setState({ phase: "disabling", password: "", code: "" })
            }
            disabled={busy}
          >
            Disable
          </Button>
        </div>
      ) : null}

      {state.phase === "disabling" ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void confirmDisable(state.password, state.code);
          }}
        >
          <p className="text-sm text-(--color-muted-foreground)">
            Confirm both your password and a current authenticator code
            to turn 2FA off. A stolen session alone isn't enough.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="disable-password">Password</Label>
            <Input
              id="disable-password"
              type="password"
              autoComplete="current-password"
              value={state.password}
              onChange={(e) =>
                setState({ ...state, password: e.target.value })
              }
              required
              autoFocus
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="disable-code">Verification code</Label>
            <Input
              id="disable-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              value={state.code}
              onChange={(e) =>
                setState({
                  ...state,
                  code: e.target.value.replace(/[^\d]/g, ""),
                })
              }
              placeholder="123456"
              required
              disabled={busy}
            />
          </div>
          {error ? (
            <p className="text-sm text-(--color-destructive)" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2 pt-1">
            <Button
              type="submit"
              variant="destructive"
              disabled={
                busy || state.password.length === 0 || state.code.length !== 6
              }
            >
              {busy ? "Disabling…" : "Disable 2FA"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setState({ phase: "enabled" })}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}
