import { describe, expect, it } from "vitest";
import pino from "pino";
import { _REDACT_PATHS_FOR_TESTS } from "./logger";

// Build a fresh logger with the same redaction policy as the production
// logger but writing into an in-memory buffer so we can JSON.parse the
// emitted entries.
function captureLogger(): { log: pino.Logger; entries: () => unknown[] } {
  const lines: string[] = [];
  const stream = {
    write(chunk: string) {
      lines.push(chunk);
    },
  };
  const log = pino(
    {
      level: "trace",
      redact: {
        paths: [..._REDACT_PATHS_FOR_TESTS],
        censor: "[redacted]",
      },
    },
    stream as unknown as NodeJS.WritableStream,
  );
  return {
    log,
    entries: () => lines.map((l) => JSON.parse(l) as unknown),
  };
}

describe("logger redaction", () => {
  it("redacts authorization, cookie, set-cookie headers", () => {
    const { log, entries } = captureLogger();
    log.info(
      {
        req: {
          headers: {
            authorization: "Bearer secret-token",
            cookie: "halonote_session=abc",
            "user-agent": "vitest",
          },
        },
        res: { headers: { "set-cookie": ["halonote_session=xyz"] } },
      },
      "request completed",
    );
    const e = entries()[0] as {
      req: { headers: Record<string, unknown> };
      res: { headers: Record<string, unknown> };
    };
    expect(e.req.headers["authorization"]).toBe("[redacted]");
    expect(e.req.headers["cookie"]).toBe("[redacted]");
    expect(e.req.headers["user-agent"]).toBe("vitest"); // not redacted
    expect(e.res.headers["set-cookie"]).toBe("[redacted]");
  });

  it("redacts password + token fields anywhere they appear", () => {
    const { log, entries } = captureLogger();
    log.info({
      user: { id: "usr_1", email: "x@y", password: "hunter2" },
      session: { token: "tok-abc", tokenHash: "deadbeef" },
    });
    const e = entries()[0] as {
      user: { password: string; email: string };
      session: { token: string; tokenHash: string };
    };
    expect(e.user.password).toBe("[redacted]");
    // Email used to be preserved here as a non-sensitive example.
    // Tightened: email is a HIPAA direct identifier (45 CFR 164.514)
    // and is now redacted everywhere; operational signal should use
    // userId instead. See dedicated test below for the full coverage.
    expect(e.user.email).toBe("[redacted]");
    expect(e.session.token).toBe("[redacted]");
    expect(e.session.tokenHash).toBe("[redacted]");
  });

  it("redacts a FHIR DocumentReference body and patient-identifying description", () => {
    const { log, entries } = captureLogger();
    log.info(
      {
        docRef: {
          patient: "Patient/pt_001",
          content: { text: "SOAP — pt complains of chest pain", base64: "U09BUA==" },
          description: "Aguirre, Marisol — note note_xyz",
        },
        syntheticId: "mock-note_xyz",
      },
      "EHR push (mock)",
    );
    const e = entries()[0] as {
      docRef: {
        patient: string;
        content: { text: string; base64: string };
        description: string;
      };
      syntheticId: string;
    };
    expect(e.docRef.content.text).toBe("[redacted]");
    expect(e.docRef.content.base64).toBe("[redacted]");
    expect(e.docRef.description).toBe("[redacted]");
    // Non-sensitive fields stay intact.
    expect(e.docRef.patient).toBe("Patient/pt_001");
    expect(e.syntheticId).toBe("mock-note_xyz");
  });

  it("redacts FhirError rawBody + outcome when an error object is logged", () => {
    const { log, entries } = captureLogger();
    log.error(
      {
        err: {
          name: "FhirError",
          message: "FHIR PUT failed",
          status: 422,
          rawBody:
            '<OperationOutcome>Patient Marisol Aguirre MRN-10458 missing identifier</OperationOutcome>',
          outcome: {
            resourceType: "OperationOutcome",
            issue: [
              {
                severity: "error",
                code: "required",
                diagnostics: "Patient pt_001 missing identifier",
              },
            ],
          },
        },
        noteId: "note_xyz",
      },
      "EHR push failed",
    );
    const e = entries()[0] as {
      err: { rawBody: string; outcome: unknown; message: string; status: number };
      noteId: string;
    };
    expect(e.err.rawBody).toBe("[redacted]");
    expect(e.err.outcome).toBe("[redacted]");
    expect(e.err.message).toBe("FHIR PUT failed"); // class / status kept
    expect(e.err.status).toBe(422);
    expect(e.noteId).toBe("note_xyz"); // not PHI
  });

  it("redacts a patient-identifying record (mrn, names, dob)", () => {
    const { log, entries } = captureLogger();
    log.info({
      patient: {
        id: "pt_001",
        firstName: "Marisol",
        lastName: "Aguirre",
        dateOfBirth: "1958-07-22",
        mrn: "MRN-10458",
      },
    });
    const e = entries()[0] as {
      patient: Record<string, unknown>;
    };
    expect(e.patient["id"]).toBe("pt_001"); // opaque id is fine
    expect(e.patient["firstName"]).toBe("[redacted]");
    expect(e.patient["lastName"]).toBe("[redacted]");
    expect(e.patient["dateOfBirth"]).toBe("[redacted]");
    expect(e.patient["mrn"]).toBe("[redacted]");
  });

  it("redacts OAuth credentials that may end up in error envelopes", () => {
    const { log, entries } = captureLogger();
    log.error({
      err: {
        message: "token request failed",
        client_secret: "shhh",
        client_assertion: "long.jwt.value",
        access_token: "leaked",
        refresh_token: "also leaked",
      },
    });
    const e = entries()[0] as { err: Record<string, unknown> };
    expect(e.err["client_secret"]).toBe("[redacted]");
    expect(e.err["client_assertion"]).toBe("[redacted]");
    expect(e.err["access_token"]).toBe("[redacted]");
    expect(e.err["refresh_token"]).toBe("[redacted]");
    expect(e.err["message"]).toBe("token request failed");
  });

  it("redacts a request body (route handlers occasionally log {req})", () => {
    const { log, entries } = captureLogger();
    log.info({
      req: {
        method: "POST",
        url: "/api/notes",
        body: { patientId: "pt_001", body: "PHI clinical note" },
      },
    });
    const e = entries()[0] as { req: { body: unknown; method: string } };
    expect(e.req.body).toBe("[redacted]");
    expect(e.req.method).toBe("POST");
  });

  it("redacts HIPAA direct identifiers (email, phone, ssn) wherever they appear", () => {
    const { log, entries } = captureLogger();
    log.info({
      patient: {
        id: "pt_001",
        email: "marisol@example.com",
        phone: "+1-555-0100",
        phoneNumber: "+15550101",
        ssn: "123-45-6789",
      },
      // Top-level forms too — exercises both `*.email` and bare `email`.
      email: "admin@halonote.example",
    });
    const e = entries()[0] as {
      patient: Record<string, unknown>;
      email: string;
    };
    expect(e.patient["id"]).toBe("pt_001"); // opaque id preserved
    expect(e.patient["email"]).toBe("[redacted]");
    expect(e.patient["phone"]).toBe("[redacted]");
    expect(e.patient["phoneNumber"]).toBe("[redacted]");
    expect(e.patient["ssn"]).toBe("[redacted]");
    expect(e.email).toBe("[redacted]");
  });

  it("redacts FHIR Patient response shape (given/family/birthDate/identifier)", () => {
    const { log, entries } = captureLogger();
    log.info({
      // Shape modeled after what FhirClient.read<Patient>() would yield.
      patient: {
        resourceType: "Patient",
        id: "pt_001",
        name: [{ given: ["Marisol"], family: "Aguirre" }],
        birthDate: "1958-07-22",
        identifier: [
          { system: "MR", value: "MRN-10458" },
          { system: "SSN", value: "123-45-6789" },
        ],
      },
    });
    const e = entries()[0] as {
      patient: {
        resourceType: string;
        id: string;
        name: Array<Record<string, unknown>>;
        birthDate: string;
        identifier: unknown;
      };
    };
    expect(e.patient.resourceType).toBe("Patient"); // operational, preserved
    expect(e.patient.id).toBe("pt_001"); // opaque id preserved
    expect(e.patient.birthDate).toBe("[redacted]");
    expect(e.patient.identifier).toBe("[redacted]");
    // fast-redact reaches given/family inside HumanName via the `*.given`
    // / `*.family` wildcard rules (one level of nesting from `name[0]`).
    const name0 = e.patient.name[0]!;
    expect(name0["given"]).toBe("[redacted]");
    expect(name0["family"]).toBe("[redacted]");
  });

  it("redacts OAuth state-machine secrets (code_verifier, id_token, assertion)", () => {
    const { log, entries } = captureLogger();
    // Shape modeled after an OAuth state row + token-endpoint response
    // intermediate that a debug log might accidentally drop.
    log.warn({
      state: {
        state: "sTaTe-OpAqUe",  // CSRF-ish nonce, not redacted
        code_verifier: "long-pkce-verifier",
        provider: "athenahealth",
      },
      tokenResponse: {
        access_token: "leaked-AT",
        refresh_token: "leaked-RT",
        id_token: "eyJ-jwt-header.eyJ-jwt-claims.signature-bytes",
      },
      jwtBearer: {
        assertion: "eyJ-jwt-header.eyJ-jwt-claims.signature-bytes",
      },
    });
    const e = entries()[0] as {
      state: Record<string, unknown>;
      tokenResponse: Record<string, unknown>;
      jwtBearer: Record<string, unknown>;
    };
    expect(e.state["code_verifier"]).toBe("[redacted]");
    expect(e.state["state"]).toBe("sTaTe-OpAqUe"); // identifier kept
    expect(e.state["provider"]).toBe("athenahealth"); // operational
    expect(e.tokenResponse["access_token"]).toBe("[redacted]");
    expect(e.tokenResponse["refresh_token"]).toBe("[redacted]");
    expect(e.tokenResponse["id_token"]).toBe("[redacted]");
    expect(e.jwtBearer["assertion"]).toBe("[redacted]");
  });

  it("redacts clinical content channels (transcript, noteBody, noteText, soap)", () => {
    const { log, entries } = captureLogger();
    log.debug({
      pipeline: {
        stage: "structuring",
        transcript: "Patient reports chest pain radiating to left arm...",
        noteBody: "S: 58yo F with hx of HTN presents with CP.",
        noteText: "Subjective: chest pain since 0600...",
        soap: {
          subjective: "CP since 0600",
          objective: "BP 156/94",
          assessment: "rule out ACS",
          plan: "ECG, trop x3, ASA 325",
        },
      },
      noteId: "note_xyz", // opaque, preserved
    });
    const e = entries()[0] as {
      pipeline: Record<string, unknown>;
      noteId: string;
    };
    expect(e.pipeline["stage"]).toBe("structuring"); // operational
    expect(e.pipeline["transcript"]).toBe("[redacted]");
    expect(e.pipeline["noteBody"]).toBe("[redacted]");
    expect(e.pipeline["noteText"]).toBe("[redacted]");
    expect(e.pipeline["soap"]).toBe("[redacted]");
    expect(e.noteId).toBe("note_xyz");
  });
});
