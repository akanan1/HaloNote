import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test-utils/render";

const createNoteMock = vi.fn();
const sendNoteMock = vi.fn();
const listPatientsMock = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useCreateNote: () => ({
    mutateAsync: createNoteMock,
    isPending: false,
    error: null,
  }),
  useSendNoteToEhr: () => ({
    mutateAsync: sendNoteMock,
    isPending: false,
    error: null,
  }),
  useListPatients: () => listPatientsMock(),
  getListNotesQueryKey: (params?: { patientId: string }) =>
    params ? ["/api/notes", params] : ["/api/notes"],
}));

import { NewNotePage } from "./NewNote";

const PATIENT = {
  id: "pt_001",
  firstName: "Marisol",
  lastName: "Aguirre",
  dateOfBirth: "1958-07-22",
  mrn: "MRN-10458",
};

describe("NewNotePage", () => {
  beforeEach(() => {
    createNoteMock.mockReset();
    sendNoteMock.mockReset();
    listPatientsMock.mockReset();
    listPatientsMock.mockReturnValue({
      data: { data: [PATIENT] },
      isPending: false,
      isError: false,
    });
  });

  it("renders the patient context in the header", () => {
    renderWithProviders(<NewNotePage patientId="pt_001" />, {
      initialPath: "/patients/pt_001/notes/new",
    });
    expect(screen.getByText(/aguirre, marisol/i)).toBeInTheDocument();
    expect(screen.getByText(/MRN-10458/)).toBeInTheDocument();
  });

  it("disables both buttons when the body is empty", () => {
    renderWithProviders(<NewNotePage patientId="pt_001" />);
    expect(
      screen.getByRole("button", { name: /save draft/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /save & send/i }),
    ).toBeDisabled();
  });

  it("Save draft creates the note and shows 'Draft saved.'", async () => {
    createNoteMock.mockResolvedValue({ id: "note_1" });
    const user = userEvent.setup();
    renderWithProviders(<NewNotePage patientId="pt_001" />);

    await user.type(screen.getByLabelText(/^note$/i), "subjective: chest pain");
    await user.click(screen.getByRole("button", { name: /save draft/i }));

    expect(createNoteMock).toHaveBeenCalledWith({
      data: { patientId: "pt_001", body: "subjective: chest pain" },
    });
    expect(await screen.findByText(/draft saved/i)).toBeInTheDocument();
  });

  it("Save & send drives the create → send pipeline and shows 'Sent to EHR (mock)'", async () => {
    createNoteMock.mockResolvedValue({ id: "note_1" });
    sendNoteMock.mockResolvedValue({
      provider: "mock",
      ehrDocumentRef: "DocumentReference/mock-note_1",
      pushedAt: "2026-05-12T07:00:00Z",
      mock: true,
    });
    const user = userEvent.setup();
    renderWithProviders(<NewNotePage patientId="pt_001" />);

    await user.type(screen.getByLabelText(/^note$/i), "plan: chest x-ray");
    await user.click(screen.getByRole("button", { name: /save & send/i }));

    await waitFor(() =>
      expect(sendNoteMock).toHaveBeenCalledWith({ id: "note_1" }),
    );
    expect(
      await screen.findByText(/sent to ehr \(mock — mock\)/i),
    ).toBeInTheDocument();
  });

  it("surfaces a send failure with the error message", async () => {
    createNoteMock.mockResolvedValue({ id: "note_1" });
    sendNoteMock.mockRejectedValue(new Error("FHIR 502 Bad Gateway"));
    const user = userEvent.setup();
    renderWithProviders(<NewNotePage patientId="pt_001" />);

    await user.type(screen.getByLabelText(/^note$/i), "x");
    await user.click(screen.getByRole("button", { name: /save & send/i }));

    expect(
      await screen.findByText(/FHIR 502 Bad Gateway/),
    ).toBeInTheDocument();
  });
});
