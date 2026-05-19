import { useState } from "react";
import { Link } from "wouter";
import MarketingLayout from "@/components/marketing/MarketingLayout";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { FileCheck, CheckCircle2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { isAuthenticated } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";

export default function BAAPage() {
  const authed = isAuthenticated();
  const { toast } = useToast();
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const { data: user } = useQuery<any>({
    queryKey: ["/api/auth/me"],
    enabled: authed,
  });

  async function handleAcknowledge() {
    if (!acknowledged) return;
    setSubmitting(true);
    try {
      await apiRequest("POST", "/api/compliance/baa-acknowledge", {
        timestamp: new Date().toISOString(),
      });
      setDone(true);
      toast({ title: "BAA Acknowledged", description: "Your Business Associate Agreement acknowledgment has been recorded." });
    } catch {
      toast({ title: "Could not save acknowledgment", variant: "destructive", description: "Please try again or contact support." });
    } finally {
      setSubmitting(false);
    }
  }

  const baaAlreadySigned = user?.baaSignedAt;

  return (
    <MarketingLayout>
      <div className="max-w-4xl mx-auto px-5 sm:px-8 lg:px-10 py-20 md:py-28">
        <div className="mb-12">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-violet-50 border border-violet-100 mb-6">
            <FileCheck className="w-6 h-6 text-violet-600" />
          </div>
          <h1 className="text-4xl font-bold text-[#1a1a2e] tracking-tight mb-2">Business Associate Agreement</h1>
          <p className="text-gray-500 text-[15px]">
            <strong>Effective Date:</strong> March 19, 2026 &nbsp;·&nbsp;
            <strong>Version:</strong> 1.0
          </p>

          {(done || baaAlreadySigned) && (
            <div className="mt-6 p-4 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
              <div>
                <p className="font-semibold text-emerald-800 text-sm">BAA Acknowledged</p>
                {baaAlreadySigned && (
                  <p className="text-emerald-700 text-xs mt-0.5">
                    Signed on {new Date(baaAlreadySigned).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="prose prose-gray max-w-none space-y-8 text-[15px] leading-relaxed text-gray-700">

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">Preamble</h2>
            <p>
              This Business Associate Agreement ("BAA" or "Agreement") is entered into between Halo Note ("Business Associate") and
              the covered entity or business associate organization executing this Agreement ("Covered Entity"). This Agreement
              supplements and is made part of any underlying service agreement between the parties. In the event of a conflict,
              the terms of this BAA shall control with respect to HIPAA obligations.
            </p>
            <p className="mt-3">
              This BAA is required by the Health Insurance Portability and Accountability Act of 1996 ("HIPAA"), the Health Information
              Technology for Economic and Clinical Health Act ("HITECH"), and their implementing regulations (collectively, the "HIPAA Rules")
              whenever Halo Note creates, receives, maintains, or transmits Protected Health Information on behalf of a covered entity.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">1. Definitions</h2>
            <p>Terms used but not otherwise defined in this Agreement shall have the same meaning as those terms in the HIPAA Rules.</p>
            <ul className="list-disc pl-6 space-y-2 mt-3">
              <li><strong>"Business Associate"</strong> means Halo Note.</li>
              <li><strong>"Covered Entity"</strong> means the healthcare provider organization or individual licensed clinician that has subscribed to the Platform.</li>
              <li><strong>"PHI"</strong> means Protected Health Information as defined in 45 CFR §164.103.</li>
              <li><strong>"Services"</strong> means the AI clinical documentation services provided by Halo Note under the applicable service agreement.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">2. Obligations of Business Associate</h2>
            <p>Halo Note agrees to:</p>
            <ul className="list-disc pl-6 space-y-2 mt-3">
              <li>Not use or disclose PHI other than as permitted or required by this Agreement or as required by law</li>
              <li>Use appropriate safeguards, and comply with the Security Rule with respect to ePHI, to prevent use or disclosure of PHI other than as provided for by this Agreement</li>
              <li>Report to Covered Entity any use or disclosure of PHI not provided for by this Agreement, including breaches of Unsecured PHI, without unreasonable delay and within 60 days of discovery</li>
              <li>Ensure that any subcontractors that create, receive, maintain, or transmit PHI on behalf of Business Associate agree to the same restrictions, conditions, and requirements that apply to Business Associate</li>
              <li>Make PHI available in accordance with HIPAA §164.524 (right of access) and §164.528 (accounting of disclosures)</li>
              <li>Make its internal practices, books, and records relating to the use and disclosure of PHI available to the Secretary of HHS for purposes of compliance review</li>
              <li>Upon termination, return or destroy all PHI (or extend protections indefinitely if return or destruction is not feasible)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">3. Permitted Uses and Disclosures</h2>
            <p>Business Associate may use or disclose PHI only as follows:</p>
            <ul className="list-disc pl-6 space-y-2 mt-3">
              <li>To perform the Services specified in the applicable service agreement, including transcription, AI note generation, audit logging, and EHR integration functions</li>
              <li>As required by law</li>
              <li>For Business Associate's proper management and administration, provided such uses are necessary and disclosures are required by law or are made with reasonable assurances of confidentiality</li>
              <li>To provide data aggregation services relating to the health care operations of Covered Entity</li>
              <li>To de-identify PHI in accordance with HIPAA §164.514 for platform improvement purposes</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">4. Obligations of Covered Entity</h2>
            <p>Covered Entity agrees to:</p>
            <ul className="list-disc pl-6 space-y-2 mt-3">
              <li>Obtain all patient consents, authorizations, and notices required by applicable law before using the Platform to process PHI</li>
              <li>Notify Business Associate of any restriction or limitation in Covered Entity's Notice of Privacy Practices that may affect Business Associate's use or disclosure of PHI</li>
              <li>Not request Business Associate to use or disclose PHI in a manner that would violate HIPAA</li>
              <li>Ensure that all authorized users access the Platform only for permitted purposes</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">5. Term and Termination</h2>
            <p>This Agreement shall be effective as of the date acknowledged below and shall terminate when the underlying service agreement terminates, or when all PHI provided by Covered Entity to Business Associate is destroyed or returned. Either party may terminate this Agreement if the other has violated a material term, provided thirty (30) days' written notice and the opportunity to cure.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">6. Miscellaneous</h2>
            <p>This Agreement shall be interpreted as broadly as necessary to implement and comply with the HIPAA Rules. The parties agree to take such action as may be necessary to amend this Agreement from time to time to remain compliant with HIPAA as amended. This Agreement shall be governed by the laws of the State of Delaware.</p>
          </section>

          {authed && !done && !baaAlreadySigned && (
            <section className="mt-10">
              <div className="p-6 bg-violet-50 border border-violet-200 rounded-2xl space-y-4">
                <h3 className="font-bold text-[#1a1a2e] text-lg">Digital Acknowledgment</h3>
                <p className="text-[14px] text-gray-600">
                  By checking the box below, you, as an authorized representative of your organization, acknowledge that you have read and agree to the terms of this Business Associate Agreement. This digital acknowledgment is binding and the timestamp will be recorded in your organization's compliance record.
                </p>
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="baa-acknowledge"
                    checked={acknowledged}
                    onCheckedChange={(v) => setAcknowledged(v === true)}
                    data-testid="checkbox-baa-acknowledge"
                  />
                  <Label htmlFor="baa-acknowledge" className="text-[14px] cursor-pointer leading-relaxed">
                    I am an authorized representative of my organization and I agree to this Business Associate Agreement on behalf of my organization.
                  </Label>
                </div>
                <Button
                  onClick={handleAcknowledge}
                  disabled={!acknowledged || submitting}
                  className="bg-violet-600 hover:bg-violet-700 text-white"
                  data-testid="button-baa-submit"
                >
                  {submitting ? "Recording acknowledgment..." : "Acknowledge & Sign BAA"}
                </Button>
              </div>
            </section>
          )}

          {!authed && (
            <section className="mt-10">
              <div className="p-6 bg-gray-50 border border-gray-200 rounded-2xl">
                <p className="text-[14px] text-gray-600">
                  To acknowledge this BAA on behalf of your organization, please{" "}
                  <Link href="/login" className="text-violet-700 underline underline-offset-2 font-medium">sign in</Link> to your Halo Note account.
                  Organization administrators can also acknowledge the BAA during the onboarding process.
                </p>
              </div>
            </section>
          )}

          <section>
            <p className="text-[13px] text-gray-400 mt-6">
              Also see: <Link href="/hipaa-notice" className="underline underline-offset-2">HIPAA Notice of Privacy Practices</Link> · <Link href="/privacy" className="underline underline-offset-2">Privacy Policy</Link> · <Link href="/terms" className="underline underline-offset-2">Terms of Service</Link>
            </p>
          </section>
        </div>
      </div>
    </MarketingLayout>
  );
}
