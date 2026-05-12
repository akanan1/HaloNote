import { Route, Switch, Redirect } from "wouter";
import { useAuth } from "@/lib/auth";
import { AppLayout } from "@/components/AppLayout";
import { LoginPage } from "@/pages/Login";
import { PatientsPage } from "@/pages/Patients";
import { PatientDetailPage } from "@/pages/PatientDetail";
import { NewPatientPage } from "@/pages/NewPatient";
import { NewNotePage } from "@/pages/NewNote";
import { NotePage } from "@/pages/Note";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <SplashLoader />;
  if (!user) return <Redirect to="/login" />;
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
      <Switch>
        <Route path="/login" component={LoginPage} />
        <Route path="/">
          <RequireAuth>
            <PatientsPage />
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
        <Route>
          <Redirect to="/" />
        </Route>
      </Switch>
    </AppLayout>
  );
}
