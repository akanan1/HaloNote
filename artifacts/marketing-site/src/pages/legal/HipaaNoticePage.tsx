import MarketingLayout from "@/components/marketing/MarketingLayout";
import { Link } from "wouter";
import { ShieldCheck } from "lucide-react";

export default function HipaaNoticePage() {
  return (
    <MarketingLayout>
      <div className="max-w-4xl mx-auto px-5 sm:px-8 lg:px-10 py-20 md:py-28">
        <div className="mb-12">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-emerald-50 border border-emerald-100 mb-6">
            <ShieldCheck className="w-6 h-6 text-emerald-600" />
          </div>
          <h1 className="text-4xl font-bold text-[#1a1a2e] tracking-tight mb-2">HIPAA Notice of Privacy Practices</h1>
          <p className="text-gray-500 text-[15px]">
            <strong>Effective Date:</strong> March 19, 2026 &nbsp;·&nbsp;
            <strong>Last Updated:</strong> March 19, 2026
          </p>
          <div className="mt-4 p-4 bg-blue-50 border border-blue-100 rounded-xl text-[14px] text-blue-800">
            <strong>This notice describes how Protected Health Information (PHI) about you may be used and disclosed and how you can get access to this information. Please review it carefully.</strong>
          </div>
        </div>

        <div className="prose prose-gray max-w-none space-y-8 text-[15px] leading-relaxed text-gray-700">

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">Our Legal Duty</h2>
            <p>
              Halo Note is a Business Associate under HIPAA that processes Protected Health Information (PHI) on behalf of covered healthcare entities. We are required by law to maintain the privacy of PHI, provide individuals with notice of our legal duties and privacy practices, and notify affected individuals following a breach of unsecured PHI.
            </p>
            <p className="mt-3">We are required to abide by the terms of this Notice currently in effect.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">How We May Use and Disclose PHI</h2>
            <p>We process PHI only as directed by and on behalf of covered entities (your healthcare provider or organization). The following describes the ways PHI may be used and disclosed:</p>

            <h3 className="font-semibold text-[#1a1a2e] mt-4 mb-2">For Treatment</h3>
            <p>PHI may be used to generate clinical documentation including medical notes, transcripts, and summaries that assist healthcare providers in delivering patient care.</p>

            <h3 className="font-semibold text-[#1a1a2e] mt-4 mb-2">For Health Care Operations</h3>
            <p>PHI may be used to support quality improvement, compliance monitoring, and audit logging as required by HIPAA. This includes maintaining immutable audit trails of all PHI access and modification events.</p>

            <h3 className="font-semibold text-[#1a1a2e] mt-4 mb-2">As Required by Law</h3>
            <p>We may disclose PHI when required to do so by applicable federal, state, or local law, including in response to a court order, subpoena, or government investigation.</p>

            <h3 className="font-semibold text-[#1a1a2e] mt-4 mb-2">For Business Associate Obligations</h3>
            <p>We may disclose PHI to subcontractors (such as AI transcription vendors) who have signed Business Associate Agreements with us and who assist us in providing the Platform's services.</p>

            <h3 className="font-semibold text-[#1a1a2e] mt-4 mb-2">With Your Authorization</h3>
            <p>For uses and disclosures not described in this Notice, we will use or disclose PHI only with written authorization from the patient or their personal representative. You may revoke your authorization at any time in writing.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">Uses and Disclosures We Will Never Make</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li>We will not sell PHI to third parties</li>
              <li>We will not use PHI for advertising, marketing, or fundraising without explicit authorization</li>
              <li>We will not disclose PHI to employers for employment decisions</li>
              <li>We will not share PHI with unauthorized subcontractors who have not executed a Business Associate Agreement</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">Individual Rights Regarding PHI</h2>
            <p>Patients have the following rights with respect to their PHI. These rights are exercised through your healthcare provider (covered entity), not directly through Halo Note:</p>

            <h3 className="font-semibold text-[#1a1a2e] mt-4 mb-2">Right of Access</h3>
            <p>You have the right to inspect and obtain a copy of PHI that your healthcare provider maintains about you, with limited exceptions. Requests should be directed to your healthcare provider.</p>

            <h3 className="font-semibold text-[#1a1a2e] mt-4 mb-2">Right to Amend</h3>
            <p>You have the right to request that your healthcare provider amend PHI that you believe is incorrect or incomplete. Your provider may deny the request under certain circumstances.</p>

            <h3 className="font-semibold text-[#1a1a2e] mt-4 mb-2">Right to an Accounting of Disclosures</h3>
            <p>You have the right to request a list of disclosures of your PHI made by your healthcare provider or its business associates for purposes other than treatment, payment, or health care operations, for the six (6) years prior to the request.</p>

            <h3 className="font-semibold text-[#1a1a2e] mt-4 mb-2">Right to Request Restrictions</h3>
            <p>You have the right to request that your healthcare provider restrict the use or disclosure of your PHI. Your provider is not required to agree to all restrictions, but if it does agree, it is bound by that restriction.</p>

            <h3 className="font-semibold text-[#1a1a2e] mt-4 mb-2">Right to Confidential Communications</h3>
            <p>You have the right to request that your healthcare provider communicate with you in a specific way or location (e.g., home instead of work phone) when contacting you about PHI.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">Data Security Practices</h2>
            <p>We implement the HIPAA Security Rule safeguards to protect electronic PHI (ePHI):</p>
            <ul className="list-disc pl-6 space-y-2 mt-3">
              <li><strong>Administrative Safeguards:</strong> Security management processes, workforce training, access authorization, and contingency planning</li>
              <li><strong>Physical Safeguards:</strong> Facility access controls and workstation security</li>
              <li><strong>Technical Safeguards:</strong> Access controls, audit logging, integrity controls, and transmission security including TLS encryption and AES-256 encryption at rest</li>
              <li><strong>Automatic Session Timeout:</strong> Sessions are terminated after 15 minutes of inactivity per §164.312(a)(2)(iii)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">Breach Notification</h2>
            <p>In the event of a breach of unsecured PHI, we will notify affected covered entities without unreasonable delay and within 60 days of discovery of the breach, as required by HIPAA §164.410. Covered entities will then notify affected individuals as required by law.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">Changes to This Notice</h2>
            <p>We reserve the right to change this Notice at any time. We will post the revised Notice on our website and make it available upon request. The effective date appears at the top of this Notice.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">Complaints</h2>
            <p>If you believe your privacy rights have been violated, you may file a complaint with:</p>
            <ul className="list-disc pl-6 space-y-2 mt-3">
              <li>
                <strong>Halo Note Privacy Officer:</strong><br />
                Email: <a href="mailto:support@halonote.app">support@halonote.app</a>
              </li>
              <li>
                <strong>U.S. Department of Health and Human Services, Office for Civil Rights:</strong><br />
                <a href="https://www.hhs.gov/ocr/privacy/hipaa/complaints/" className="text-emerald-700 underline underline-offset-2" target="_blank" rel="noopener noreferrer">
                  https://www.hhs.gov/ocr/privacy/hipaa/complaints/
                </a><br />
                Phone: 1-800-368-1019 (TDD: 1-800-537-7697)
              </li>
            </ul>
            <p className="mt-3">We will not retaliate against you for filing a complaint.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">Contact Our Privacy Officer</h2>
            <div className="p-4 bg-gray-50 rounded-xl border border-gray-100 font-mono text-sm">
              <p>Halo Note, HIPAA Privacy Officer</p>
              <p>Email: <a href="mailto:support@halonote.app" style={{color:'inherit'}}>support@halonote.app</a></p>
            </div>
            <p className="mt-4">Also see: <Link href="/baa" className="text-emerald-700 underline underline-offset-2">Business Associate Agreement</Link> · <Link href="/privacy" className="text-emerald-700 underline underline-offset-2">Privacy Policy</Link> · <Link href="/data-rights" className="text-emerald-700 underline underline-offset-2">Data Rights</Link></p>
          </section>
        </div>
      </div>
    </MarketingLayout>
  );
}
