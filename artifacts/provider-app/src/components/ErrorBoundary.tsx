import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { captureError } from "@/lib/sentry";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    captureError(error, { componentStack: info.componentStack });
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  private reload = (): void => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="max-w-md space-y-5 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Something went wrong
          </h1>
          <p className="text-(--color-muted-foreground)">
            An unexpected error broke the page. Reload to recover. If it keeps
            happening, let your administrator know.
          </p>
          <pre className="overflow-auto rounded-md bg-(--color-muted) px-3 py-2 text-left text-xs text-(--color-muted-foreground)">
            {this.state.error.message}
          </pre>
          <div className="flex justify-center gap-3">
            <Button variant="outline" onClick={this.reset}>
              Try again
            </Button>
            <Button onClick={this.reload}>Reload</Button>
          </div>
        </div>
      </div>
    );
  }
}
