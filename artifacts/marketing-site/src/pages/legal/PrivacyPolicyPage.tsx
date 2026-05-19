import { Link } from "wouter";
import MarketingLayout from "@/components/marketing/MarketingLayout";
import { Shield } from "lucide-react";

export default function PrivacyPolicyPage() {
  return (
    <MarketingLayout>
      <div className="max-w-4xl mx-auto px-5 sm:px-8 lg:px-10 py-20 md:py-28">
        <div className="mb-12">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-emerald-50 border border-emerald-100 mb-6">
            <Shield className="w-6 h-6 text-emerald-600" />
          </div>
          <h1 className="text-4xl font-bold text-[#1a1a2e] tracking-tight mb-4">Privacy Policy</h1>
          <p className="text-gray-500 text-[15px]">
            <strong>Effective Date:</strong> March 19, 2026 &nbsp;·&nbsp;
            <strong>Last Updated:</strong> March 19, 2026
          </p>
        </div>

        <div className="prose prose-gray max-w-none space-y-8 text-[15px] leading-relaxed text-gray-700">

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">1. Introduction</h2>
            <p>
              Halo Note ("Company," "we," "us," or "our") operates a HIPAA-compliant AI-powered clinical documentation platform
              ("Platform") designed for licensed healthcare providers. This Privacy Policy describes how we collect, use, disclose,
              and safeguard information you provide to us, including Protected Health Information ("PHI") as defined under the
              Health Insurance Portability and Accountability Act of 1996 and its implementing regulations (collectively, "HIPAA").
            </p>
            <p className="mt-3">
              By creating an account or using the Platform, you acknowledge that you have read, understood, and agree to this Privacy Policy.
              If you do not agree, please do not use the Platform.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">2. Information We Collect</h2>
            <h3 className="font-semibold text-[#1a1a2e] mb-2">2.1 Account and Identity Information</h3>
            <p>When you register, we collect your name, email address, professional credentials, specialty, organization affiliation, and a hashed password. This information is used to authenticate you and personalize the Platform.</p>

            <h3 className="font-semibold text-[#1a1a2e] mt-4 mb-2">2.2 Protected Health Information (PHI)</h3>
            <p>The Platform processes audio recordings and transcripts of clinical encounters, which may contain PHI such as patient names, dates of service, diagnoses, medications, and treatment information. We process PHI solely on your behalf and under your direction as a HIPAA-covered entity or business associate.</p>

            <h3 className="font-semibold text-[#1a1a2e] mt-4 mb-2">2.3 Usage and Technical Data</h3>
            <p>We automatically collect log data including IP addresses, browser type, session duration, page views, and feature usage. This data is used for platform security, performance monitoring, and service improvement. It is not linked to patient PHI.</p>

            <h3 className="font-semibold text-[#1a1a2e] mt-4 mb-2">2.4 Audio Recordings and Transcripts</h3>
            <p>Audio captured during clinical encounters is transmitted securely to our transcription pipeline, processed using AI services operating under a Business Associate Agreement, and then converted to text. Audio buffers are purged after transcription is complete. Transcripts and generated notes are stored within your organization's data partition.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">3. How We Use Information</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li>To provide AI-powered clinical documentation services on your behalf</li>
              <li>To authenticate users and enforce organization-level access controls</li>
              <li>To maintain audit logs of PHI access and modifications as required by HIPAA §164.312(b)</li>
              <li>To improve the Platform using de-identified, aggregate usage analytics</li>
              <li>To communicate service updates, security notices, and compliance information</li>
              <li>To fulfill our obligations under any applicable Business Associate Agreement</li>
            </ul>
            <p className="mt-3">We do <strong>not</strong> sell PHI or use it for advertising purposes.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">4. Disclosure of PHI</h2>
            <p>We disclose PHI only as permitted or required by HIPAA and as described in our Business Associate Agreement, including:</p>
            <ul className="list-disc pl-6 space-y-2 mt-3">
              <li><strong>At your direction:</strong> When you push notes to an EHR system or share a record with another care team member</li>
              <li><strong>To subcontractors:</strong> AI processing vendors (e.g., transcription APIs) that have executed a Business Associate Agreement with us</li>
              <li><strong>As required by law:</strong> In response to a valid legal process, court order, or government investigation</li>
              <li><strong>For treatment, payment, and health care operations:</strong> As permitted under HIPAA §164.506</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">5. Data Retention</h2>
            <p>We retain PHI in accordance with applicable federal and state requirements, generally for a minimum of six (6) years from the date of creation or the date it was last in effect, whichever is later, consistent with HIPAA's documentation retention requirements at §164.530(j).</p>
            <p className="mt-3">Organization administrators may request deletion of patient records in accordance with applicable law. See our <Link href="/data-rights" className="text-emerald-700 underline underline-offset-2">Data Rights page</Link> for more information.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">6. Data Security</h2>
            <p>We implement HIPAA Technical Safeguards including:</p>
            <ul className="list-disc pl-6 space-y-2 mt-3">
              <li>TLS 1.2+ encryption for all data in transit</li>
              <li>AES-256 encryption for all data at rest</li>
              <li>Role-based access controls with principle of least privilege</li>
              <li>Automatic session timeout after 15 minutes of inactivity (§164.312(a)(2)(iii))</li>
              <li>Comprehensive audit logging of all PHI access events</li>
              <li>Multi-tenant data isolation at the organization level</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">7. Your Rights</h2>
            <p>Patients whose PHI is stored on the Platform have rights under HIPAA, including rights of access, amendment, and accounting of disclosures. These rights are exercised through your healthcare provider (the covered entity), not directly through Halo Note.</p>
            <p className="mt-3">Platform users (healthcare providers and administrators) may request access to, correction of, or deletion of their own account information. Visit our <Link href="/data-rights" className="text-emerald-700 underline underline-offset-2">Data Rights page</Link> to submit a request.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">8. Children's Privacy</h2>
            <p>The Platform is intended for licensed healthcare professionals and is not directed to individuals under the age of 18. We do not knowingly collect personal information from minors as users of the Platform. Note that PHI of pediatric patients may be processed when a licensed clinician uses the Platform in the ordinary course of their practice.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">9. Changes to This Policy</h2>
            <p>We may update this Privacy Policy periodically. If changes are material, we will notify you by email or through an in-app notice at least thirty (30) days before the changes take effect. Continued use of the Platform after the effective date constitutes acceptance of the revised policy.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">10. Contact Us</h2>
            <p>For privacy-related inquiries, complaints, or to exercise your rights, please contact our Privacy Officer at:</p>
            <div className="mt-3 p-4 bg-gray-50 rounded-xl border border-gray-100 font-mono text-sm">
              <p>Halo Note, Privacy Officer</p>
              <p>Email: <a href="mailto:support@halonote.app" style={{color:'inherit'}}>support@halonote.app</a></p>
              <p>Subject: Privacy Inquiry</p>
            </div>
            <p className="mt-3">For data access or deletion requests, use our <Link href="/data-rights" className="text-emerald-700 underline underline-offset-2">Data Rights request form</Link>.</p>
          </section>
        </div>
      </div>
    </MarketingLayout>
  );
}
