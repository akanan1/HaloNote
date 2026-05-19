import { useState } from "react";
import { useLocation, Link } from "wouter";
import MarketingNav from "./MarketingNav";
import MarketingFooter from "./MarketingFooter";
import { X, ArrowRight } from "lucide-react";

interface Announcement {
  id: string;
  text: string;
  linkHref: string;
  linkLabel: string;
}

export default function MarketingLayout({
  children,
  darkHero = false,
  announcement,
}: {
  children: React.ReactNode;
  darkHero?: boolean;
  announcement?: Announcement | null;
}) {
  const [location] = useLocation();
  const [dismissed, setDismissed] = useState(() => {
    if (!announcement) return false;
    try { return localStorage.getItem(`ann_dismissed_${announcement.id}`) === "1"; }
    catch { return false; }
  });

  function dismiss() {
    setDismissed(true);
    if (announcement) {
      try { localStorage.setItem(`ann_dismissed_${announcement.id}`, "1"); } catch {}
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-white">
      {announcement && !dismissed && (
        <div className="relative z-50 flex items-center justify-center gap-3 px-4 py-2.5 text-[13px] font-medium"
          style={{ background: "linear-gradient(90deg, #1e293b 0%, #0f172a 100%)" }}>
          <span className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/20 border border-blue-400/30 text-blue-300 text-[11px] font-bold uppercase tracking-wider">
            New
          </span>
          <span className="text-gray-200">{announcement.text}</span>
          <Link
            href={announcement.linkHref}
            className="inline-flex items-center gap-1 text-blue-300 hover:text-blue-200 font-semibold transition-colors group flex-shrink-0"
          >
            {announcement.linkLabel}
            <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
          </Link>
          <button
            onClick={dismiss}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-white/40 hover:text-white/80 transition-colors rounded"
            aria-label="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      <MarketingNav darkHero={darkHero} />
      <main className="flex-1">
        <div key={location}>
          {children}
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}
