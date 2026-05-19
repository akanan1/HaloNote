import { useState } from "react";
import MarketingLayout from "@/components/marketing/MarketingLayout";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import { UserCog, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function DataRightsPage() {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [requestType, setRequestType] = useState("");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name || !email || !requestType) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/data-rights-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, requestType, details }),
      });
      if (!res.ok) throw new Error("Failed");
      setSubmitted(true);
      toast({ title: "Request submitted", description: "We will respond within 30 days." });
    } catch {
      toast({ title: "Submission failed", variant: "destructive", description: "Please email support@halonote.app directly." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <MarketingLayout>
      <div className="max-w-4xl mx-auto px-5 sm:px-8 lg:px-10 py-20 md:py-28">
        <div className="mb-12">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-sky-50 border border-sky-100 mb-6">
            <UserCog className="w-6 h-6 text-sky-600" />
          </div>
          <h1 className="text-4xl font-bold text-[#1a1a2e] tracking-tight mb-4">Data Rights</h1>
          <p className="text-gray-500 text-[15px]">
            <strong>Effective Date:</strong> March 19, 2026
          </p>
        </div>

        <div className="prose prose-gray max-w-none space-y-8 text-[15px] leading-relaxed text-gray-700 mb-16">
          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">Your Rights Under HIPAA</h2>
            <p>
              Under HIPAA and applicable privacy laws, individuals have rights regarding their Protected Health Information (PHI) and personal data. This page explains how to exercise those rights with Halo Note.
            </p>
            <p className="mt-3">
              <strong>Note for patients:</strong> If you are a patient whose information was processed through Halo Note, your HIPAA rights (access, amendment, accounting of disclosures) are exercised through your healthcare provider, not directly through Halo Note. Please contact your physician or clinic. However, you may use the form below to submit an inquiry and we will direct it appropriately.
            </p>
            <p className="mt-3">
              <strong>Note for platform users (clinicians and administrators):</strong> You may request access to, correction of, or deletion of your own account information using the form below.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">Types of Requests We Accept</h2>
            <div className="grid sm:grid-cols-2 gap-4 mt-4">
              {[
                {
                  type: "Access Request",
                  desc: "Request a copy of your personal account data or learn what PHI we have processed on your behalf.",
                },
                {
                  type: "Correction Request",
                  desc: "Request correction of inaccurate personal account information we hold about you.",
                },
                {
                  type: "Deletion Request",
                  desc: "Request deletion of your account data or specific records, subject to legal retention requirements.",
                },
                {
                  type: "Accounting of Disclosures",
                  desc: "Request a list of instances where your PHI was disclosed outside of treatment, payment, or health care operations.",
                },
              ].map((item) => (
                <div key={item.type} className="p-4 bg-gray-50 rounded-xl border border-gray-100">
                  <h3 className="font-semibold text-[#1a1a2e] text-[14px] mb-1">{item.type}</h3>
                  <p className="text-[13px] text-gray-500">{item.desc}</p>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">Response Timeline</h2>
            <p>We will respond to all data rights requests within <strong>30 calendar days</strong> of receipt. In complex cases we may extend this by an additional 60 days, in which case we will notify you of the extension and reason. We will verify your identity before fulfilling any request.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-3">Legal Basis for Retention</h2>
            <p>We may be unable to delete certain PHI that we are legally required to retain. HIPAA requires retention of documentation for at least six (6) years. State laws may impose longer retention periods. We will inform you if your deletion request cannot be fully honored and the reasons why.</p>
          </section>
        </div>

        {submitted ? (
          <div className="p-8 bg-emerald-50 border border-emerald-200 rounded-2xl flex flex-col items-center text-center gap-4">
            <CheckCircle2 className="w-12 h-12 text-emerald-600" />
            <h3 className="text-xl font-bold text-emerald-800">Request Submitted</h3>
            <p className="text-emerald-700 text-[15px] max-w-md">
              Thank you. We have received your request and will respond within 30 days to <strong>{email}</strong>.
            </p>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-2xl p-8 shadow-sm">
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-6">Submit a Data Rights Request</h2>
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid sm:grid-cols-2 gap-5">
                <div className="space-y-1.5">
                  <Label htmlFor="dr-name">Full Name</Label>
                  <Input
                    id="dr-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your full legal name"
                    required
                    data-testid="input-dr-name"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="dr-email">Email Address</Label>
                  <Input
                    id="dr-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    data-testid="input-dr-email"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="dr-type">Request Type</Label>
                <Select value={requestType} onValueChange={setRequestType} required>
                  <SelectTrigger data-testid="select-dr-type">
                    <SelectValue placeholder="Select request type..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="access">Access Request, View my data</SelectItem>
                    <SelectItem value="correction">Correction Request, Fix inaccurate data</SelectItem>
                    <SelectItem value="deletion">Deletion Request, Delete my data</SelectItem>
                    <SelectItem value="accounting">Accounting of Disclosures</SelectItem>
                    <SelectItem value="other">Other Privacy Inquiry</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="dr-details">Additional Details</Label>
                <Textarea
                  id="dr-details"
                  value={details}
                  onChange={(e) => setDetails(e.target.value)}
                  placeholder="Please describe your request in detail, including any relevant dates or specific data you are inquiring about."
                  className="min-h-[120px] resize-none"
                  data-testid="textarea-dr-details"
                />
              </div>

              <Button
                type="submit"
                disabled={!name || !email || !requestType || submitting}
                className="w-full sm:w-auto"
                data-testid="button-dr-submit"
              >
                {submitting ? "Submitting..." : "Submit Request"}
              </Button>
            </form>
            <p className="text-[13px] text-gray-400 mt-4">
              You may also email us directly at{" "}
              <a href="mailto:support@halonote.app" className="underline underline-offset-2">support@halonote.app</a>
            </p>
          </div>
        )}

        <p className="mt-8 text-[13px] text-gray-400">
          Also see: <Link href="/privacy" className="underline underline-offset-2">Privacy Policy</Link> · <Link href="/hipaa-notice" className="underline underline-offset-2">HIPAA Notice</Link>
        </p>
      </div>
    </MarketingLayout>
  );
}
