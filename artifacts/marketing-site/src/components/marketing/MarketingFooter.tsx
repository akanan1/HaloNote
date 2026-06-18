import { Link } from "wouter";
import { HaloNoteLogoIcon, HaloNoteWordmarkSimple } from "@/components/HaloNoteLogo";

const productLinks = [
  { label: "Product", href: "/product" },
  { label: "Live Demo", href: "/demo" },
  { label: "Pricing", href: "/pricing" },
  { label: "About", href: "/about" },
  { label: "Security", href: "/security" },
  { label: "Request Access", href: "/request-access" },
  { label: "Open App", href: "/login" },
];

const specialtyLinks = [
  { label: "Primary Care", href: "/specialties/primary-care" },
  { label: "Cardiology", href: "/specialties/cardiology" },
  { label: "Psychiatry & Behavioral Health", href: "/specialties/psychiatry" },
  { label: "All 36+ Specialties →", href: "/request-access" },
];

const legalLinks = [
  { label: "Privacy Policy", href: "/privacy" },
  { label: "Terms of Service", href: "/terms" },
  { label: "HIPAA Notice", href: "/hipaa-notice" },
  { label: "BAA", href: "/baa" },
  { label: "Data Rights", href: "/data-rights" },
];

export default function MarketingFooter() {
  return (
    <footer className="relative bg-[#050a18] text-gray-500 overflow-hidden" data-testid="marketing-footer">
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

      <div className="relative max-w-7xl mx-auto px-5 sm:px-8 lg:px-10 py-16">
        <div className="flex flex-col md:flex-row items-start justify-between gap-10">
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2.5">
              <HaloNoteLogoIcon size={30} color="#2663EB" />
              <HaloNoteWordmarkSimple fontSize={15} color="#ffffff" />
            </div>
            <p className="text-[13px] text-gray-500 max-w-[260px] leading-relaxed">
              AI-powered clinical documentation designed for the way physicians actually work.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-12">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-600 mb-4">Platform</p>
              <div className="flex flex-col gap-3">
                {productLinks.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`text-[14px] transition-colors duration-200 ${link.label === "Live Demo" ? "text-blue-400 hover:text-blue-300 font-medium" : "text-gray-500 hover:text-white"}`}
                    data-testid={`footer-link-${link.label.toLowerCase().replace(/\s/g, "-")}`}
                  >
                    {link.label === "Live Demo" ? "✦ " + link.label : link.label}
                  </Link>
                ))}
              </div>
            </div>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-600 mb-4">Specialties</p>
              <div className="flex flex-col gap-3">
                {specialtyLinks.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="text-[14px] text-gray-500 hover:text-white transition-colors duration-200"
                    data-testid={`footer-link-${link.label.toLowerCase().replace(/\s/g, "-").replace(/[^a-z0-9-]/g, "")}`}
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            </div>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-600 mb-4">Legal & Compliance</p>
              <div className="flex flex-col gap-3">
                {legalLinks.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="text-[14px] text-gray-500 hover:text-white transition-colors duration-200"
                    data-testid={`footer-link-${link.label.toLowerCase().replace(/\s/g, "-")}`}
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-12 pt-8 border-t border-white/[0.06] flex flex-col sm:flex-row items-center justify-between gap-3">
          <span className="text-[12px] text-gray-600">
            &copy; {new Date().getFullYear()} Halo Note. All rights reserved.
          </span>
          <span className="text-[12px] text-gray-600">
            HIPAA-ready · End-to-end encrypted · Physician controlled
          </span>
        </div>
      </div>
    </footer>
  );
}
