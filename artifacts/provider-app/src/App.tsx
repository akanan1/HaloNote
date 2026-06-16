import { lazy, Suspense } from "react";
import { Route, Switch, Redirect, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { AppLayout } from "@/components/AppLayout";

// Route-level code splitting. Named exports → default re-export so
// React.lazy can consume them. The login page is the first thing
// most users hit, so it's kept eager.
import { LoginPage } from "@/pages/Login";

const SignupPage = lazy(() =>
  import("@/pages/Signup").then((m) => ({ default: m.SignupPage })),
);
const ForgotPasswordPage = lazy(() =>
  import("@/pages/ForgotPassword").then((m) => ({
    default: m.ForgotPasswordPage,
  })),
);
const ResetPasswordPage = lazy(() =>
  import("@/pages/ResetPassword").then((m) => ({
    default: m.ResetPasswordPage,
  })),
);
const PatientsPage = lazy(() =>
  import("@/pages/Patients").then((m) => ({ default: m.PatientsPage })),
);
const PatientDetailPage = lazy(() =>
  import("@/pages/PatientDetail").then((m) => ({
    default: m.PatientDetailPage,
  })),
);
const NewPatientPage = lazy(() =>
  import("@/pages/NewPatient").then((m) => ({ default: m.NewPatientPage })),
);
const NewNotePage = lazy(() =>
  import("@/pages/NewNote").then((m) => ({ default: m.NewNotePage })),
);
const NotePage = lazy(() =>
  import("@/pages/Note").then((m) => ({ default: m.NotePage })),
);
const AuditLogPage = lazy(() =>
  import("@/pages/AuditLog").then((m) => ({ default: m.AuditLogPage })),
);
const AdminUsersPage = lazy(() =>
  import("@/pages/AdminUsers").then((m) => ({ default: m.AdminUsersPage })),
);
const SettingsPage = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.SettingsPage })),
);
const TodayPage = lazy(() =>
  import("@/pages/Today").then((m) => ({ default: m.TodayPage })),
);
const TasksPage = lazy(() =>
  import("@/pages/Tasks").then((m) => ({ default: m.TasksPage })),
);
const OnboardingPage = lazy(() =>
  import("@/pages/Onboarding").then((m) => ({ default: m.OnboardingPage })),
);
const FounderPage = lazy(() =>
  import("@/pages/Founder").then((m) => ({ default: m.FounderPage })),
);
const FounderUserDetailPage = lazy(() =>
  import("@/pages/FounderUserDetail").then((m) => ({
    default: m.FounderUserDetailPage,
  })),
);
const DevSandboxPage = lazy(() =>
  import("@/pages/DevSandbox").then((m) => ({ default: m.DevSandboxPage })),
);

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const [location] = useLocation();
  if (loading) return <SplashLoader />;
  if (!user) return <Redirect to="/login" />;
  // First-run gate: any authed user whose onboarding flag is still
  // false gets bounced to /onboarding, EXCEPT when they're already on
  // it (else infinite redirect). Backfill migration set every
  // existing user to "completed" so this only fires for new signups.
  if (!user.onboardingCompleted && location !== "/onboarding") {
    return <Redirect to="/onboarding" />;
  }
  return <>{children}</>;
}

function SplashLoader() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <p className="text-sm text-(--color-muted-foreground)">Loading…</p>
    </div>
  );
}

export default function App() {
  return (
    <AppLayout>
      <Suspense fallback={<SplashLoader />}>
        <Switch>
          <Route path="/login" component={LoginPage} />
          <Route path="/signup" component={SignupPage} />
          <Route path="/forgot-password" component={ForgotPasswordPage} />
          <Route path="/reset-password" component={ResetPasswordPage} />
          <Route path="/onboarding">
            <RequireAuth>
              <OnboardingPage />
            </RequireAuth>
          </Route>
          <Route path="/">
            <RequireAuth>
              <TodayPage />
            </RequireAuth>
          </Route>
          <Route path="/patients">
            <RequireAuth>
              <PatientsPage />
            </RequireAuth>
          </Route>
          <Route path="/tasks">
            <RequireAuth>
              <TasksPage />
            </RequireAuth>
          </Route>
          <Route path="/patients/new">
            <RequireAuth>
              <NewPatientPage />
            </RequireAuth>
          </Route>
          <Route path="/patients/:id/notes/new">
            {(params) => (
              <RequireAuth>
                <NewNotePage patientId={params.id} />
              </RequireAuth>
            )}
          </Route>
          <Route path="/patients/:id/notes/:noteId">
            {(params) => (
              <RequireAuth>
                <NotePage patientId={params.id} noteId={params.noteId} />
              </RequireAuth>
            )}
          </Route>
          <Route path="/patients/:id">
            {(params) => (
              <RequireAuth>
                <PatientDetailPage patientId={params.id} />
              </RequireAuth>
            )}
          </Route>
          <Route path="/audit-log">
            <RequireAuth>
              <AuditLogPage />
            </RequireAuth>
          </Route>
          <Route path="/admin/users">
            <RequireAuth>
              <AdminUsersPage />
            </RequireAuth>
          </Route>
          <Route path="/settings">
            <RequireAuth>
              <SettingsPage />
            </RequireAuth>
          </Route>
          <Route path="/founder">
            <RequireAuth>
              <FounderPage />
            </RequireAuth>
          </Route>
          <Route path="/founder/users/:id">
            {(params) => (
              <RequireAuth>
                <FounderUserDetailPage userId={params.id} />
              </RequireAuth>
            )}
          </Route>
          <Route path="/dev/sandbox">
            <RequireAuth>
              <DevSandboxPage />
            </RequireAuth>
          </Route>
          <Route>
            <Redirect to="/" />
          </Route>
        </Switch>
      </Suspense>
    </AppLayout>
  );
}
