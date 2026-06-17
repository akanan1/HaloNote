import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";

const listPatientsMock = vi.fn();
const listNotesMock = vi.fn();

// Partial mock so value-level exports the page tree depends on
// (notably the `VisitType` enum used by PatientEncountersSection)
// flow through from the real generated module. Stub only the hooks
// this test touches; the encounters hooks are stubbed too so the
// component renders its empty state instead of attempting a fetch.
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useListPatients: () => listPatientsMock(),
    useListNotes: (params: { patientId: string }) => listNotesMock(params),
    useListEncounters: () => ({
      data: { data: [] },
      isPending: false,
      isError: false,
    }),
    useCreateEncounter: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
      error: null,
    }),
  };
});

import { PatientDetailPage } from "./PatientDetail";

const PATIENT = {
  id: "pt_001",
  firstName: "Marisol",
  lastName: "Aguirre",
  dateOfBirth: "1958-07-22",
  mrn: "MRN-10458",
};

function note(overrides: Record<string, unknown> = {}) {
  return {
    id: "note_a",
    patientId: "pt_001",
    body: "Note body goes here. Plan: follow up next week.",
    createdAt: "2026-05-12T07:00:00.000Z",
    author: null,
    ehrProvider: null,
    ehrDocumentRef: null,
    ehrPushedAt: null,
    ehrError: null,
    ...overrides,
  };
}

describe("PatientDetailPage", () => {
  beforeEach(() => {
    listPatientsMock.mockReset();
    listNotesMock.mockReset();
    listPatientsMock.mockReturnValue({
      data: { data: [PATIENT] },
      isPending: false,
      isError: false,
    });
  });

  it("renders the patient header with name, age, and MRN", () => {
    listNotesMock.mockReturnValue({
      data: { data: [] },
      isPending: false,
      isError: false,
    });

    renderWithProviders(<PatientDetailPage patientId="pt_001" />, {
      initialPath: "/patients/pt_001",
    });

    expect(
      screen.getByRole("heading", { name: /aguirre, marisol/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/MRN-10458/)).toBeInTheDocument();
  });

  it("shows an empty state when the patient has no notes", () => {
    listNotesMock.mockReturnValue({
      data: { data: [] },
      isPending: false,
      isError: false,
    });

    renderWithProviders(<PatientDetailPage patientId="pt_001" />, {
      initialPath: "/patients/pt_001",
    });

    expect(screen.getByText(/no notes for this patient yet/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /write the first one/i }),
    ).toBeInTheDocument();
  });

  it("renders an EHR pill per note reflecting its push status", () => {
    listNotesMock.mockReturnValue({
      data: {
        data: [
          note({ id: "sent", ehrProvider: "mock", ehrDocumentRef: "DocumentReference/x", ehrPushedAt: "2026-05-12T07:30:00Z" }),
          note({ id: "failed", ehrError: "401 access_denied" }),
          note({ id: "draft" }),
        ],
      },
      isPending: false,
      isError: false,
    });

    renderWithProviders(<PatientDetailPage patientId="pt_001" />, {
      initialPath: "/patients/pt_001",
    });

    expect(screen.getByText(/sent · mock/i)).toBeInTheDocument();
    expect(screen.getByText(/send failed/i)).toBeInTheDocument();
    expect(screen.getByText(/^draft$/i)).toBeInTheDocument();
  });

  it("displays an error message when the notes query fails", () => {
    listNotesMock.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: new Error("backend unreachable"),
    });

    renderWithProviders(<PatientDetailPage patientId="pt_001" />, {
      initialPath: "/patients/pt_001",
    });

    expect(screen.getByText(/couldn't load notes/i)).toBeInTheDocument();
    expect(screen.getByText(/backend unreachable/i)).toBeInTheDocument();
  });
});
