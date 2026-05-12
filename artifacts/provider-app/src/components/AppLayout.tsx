import { Link, useLocation } from "wouter";
import { LogOut } from "lucide-react";
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
      <header className="border-b border-(--color-border) bg-(--color-card)">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
          <Link
            href="/"
            className="text-xl font-semibold tracking-tight text-(--color-foreground)"
          >
            HaloNote
          </Link>
          {user ? (
            <div className="flex items-center gap-4 text-sm">
              <span className="text-(--color-muted-foreground)">
                {user.displayName}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleSignOut()}
                aria-label="Sign out"
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </Button>
            </div>
          ) : null}
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
        {children}
      </main>
    </div>
  );
}
