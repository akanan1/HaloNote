import { Link, useLocation } from "wouter";
import {
  Calendar,
  ContactRound,
  LogOut,
  ScrollText,
  Settings as SettingsIcon,
  Users,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";

interface AppLayoutProps {
  children: React.ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const { user, signOut } = useAuth();
  const [, navigate] = useLocation();

  async function handleSignOut() {
    await signOut();
    navigate("/login");
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Skip link — visible only on focus, lets keyboard users bypass the
          header nav and jump straight to the page content. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-(--color-primary) focus:px-3 focus:py-2 focus:text-(--color-primary-foreground)"
      >
        Skip to main content
      </a>
      <header
        className="border-b border-(--color-border) bg-(--color-card) print:hidden"
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
            <nav
              className="flex items-center gap-2 text-sm"
              aria-label="Primary"
            >
              <Link href="/">
                <Button variant="ghost" size="sm">
                  <Calendar className="h-4 w-4" aria-hidden="true" />
                  <span className="hidden sm:inline">Today</span>
                </Button>
              </Link>
              <Link href="/patients">
                <Button variant="ghost" size="sm">
                  <ContactRound className="h-4 w-4" aria-hidden="true" />
                  <span className="hidden sm:inline">Patients</span>
                </Button>
              </Link>
              {user.role === "admin" ? (
                <>
                  <Link href="/admin/users">
                    <Button variant="ghost" size="sm">
                      <Users className="h-4 w-4" aria-hidden="true" />
                      <span className="hidden sm:inline">Users</span>
                    </Button>
                  </Link>
                  <Link href="/audit-log">
                    <Button variant="ghost" size="sm">
                      <ScrollText className="h-4 w-4" aria-hidden="true" />
                      <span className="hidden sm:inline">Audit log</span>
                    </Button>
                  </Link>
                </>
              ) : null}
              <span className="hidden text-(--color-muted-foreground) sm:inline">
                {user.displayName}
              </span>
              <Link href="/settings">
                <Button variant="ghost" size="sm" aria-label="Settings">
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
          ) : null}
        </div>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-5xl flex-1 px-6 py-10 focus:outline-none"
      >
        {children}
      </main>
    </div>
  );
}
