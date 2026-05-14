import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Calendar,
  ContactRound,
  LogOut,
  Menu,
  ScrollText,
  Settings as SettingsIcon,
  Users,
  X,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";

interface AppLayoutProps {
  children: React.ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const { user, signOut } = useAuth();
  const [location, navigate] = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);

  // Close the More sheet on any route change so a quick swipe-to-route
  // through it doesn't leave the backdrop hanging.
  useEffect(() => {
    setMoreOpen(false);
  }, [location]);

  async function handleSignOut() {
    setMoreOpen(false);
    await signOut();
    navigate("/login");
  }

  const isAdmin = user?.role === "admin";
  const isTodayActive = location === "/";
  // /patients, /patients/new, /patients/:id, /patients/:id/notes/* all
  // belong to the Patients tab on mobile.
  const isPatientsActive = location.startsWith("/patients");
  const isSettingsActive = location === "/settings";
  const isUsersActive = location === "/admin/users";
  const isAuditActive = location === "/audit-log";

  return (
    <div className="flex min-h-screen flex-col">
      {/* Skip link — visible only on focus, lets keyboard users bypass the
          header nav and jump straight to the page content. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-(--color-primary) focus:px-3 focus:py-2 focus:text-(--color-primary-foreground)"
      >
        Skip to main content
      </a>

      {/* Header. `pt-[env(safe-area-inset-top)]` pads under the iOS
          notch/dynamic island so the header doesn't crash into the
          status bar on a real phone. Desktop layout (md+) keeps the
          original inline nav; mobile shows just logo + user initials
          and moves nav to a bottom tab bar. */}
      <header
        className="border-b border-(--color-border) bg-(--color-card) pt-[env(safe-area-inset-top)] print:hidden"
        role="banner"
      >
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
          <Link
            href="/"
            className="text-xl font-semibold tracking-tight text-(--color-foreground)"
          >
            HaloNote
          </Link>
          {user ? (
            <>
              <nav
                className="hidden items-center gap-2 text-sm md:flex"
                aria-label="Primary"
              >
                <TopNavLink
                  href="/"
                  active={isTodayActive}
                  icon={Calendar}
                  label="Today"
                />
                <TopNavLink
                  href="/patients"
                  active={isPatientsActive}
                  icon={ContactRound}
                  label="Patients"
                />
                {isAdmin ? (
                  <>
                    <TopNavLink
                      href="/admin/users"
                      active={isUsersActive}
                      icon={Users}
                      label="Users"
                    />
                    <TopNavLink
                      href="/audit-log"
                      active={isAuditActive}
                      icon={ScrollText}
                      label="Audit log"
                    />
                  </>
                ) : null}
                <span className="text-(--color-muted-foreground)">
                  {user.displayName}
                </span>
                <Link href="/settings">
                  <Button
                    variant={isSettingsActive ? "outline" : "ghost"}
                    size="sm"
                    aria-label="Settings"
                    aria-current={isSettingsActive ? "page" : undefined}
                  >
                    <SettingsIcon className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </Link>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleSignOut()}
                  aria-label="Sign out"
                >
                  <LogOut className="h-4 w-4" aria-hidden="true" />
                  Sign out
                </Button>
              </nav>
              <div className="flex items-center md:hidden">
                <span
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-(--color-muted) text-sm font-medium text-(--color-muted-foreground)"
                  aria-label={`Signed in as ${user.displayName}`}
                >
                  {(user.displayName || "?").slice(0, 1).toUpperCase()}
                </span>
              </div>
            </>
          ) : null}
        </div>
      </header>

      <main
        id="main-content"
        tabIndex={-1}
        className={`mx-auto w-full max-w-5xl flex-1 px-6 py-10 focus:outline-none ${
          user
            ? // Reserve space for the bottom tab bar on mobile so content
              // isn't hidden behind it. Desktop has no bottom nav, so keep
              // the original py-10 there.
              "pb-[calc(env(safe-area-inset-bottom)+5rem)] md:pb-10"
            : ""
        }`}
      >
        {children}
      </main>

      {user ? (
        <>
          {/* Bottom tab bar. Visible only on mobile (< md). Four slots:
              Today / Patients / Settings / More. Admin items + Sign out
              live behind "More" so the primary surface stays clean and
              the destructive action (Sign out) needs an extra tap. */}
          <nav
            className="fixed inset-x-0 bottom-0 z-40 border-t border-(--color-border) bg-(--color-card) pb-[env(safe-area-inset-bottom)] md:hidden print:hidden"
            aria-label="Primary mobile"
          >
            <div className="mx-auto flex max-w-md items-stretch justify-around">
              <BottomNavLink
                href="/"
                active={isTodayActive}
                icon={Calendar}
                label="Today"
              />
              <BottomNavLink
                href="/patients"
                active={isPatientsActive}
                icon={ContactRound}
                label="Patients"
              />
              <BottomNavLink
                href="/settings"
                active={isSettingsActive}
                icon={SettingsIcon}
                label="Settings"
              />
              <button
                type="button"
                onClick={() => setMoreOpen(true)}
                aria-haspopup="dialog"
                aria-expanded={moreOpen}
                aria-label="More options"
                className="flex min-h-[3.5rem] flex-1 flex-col items-center justify-center gap-0.5 text-xs text-(--color-muted-foreground)"
              >
                <Menu className="h-5 w-5" aria-hidden="true" />
                More
              </button>
            </div>
          </nav>

          {moreOpen ? (
            <MoreSheet
              onClose={() => setMoreOpen(false)}
              isAdmin={isAdmin}
              displayName={user.displayName}
              isUsersActive={isUsersActive}
              isAuditActive={isAuditActive}
              onSignOut={() => void handleSignOut()}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function TopNavLink({
  href,
  active,
  icon: Icon,
  label,
}: {
  href: string;
  active: boolean;
  icon: React.ElementType;
  label: string;
}) {
  return (
    <Link href={href}>
      <Button
        variant={active ? "outline" : "ghost"}
        size="sm"
        aria-current={active ? "page" : undefined}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
        <span className="hidden sm:inline">{label}</span>
      </Button>
    </Link>
  );
}

function BottomNavLink({
  href,
  active,
  icon: Icon,
  label,
}: {
  href: string;
  active: boolean;
  icon: React.ElementType;
  label: string;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-[3.5rem] flex-1 flex-col items-center justify-center gap-0.5 text-xs ${
        active
          ? "text-(--color-foreground) font-medium"
          : "text-(--color-muted-foreground)"
      }`}
    >
      <Icon
        className={`h-5 w-5 ${active ? "stroke-[2.25]" : ""}`}
        aria-hidden="true"
      />
      {label}
    </Link>
  );
}

interface MoreSheetProps {
  onClose: () => void;
  isAdmin: boolean;
  displayName: string;
  isUsersActive: boolean;
  isAuditActive: boolean;
  onSignOut: () => void;
}

function MoreSheet({
  onClose,
  isAdmin,
  displayName,
  isUsersActive,
  isAuditActive,
  onSignOut,
}: MoreSheetProps) {
  // Close on Escape — modal dialogs should always honor it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="More options"
      className="fixed inset-0 z-50 md:hidden"
    >
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-(--color-card) pt-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] shadow-2xl">
        <div className="mx-auto max-w-md space-y-1 px-3">
          <div className="flex items-center justify-between px-2 pb-2">
            <span className="text-sm text-(--color-muted-foreground)">
              {displayName}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              aria-label="Close menu"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          {isAdmin ? (
            <>
              <MoreSheetLink
                href="/admin/users"
                active={isUsersActive}
                icon={Users}
                label="Users"
              />
              <MoreSheetLink
                href="/audit-log"
                active={isAuditActive}
                icon={ScrollText}
                label="Audit log"
              />
            </>
          ) : null}
          <button
            type="button"
            onClick={onSignOut}
            className="flex min-h-[3rem] w-full items-center gap-3 rounded-md px-3 text-(--color-destructive) hover:bg-(--color-muted) active:bg-(--color-muted)"
          >
            <LogOut className="h-5 w-5" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function MoreSheetLink({
  href,
  active,
  icon: Icon,
  label,
}: {
  href: string;
  active: boolean;
  icon: React.ElementType;
  label: string;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-[3rem] items-center gap-3 rounded-md px-3 hover:bg-(--color-muted) active:bg-(--color-muted) ${
        active ? "bg-(--color-muted)" : ""
      }`}
    >
      <Icon className="h-5 w-5" aria-hidden="true" />
      {label}
    </Link>
  );
}
