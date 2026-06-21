// One-time "Add to Home Screen" hint for iOS Safari.
//
// iOS Safari has no beforeinstallprompt event — the only way to make a
// site installable as a PWA is the Share → Add to Home Screen menu.
// Most users don't discover it on their own. This component shows a
// small dismissable banner on iOS Safari ONLY, the first time the user
// visits /m, with a one-line walkthrough.
//
// Hidden when:
//   - Not iOS Safari (Chrome/Android get the native install prompt via
//     the manifest; nothing to coach there)
//   - Already running as installed PWA (display-mode: standalone, or
//     navigator.standalone === true)
//   - Already dismissed (localStorage key persists across sessions)
//
// We deliberately don't try to detect "user has installed" — Safari
// gives us no signal until they re-launch from the home screen icon.
// Dismissal is good enough: the user explicitly said "I see, hide it."

import { useEffect, useState } from "react";
import { Share, X } from "lucide-react";
import { Button } from "@/components/ui/button";

const DISMISS_KEY = "halonote_ios_install_hint_dismissed";

function isIosSafari(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) && !("MSStream" in window);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return isIos && isSafari;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // Modern: matchMedia. iOS legacy: navigator.standalone.
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

export function IosInstallHint() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isIosSafari()) return;
    if (isStandalone()) return;
    try {
      if (window.localStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {
      // localStorage can throw in private-browsing on iOS (quota). If
      // it does, show the hint every visit — strictly worse for the
      // user but not broken.
    }
    setVisible(true);
  }, []);

  function dismiss() {
    setVisible(false);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // See above — silent failure on quota errors.
    }
  }

  if (!visible) return null;
  return (
    <div
      role="dialog"
      aria-label="Add HaloNote to your Home Screen"
      className="border-b border-(--color-border) bg-(--color-primary)/5 px-4 py-3 text-sm"
    >
      <div className="flex items-start gap-3">
        <Share
          className="mt-0.5 h-4 w-4 shrink-0 text-(--color-primary)"
          aria-hidden="true"
        />
        <div className="flex-1">
          <p>
            <span className="font-medium">Install HaloNote</span> — tap{" "}
            <span aria-label="Share button">Share</span> in Safari, then{" "}
            <span className="font-medium">Add to Home Screen</span> so the
            app opens full-screen.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={dismiss}
          aria-label="Dismiss install hint"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
