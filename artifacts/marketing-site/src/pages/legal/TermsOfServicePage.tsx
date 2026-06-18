import { Link } from "wouter";
import MarketingLayout from "@/components/marketing/MarketingLayout";
import { FileText } from "lucide-react";

export default function TermsOfServicePage() {
  return (
    <MarketingLayout>
      <div className="max-w-4xl mx-auto px-5 sm:px-8 lg:px-10 py-20 md:py-28">
        <div className="mb-12">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-blue-50 border border-blue-100 mb-6">
            <FileText className="w-6 h-6 text-blue-600" />
          </div>
          <h1 className="text-4xl font-bold text-[#1a1a2e] tracking-tight mb-4">Terms of Service</h1>
          <p className="text-gray-500 text-[15px]">
            <strong>Effective Date:</strong> March 19, 2026 &nbsp;·&nbsp;
            <strong>Last Updated:</strong> March 19, 2026
          </p>
        </div>

        <div className="prose prose-gray max-w-none space-y-8 text-[15px] leading-relaxed text-gray-700">

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">1. Acceptance of Terms</h2>
            <p>
              These Terms of Service ("Terms") constitute a legally binding agreement between you ("User," "Provider," or "Administrator")
              and Halo Note ("Company," "we," "us," or "our") governing your use of the Halo Note AI clinical documentation platform
              and all related services ("Platform"). By creating an account, clicking "I agree," or using the Platform, you confirm that
              you have read, understood, and agree to be bound by these Terms and our <Link href="/privacy" className="text-blue-700 underline underline-offset-2">Privacy Policy</Link>.
            </p>
            <p className="mt-3">
              If you are accepting these Terms on behalf of an organization, you represent that you have authority to bind that organization.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">2. Eligibility and Authorized Use</h2>
            <p>The Platform is intended exclusively for use by:</p>
            <ul className="list-disc pl-6 space-y-2 mt-3">
              <li>Licensed healthcare providers (physicians, nurse practitioners, physician assistants, and other clinicians)</li>
              <li>Healthcare organizations and their authorized administrative staff</li>
              <li>Individuals who have received a valid organizational invite code</li>
            </ul>
            <p className="mt-3">You must be at least 18 years of age. You may not use the Platform if you have been suspended or terminated from the Platform by us.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">3. Healthcare-Specific Provisions</h2>

            <h3 className="font-semibold text-[#1a1a2e] mb-2">3.1 Physician Responsibility for AI Output</h3>
            <p className="text-red-700 font-medium bg-red-50 border border-red-100 rounded-lg p-4 mb-3">
              IMPORTANT: Halo Note is a documentation assistance tool, not a medical decision-making system. All AI-generated clinical notes, summaries, and coding suggestions are drafts that require physician review and must not be used as the final medical record without your explicit review and sign-off. You retain full clinical and legal responsibility for all documentation bearing your name.
            </p>
            <p>The Company does not practice medicine and does not provide medical advice, diagnosis, or treatment. The accuracy of AI-generated notes depends on the quality of the audio input, network conditions, and the completeness of information provided. AI outputs may contain errors, omissions, or hallucinations.</p>

            <h3 className="font-semibold text-[#1a1a2e] mt-4 mb-2">3.2 Recording Consent</h3>
            <p>You are solely responsible for obtaining all required consents from patients before recording any clinical encounter. Applicable federal and state laws govern recording consent requirements. You must ensure all parties to a recorded conversation are informed of and consent to the recording as required by applicable law.</p>

            <h3 className="font-semibold text-[#1a1a2e] mt-4 mb-2">3.3 HIPAA Compliance</h3>
            <p>Use of the Platform for processing Protected Health Information (PHI) requires execution of a Business Associate Agreement (BAA) with the Company. A BAA must be signed by an authorized organizational representative before PHI may be processed. See our <Link href="/baa" className="text-blue-700 underline underline-offset-2">Business Associate Agreement page</Link>.</p>

            <h3 className="font-semibold text-[#1a1a2e] mt-4 mb-2">3.4 No Emergency Services</h3>
            <p>The Platform is not designed or intended to support emergency medical services. Do not rely on the Platform for time-critical clinical decisions or emergency situations.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">4. Account Security</h2>
            <p>You are responsible for maintaining the confidentiality of your account credentials and for all activity that occurs under your account. You must immediately notify us of any unauthorized access to your account. We recommend enabling strong passwords and logging out after each session. The Platform automatically terminates sessions after 15 minutes of inactivity.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">5. Prohibited Uses</h2>
            <p>You agree not to:</p>
            <ul className="list-disc pl-6 space-y-2 mt-3">
              <li>Use the Platform for any unlawful purpose or in violation of HIPAA, state privacy laws, or any applicable professional licensing standards</li>
              <li>Share your login credentials with unauthorized individuals</li>
              <li>Attempt to reverse engineer, scrape, or extract the Platform's AI models or data</li>
              <li>Introduce malicious code or attempt to gain unauthorized access to the Platform's infrastructure</li>
              <li>Use the Platform to generate fraudulent documentation or billing codes</li>
              <li>Use the Platform for non-clinical purposes or in ways that violate patient privacy</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">6. Intellectual Property</h2>
            <p>The Platform, including its software, AI models, interface, and branding, is owned by Halo Note and protected by intellectual property laws. You receive a limited, non-exclusive, non-transferable license to use the Platform for its intended purpose. Clinical notes generated by the Platform using your input belong to you and your organization.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">7. Limitation of Liability</h2>
            <p className="uppercase font-semibold text-sm text-gray-600 mb-3">To the maximum extent permitted by applicable law:</p>
            <p>THE PLATFORM IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED. THE COMPANY EXPRESSLY DISCLAIMS ALL WARRANTIES INCLUDING IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.</p>
            <p className="mt-3">IN NO EVENT SHALL THE COMPANY BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES ARISING OUT OF OR RELATED TO YOUR USE OF THE PLATFORM, INCLUDING ANY CLINICAL OUTCOMES, BILLING ERRORS, OR REGULATORY PENALTIES RESULTING FROM YOUR RELIANCE ON AI-GENERATED CONTENT.</p>
            <p className="mt-3">OUR TOTAL LIABILITY FOR ANY CLAIMS ARISING UNDER THESE TERMS SHALL NOT EXCEED THE AMOUNT YOU PAID TO US IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">8. Indemnification</h2>
            <p>You agree to indemnify, defend, and hold harmless the Company and its officers, directors, employees, and agents from any claims, damages, losses, or expenses (including reasonable attorneys' fees) arising from: (a) your use of the Platform; (b) your violation of these Terms; (c) your violation of HIPAA or other applicable law; (d) any clinical decision or documentation error for which you are responsible.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">9. Termination</h2>
            <p>We may suspend or terminate your access to the Platform at any time for cause, including violation of these Terms, non-payment, or any activity that poses a security or compliance risk. Upon termination, your right to use the Platform ceases immediately. Provisions regarding liability, indemnification, and dispute resolution survive termination.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">10. Governing Law and Dispute Resolution</h2>
            <p>These Terms are governed by the laws of the State of Delaware, without regard to conflict of law principles. Any disputes shall be resolved through binding arbitration under the rules of the American Arbitration Association, except that either party may seek injunctive relief in a court of competent jurisdiction.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">11. Changes to Terms</h2>
            <p>We may modify these Terms at any time. If changes are material, we will provide at least thirty (30) days' notice via email or in-app notification. Your continued use of the Platform after the effective date constitutes acceptance of the updated Terms.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">12. Contact</h2>
            <div className="p-4 bg-gray-50 rounded-xl border border-gray-100 font-mono text-sm">
              <p>Halo Note, Legal Department</p>
              <p>Email: <a href="mailto:support@halonote.app" style={{color:'inherit'}}>support@halonote.app</a></p>
            </div>
          </section>
        </div>
      </div>
    </MarketingLayout>
  );
}
