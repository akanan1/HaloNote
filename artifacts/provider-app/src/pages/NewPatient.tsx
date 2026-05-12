import { useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeft } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ApiError,
  createPatient,
  getListPatientsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function NewPatientPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [mrn, setMrn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const patient = await createPatient({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        dateOfBirth,
        mrn: mrn.trim(),
      });
      void queryClient.invalidateQueries({
        queryKey: getListPatientsQueryKey(),
      });
      toast.success(`${patient.lastName}, ${patient.firstName} added`);
      navigate(`/patients/${patient.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("A patient with this MRN already exists.");
      } else if (err instanceof ApiError && err.status === 400) {
        setError("Check the form values — one or more fields are invalid.");
      } else {
        setError(err instanceof Error ? err.message : "Couldn't save patient.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-(--color-muted-foreground) hover:text-(--color-foreground)"
        >
          <ArrowLeft className="h-4 w-4" />
          All patients
        </Link>
      </div>

      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Add patient</h1>
        <p className="text-(--color-muted-foreground)">
          Onboard a new patient into HaloNote.
        </p>
      </header>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Patient details</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={handleSubmit}>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="firstName">First name</Label>
                <Input
                  id="firstName"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  required
                  disabled={submitting}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">Last name</Label>
                <Input
                  id="lastName"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  required
                  disabled={submitting}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="dob">Date of birth</Label>
              <Input
                id="dob"
                type="date"
                value={dateOfBirth}
                onChange={(e) => setDateOfBirth(e.target.value)}
                required
                disabled={submitting}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="mrn">MRN</Label>
              <Input
                id="mrn"
                value={mrn}
                onChange={(e) => setMrn(e.target.value)}
                placeholder="MRN-12345"
                required
                disabled={submitting}
              />
            </div>
            {error ? (
              <p className="text-sm text-(--color-destructive)">{error}</p>
            ) : null}
            <div className="flex justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                size="lg"
                onClick={() => navigate("/")}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button type="submit" size="lg" disabled={submitting}>
                {submitting ? "Saving…" : "Save patient"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
