import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import MarketingLayout from "@/components/marketing/MarketingLayout";
import { SEOMeta } from "@/components/SEOMeta";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { CheckCircle2, Loader2, AlertCircle, Sparkles, Shield, Lock, ArrowRight, Clock, Mail, CalendarCheck, Users } from "lucide-react";
import { Link } from "wouter";

// The original Replit project imports `insertAccessRequestSchema` from
// `@shared/schema` (a drizzle-zod schema bound to the backend's
// access_requests table). The backend isn't part of this
// marketing-site package, so the schema is inlined verbatim below , 
// same fields, same validation, same FormValues shape.
const formSchema = z.object({
  fullName: z.string().min(2, "Full name is required"),
  email: z.string().email("Please enter a valid email address"),
  specialty: z.string().min(1, "Please select a specialty"),
  practiceType: z.string().min(1, "Please select a practice type"),
  organizationName: z.string().min(1, "Organization name is required"),
  ehrSystem: z.string().min(1, "Please select an EHR system"),
  message: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

const specialties = [
  "Primary Care / Family Medicine",
  "Internal Medicine",
  "Cardiology",
  "Dermatology",
  "Emergency Medicine",
  "Endocrinology",
  "Gastroenterology",
  "Neurology",
  "Obstetrics & Gynecology",
  "Oncology",
  "Ophthalmology",
  "Orthopedics",
  "Pediatrics",
  "Psychiatry",
  "Pulmonology",
  "Radiology",
  "Surgery",
  "Urology",
  "Other",
];

const practiceTypes = [
  "Solo Practice",
  "Small Group (2-10 physicians)",
  "Large Group (11-50 physicians)",
  "Hospital / Health System",
  "Academic Medical Center",
  "Urgent Care",
  "Telehealth",
  "Other",
];

const ehrSystems = [
  "Epic",
  "Cerner / Oracle Health",
  "Athenahealth",
  "eClinicalWorks",
  "Allscripts",
  "NextGen",
  "DrChrono",
  "Practice Fusion",
  "Greenway Health",
  "None / Paper-based",
  "Other",
];

export default function RequestAccessPage() {
  const [submitted, setSubmitted] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema as any),
    defaultValues: {
      fullName: "",
      email: "",
      specialty: "",
      practiceType: "",
      organizationName: "",
      ehrSystem: "",
      message: "",
    },
  });

  const mutation = useMutation({
    mutationFn: async (data: FormValues) => {
      const res = await fetch("/api/access-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Request failed" }));
        throw new Error(err.message || "Failed to submit request");
      }
      return res.json();
    },
    onSuccess: () => setSubmitted(true),
  });

  if (submitted) {
    return (
      <MarketingLayout>
        <SEOMeta title="You're on the List, Halo Note" description="Your early access request has been received. We'll be in touch within 48 hours." />
        <section className="relative min-h-screen flex items-center overflow-hidden py-28" data-testid="success-confirmation">
          {/* Background */}
          <div className="absolute inset-0 bg-gradient-to-br from-[#f0f4ff] via-[#fafafa] to-[#ecfdf5]" />
          <div className="absolute top-[10%] left-[20%] w-[500px] h-[500px] bg-indigo-400/[0.06] rounded-full blur-[140px]" />
          <div className="absolute bottom-[10%] right-[15%] w-[400px] h-[400px] bg-emerald-400/[0.07] rounded-full blur-[120px]" />

          <div className="relative max-w-2xl mx-auto px-5 text-center">
            {/* Icon */}
            <div className="relative mb-10 flex justify-center">
              <div className="absolute w-36 h-36 rounded-full bg-emerald-400/10 blur-2xl" />
              <div className="relative w-24 h-24 rounded-3xl bg-emerald-50 border-2 border-emerald-200 flex items-center justify-center shadow-sm">
                <CheckCircle2 className="w-12 h-12 text-emerald-500" />
              </div>
            </div>

            {/* Headline */}
            <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-emerald-100 text-emerald-700 text-[12px] font-semibold mb-5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Request received
            </div>
            <h2 className="text-[clamp(2.2rem,5vw,3.5rem)] font-black text-gray-950 tracking-tight leading-[1.06] mb-4">
              You're on the list.
            </h2>
            <p className="text-[17px] text-gray-500 leading-relaxed max-w-md mx-auto mb-12">
              We review every request personally. Expect a message from our team within <strong className="text-gray-700">48 hours</strong> with your access details.
            </p>

            {/* What happens next */}
            <div className="grid sm:grid-cols-3 gap-4 mb-12 text-left">
              {[
                {
                  icon: Mail,
                  color: "#4f46e5",
                  bg: "#eef2ff",
                  step: "1",
                  title: "Check your inbox",
                  body: "We'll email you within 48 hours with your personalized setup link.",
                },
                {
                  icon: CalendarCheck,
                  color: "#059669",
                  bg: "#ecfdf5",
                  step: "2",
                  title: "Onboarding call",
                  body: "A 15-minute call to configure your specialty templates and EHR connection.",
                },
                {
                  icon: Sparkles,
                  color: "#7c3aed",
                  bg: "#f5f3ff",
                  step: "3",
                  title: "Start documenting",
                  body: "Go live within 24 hours of your call, fully configured for your workflow.",
                },
              ].map((item, i) => {
                const Icon = item.icon;
                return (
                  <div key={i} className="rounded-2xl bg-white border border-gray-100 p-5 shadow-sm">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-4" style={{ background: item.bg }}>
                      <Icon className="w-5 h-5" style={{ color: item.color }} />
                    </div>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">Step {item.step}</div>
                    <p className="text-[14px] font-bold text-gray-900 mb-1.5">{item.title}</p>
                    <p className="text-[13px] text-gray-500 leading-relaxed">{item.body}</p>
                  </div>
                );
              })}
            </div>

            {/* Trust note */}
            <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 mb-10">
              {["HIPAA Compliant", "No spam, ever", "Cancel anytime"].map((t) => (
                <div key={t} className="flex items-center gap-1.5 text-[13px] text-gray-400">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  {t}
                </div>
              ))}
            </div>

            {/* Actions */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link href="/product">
                <Button className="rounded-full h-11 px-7 text-[14px] font-semibold bg-gray-950 text-white hover:bg-gray-800 transition-colors group" data-testid="button-explore-product">
                  Explore the product
                  <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-0.5 transition-transform" />
                </Button>
              </Link>
              <Button
                variant="outline"
                className="rounded-full h-11 px-7 text-[14px] border-gray-200 text-gray-600 hover:bg-gray-50"
                onClick={() => { setSubmitted(false); form.reset(); mutation.reset(); }}
                data-testid="button-submit-another"
              >
                Submit another request
              </Button>
            </div>
          </div>
        </section>
      </MarketingLayout>
    );
  }

  return (
    <MarketingLayout>
      <SEOMeta
        title="Request Early Access, Halo Note"
        description="Join the founding cohort of physicians using Halo Note. Get early access pricing, priority onboarding, and a direct line to the product team."
      />
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-[#f0f0ff] via-[#FAFAF7] to-[#e8f4f8]" />
        <div className="absolute top-[-150px] right-[-80px] w-[500px] h-[500px] rounded-full bg-gradient-to-br from-[#4F46E5]/[0.06] to-[#7C3AED]/[0.03] blur-[80px]" style={{ animation: 'float 8s ease-in-out infinite' }} />
        <div className="absolute bottom-[20%] left-[-60px] w-[400px] h-[400px] rounded-full bg-gradient-to-tr from-[#06B6D4]/[0.05] to-transparent blur-[80px]" style={{ animation: 'float 10s ease-in-out infinite reverse' }} />

        <div className="relative max-w-6xl mx-auto px-5 sm:px-8 lg:px-10 pt-28 pb-20 md:pt-36 md:pb-28">
          <div className="grid lg:grid-cols-[1fr,480px] gap-16 items-start">
            {/* Left side - info */}
            <div className="hidden lg:block pt-8">
              <p className="text-[12px] font-semibold text-[#4F46E5] uppercase tracking-[0.15em] mb-5">Get Started</p>
              <h1
                className="text-4xl md:text-[2.75rem] font-bold text-[#1a1a2e] tracking-[-0.03em] leading-[1.1] mb-6"
                data-testid="text-request-headline"
              >
                Request{" "}
                <span className="bg-gradient-to-r from-[#4F46E5] via-[#7C3AED] to-[#4F46E5] bg-clip-text text-transparent">Early Access</span>
              </h1>
              <p className="text-[17px] text-gray-500 mb-12 leading-relaxed max-w-md">
                Tell us about your practice and we'll set you up with Halo Note. Our team will reach out within 48 hours.
              </p>

              <div className="space-y-5">
                {[
                  { icon: Sparkles, text: "Personalized AI that adapts to your documentation style", color: "#7C3AED", bg: "#F5F3FF" },
                  { icon: Shield, text: "HIPAA-ready architecture with full audit trails", color: "#059669", bg: "#ECFDF5" },
                  { icon: Lock, text: "Your clinical judgment always has the final word", color: "#4F46E5", bg: "#EEF2FF" },
                  { icon: Clock, text: "Save 2+ hours daily on documentation", color: "#D97706", bg: "#FFFBEB" },
                ].map((item, i) => (
                  <div key={i} className="flex items-center gap-4 p-4 rounded-xl bg-white/80 border border-gray-100">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: item.bg }}>
                      <item.icon className="w-5 h-5" style={{ color: item.color }} />
                    </div>
                    <span className="text-[14px] text-gray-600 leading-relaxed">{item.text}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Mobile heading */}
            <div className="lg:hidden text-center mb-4">
              <h1
                className="text-3xl font-bold text-[#1a1a2e] mb-3"
                data-testid="text-request-headline-mobile"
              >
                Request <span className="text-[#4F46E5]">Early Access</span>
              </h1>
              <p className="text-gray-500 text-[15px]">
                Tell us about your practice and we'll set you up with Halo Note.
              </p>
            </div>

            {/* Form */}
            <div className="relative">
              <div className="p-8 md:p-9 rounded-2xl bg-white border border-gray-200/80 shadow-xl">
                {mutation.isError && (
                  <div className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 flex items-start gap-3" data-testid="error-banner">
                    <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-red-800">Submission Failed</p>
                      <p className="text-sm text-red-600">{mutation.error?.message}</p>
                    </div>
                  </div>
                )}

                <Form {...form}>
                  <form onSubmit={form.handleSubmit((data) => mutation.mutate(data))} className="space-y-5" data-testid="form-request-access">
                    <FormField
                      control={form.control}
                      name="fullName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-gray-700 text-[13px] font-medium">Full Name</FormLabel>
                          <FormControl>
                            <Input placeholder="Dr. Jane Smith" {...field} data-testid="input-full-name" className="h-11 rounded-xl border-gray-200 focus:border-[#4F46E5] focus:ring-[#4F46E5]/20" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="email"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-gray-700 text-[13px] font-medium">Email</FormLabel>
                          <FormControl>
                            <Input type="email" placeholder="jane.smith@practice.com" {...field} data-testid="input-email" className="h-11 rounded-xl border-gray-200 focus:border-[#4F46E5] focus:ring-[#4F46E5]/20" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <div className="grid grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="specialty"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-gray-700 text-[13px] font-medium">Specialty</FormLabel>
                            <Select onValueChange={field.onChange} value={field.value}>
                              <FormControl>
                                <SelectTrigger data-testid="select-specialty" className="h-11 rounded-xl border-gray-200">
                                  <SelectValue placeholder="Select" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {specialties.map((s) => (
                                  <SelectItem key={s} value={s}>{s}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="practiceType"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-gray-700 text-[13px] font-medium">Practice Type</FormLabel>
                            <Select onValueChange={field.onChange} value={field.value}>
                              <FormControl>
                                <SelectTrigger data-testid="select-practice-type" className="h-11 rounded-xl border-gray-200">
                                  <SelectValue placeholder="Select" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {practiceTypes.map((p) => (
                                  <SelectItem key={p} value={p}>{p}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    <FormField
                      control={form.control}
                      name="organizationName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-gray-700 text-[13px] font-medium">Organization Name</FormLabel>
                          <FormControl>
                            <Input placeholder="Your clinic or hospital name" {...field} data-testid="input-organization" className="h-11 rounded-xl border-gray-200 focus:border-[#4F46E5] focus:ring-[#4F46E5]/20" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="ehrSystem"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-gray-700 text-[13px] font-medium">EHR System</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger data-testid="select-ehr-system" className="h-11 rounded-xl border-gray-200">
                                <SelectValue placeholder="Select your EHR system" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {ehrSystems.map((e) => (
                                <SelectItem key={e} value={e}>{e}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="message"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-gray-700 text-[13px] font-medium">Message <span className="text-gray-400 font-normal">(Optional)</span></FormLabel>
                          <FormControl>
                            <Textarea
                              placeholder="Tell us about your documentation needs..."
                              rows={3}
                              {...field}
                              data-testid="textarea-message"
                              className="rounded-xl border-gray-200 focus:border-[#4F46E5] focus:ring-[#4F46E5]/20 resize-none"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <Button
                      type="submit"
                      size="lg"
                      className="w-full bg-[#4F46E5] hover:bg-[#4338CA] text-white font-semibold h-12 rounded-full shadow-[0_4px_14px_rgba(79,70,229,0.2)] hover:shadow-[0_6px_20px_rgba(79,70,229,0.3)] transition-all duration-500 group"
                      disabled={mutation.isPending}
                      data-testid="button-submit-request"
                    >
                      {mutation.isPending ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Submitting...
                        </>
                      ) : (
                        <>
                          Submit Request
                          <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-0.5 transition-transform" />
                        </>
                      )}
                    </Button>

                    <p className="text-[11px] text-gray-400 text-center pt-1">
                      By submitting, you agree to be contacted about Halo Note.
                    </p>
                  </form>
                </Form>
              </div>
            </div>
          </div>
        </div>

        <style>{`
          @keyframes float {
            0%, 100% { transform: translateY(0px) scale(1); }
            50% { transform: translateY(-30px) scale(1.02); }
          }
        `}</style>
      </section>
    </MarketingLayout>
  );
}
