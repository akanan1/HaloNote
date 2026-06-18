# Business Associate Agreement

**Version:** 1.0
**Effective Date:** Upon acceptance by the Covered Entity

> **⚠ DRAFT — REQUIRES LEGAL REVIEW BEFORE PRODUCTION USE.**
> This document is a structural draft generated to wire up the
> acceptance infrastructure. The wording must be reviewed and
> approved by licensed counsel before any provider signs it for a
> real engagement. Replace this banner with the finalized text from
> your attorney, bump the version number to `2.0`, and let users
> re-accept on next sign-in.

---

This Business Associate Agreement ("BAA" or "Agreement") is entered
into between **HaloNote, Inc.** ("Business Associate") and the
healthcare provider or organization accepting this Agreement
("Covered Entity") to comply with the privacy and security
requirements of the Health Insurance Portability and Accountability
Act of 1996 ("HIPAA"), the Health Information Technology for
Economic and Clinical Health Act ("HITECH"), and their implementing
regulations at 45 C.F.R. Parts 160 and 164 (collectively, "HIPAA
Rules").

## 1. Definitions

Capitalized terms used but not defined in this Agreement have the
meanings given to them in the HIPAA Rules. The following terms have
the meanings set out below:

- **"Protected Health Information"** or **"PHI"** has the meaning
  given at 45 C.F.R. § 160.103, limited to information Business
  Associate creates, receives, maintains, or transmits on behalf of
  Covered Entity.
- **"Services"** means the AI-assisted clinical documentation
  service provided by Business Associate, including ambient audio
  capture, speech-to-text transcription, structured note generation,
  and electronic health record integration.
- **"Subcontractor"** means a third party that creates, receives,
  maintains, or transmits PHI on behalf of Business Associate in
  connection with the Services.

## 2. Permitted Uses and Disclosures of PHI

Business Associate may use and disclose PHI only as necessary to
perform the Services for, or on behalf of, Covered Entity, and as
otherwise permitted by this Agreement and the HIPAA Rules. Without
limiting the foregoing, Business Associate may use PHI for:

(a) the proper management and administration of Business Associate;
(b) carrying out its legal responsibilities;
(c) Data Aggregation services relating to the health care operations
    of Covered Entity, as permitted by 45 C.F.R. §
    164.504(e)(2)(i)(B); and
(d) creating de-identified information in accordance with 45 C.F.R.
    § 164.514(a)–(c), which is no longer PHI once de-identified.

Business Associate will not use or disclose PHI for marketing
purposes or sell PHI in violation of 45 C.F.R. §§ 164.501–502.

## 3. Safeguards

Business Associate will implement and maintain administrative,
physical, and technical safeguards that reasonably and appropriately
protect the confidentiality, integrity, and availability of PHI, in
accordance with 45 C.F.R. Part 164, Subparts C and E. Without
limiting the foregoing:

- PHI will be encrypted in transit using TLS 1.2 or higher.
- PHI will be encrypted at rest using AES-256 or an equivalent
  cryptographic standard.
- Access to PHI is restricted to personnel with a business need to
  know, enforced through role-based access control.
- All system access is logged in an immutable audit trail retained
  for a minimum of six (6) years.

## 4. Subcontractors

Business Associate will ensure that any Subcontractor that creates,
receives, maintains, or transmits PHI on behalf of Business
Associate agrees in writing to the same restrictions, conditions,
and requirements that apply to Business Associate under this
Agreement, in accordance with 45 C.F.R. § 164.504(e)(1)(ii).

Current Subcontractors that handle PHI in connection with the
Services include, without limitation:

- **Speech-to-text vendor** (Deepgram, Inc.) under signed BAA
- **Large language model vendor** (Anthropic PBC) under signed BAA
- **Cloud infrastructure provider** (e.g., AWS) under signed BAA
- **Database hosting** (Supabase, Inc.) under signed BAA

Business Associate will maintain a current list of Subcontractors
available to Covered Entity upon written request.

## 5. Reporting of Breaches and Security Incidents

Business Associate will report to Covered Entity:

(a) any **use or disclosure of PHI** not provided for by this
    Agreement of which Business Associate becomes aware,
(b) any **Security Incident** of which Business Associate becomes
    aware, and
(c) any **Breach of Unsecured PHI** as defined at 45 C.F.R. §
    164.402.

Reports under (a) and (c) will be made without unreasonable delay
and in no case later than thirty (30) calendar days after discovery.
Aggregate reports of unsuccessful Security Incidents (e.g., pings,
port scans, denied authentication attempts) may be made on a
quarterly basis.

## 6. Mitigation

Business Associate will mitigate, to the extent practicable, any
harmful effect of a use or disclosure of PHI by Business Associate
in violation of this Agreement.

## 7. Access, Amendment, and Accounting of Disclosures

Business Associate will, at the written request of Covered Entity
and within timeframes that allow Covered Entity to comply with 45
C.F.R. §§ 164.524, 164.526, and 164.528:

(a) make PHI in a Designated Record Set available to Covered Entity
    or, as directed, to an Individual;
(b) make PHI available for amendment and incorporate any amendments;
    and
(c) make available the information required for Covered Entity to
    provide an accounting of disclosures.

## 8. Internal Practices, Books, and Records

Business Associate will make its internal practices, books, and
records relating to the use and disclosure of PHI available to the
Secretary of the U.S. Department of Health and Human Services for
purposes of determining Covered Entity's compliance with the HIPAA
Rules.

## 9. Term and Termination

This Agreement is effective when accepted and continues until the
underlying service relationship ends and PHI is returned or
destroyed in accordance with this Section.

**Termination for Cause.** Covered Entity may terminate this
Agreement if Covered Entity determines that Business Associate has
violated a material term, and Business Associate has not cured the
breach within thirty (30) days after written notice.

**Return or Destruction.** Within sixty (60) days after termination,
Business Associate will return or destroy all PHI received from, or
created or received on behalf of, Covered Entity that Business
Associate maintains, and will retain no copies. If return or
destruction is infeasible, Business Associate will extend the
protections of this Agreement to the PHI and limit further uses to
those purposes that make return or destruction infeasible, for so
long as Business Associate maintains the PHI.

## 10. Miscellaneous

**Amendment.** The Parties agree to negotiate in good faith any
amendment required to bring this Agreement into compliance with
changes to the HIPAA Rules.

**Survival.** The rights and obligations of Business Associate
under Section 9 survive termination.

**No Third-Party Beneficiaries.** Nothing in this Agreement confers
any rights upon any person or entity other than the Parties and
their respective successors and permitted assigns.

**Interpretation.** Any ambiguity in this Agreement will be
resolved in favor of a meaning that permits the Parties to comply
with the HIPAA Rules.

---

**By accepting this Agreement, you represent that you are
authorized to bind the Covered Entity to its terms.**
