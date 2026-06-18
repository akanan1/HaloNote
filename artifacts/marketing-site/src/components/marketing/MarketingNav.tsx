import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Menu, X, ArrowRight } from "lucide-react";
import { HaloNoteLogoIcon, HaloNoteWordmarkSimple } from "@/components/HaloNoteLogo";
import { Button } from "@/components/ui/button";

const navLinks = [
  { label: "Product", href: "/product" },
  { label: "Demo", href: "/demo" },
  { label: "Pricing", href: "/pricing" },
  { label: "Security", href: "/security" },
  { label: "About", href: "/about" },
];

interface MarketingNavProps {
  darkHero?: boolean;
}

export default function MarketingNav({ darkHero = false }: MarketingNavProps) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [location] = useLocation();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const transparent = darkHero && !scrolled;

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-500 ${
        transparent
          ? "bg-transparent border-b border-transparent"
          : "bg-white/95 backdrop-blur-xl shadow-[0_1px_0_rgba(0,0,0,0.06)] border-b border-gray-100"
      }`}
      data-testid="marketing-nav"
    >
      <div className="max-w-7xl mx-auto px-5 sm:px-8 lg:px-10">
        <div className="flex items-center justify-between h-[68px]">
          <Link href="/" className="flex items-center gap-2.5 group" data-testid="link-home">
            {/* On the dark hero: brand-blue tile (Bluerocratic #2663EB).
                Once scrolled past the hero into the light sections:
                black tile (matches the all-black monochrome variant
                in the brand kit, File-04). White V mark stays put;
                only the tile fill flips. */}
            <HaloNoteLogoIcon
              size={34}
              color={transparent ? "#2663EB" : "#000000"}
            />
            <HaloNoteWordmarkSimple
              fontSize={17}
              color={transparent ? "#ffffff" : "#0a0a0a"}
            />
          </Link>

          <div className="hidden md:flex items-center gap-1">
            {navLinks.map((link) => (
              link.label === "Demo" ? (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`relative px-4 py-2 text-[14px] font-semibold transition-all duration-300 rounded-full border ${
                    location === link.href
                      ? transparent
                        ? "text-white bg-blue-500/20 border-blue-400/40"
                        : "text-blue-700 bg-blue-50 border-blue-200"
                      : transparent
                        ? "text-blue-300 hover:text-white hover:bg-blue-500/20 border-blue-400/30"
                        : "text-blue-600 hover:text-blue-700 hover:bg-blue-50 border-blue-200/60"
                  }`}
                  data-testid="link-demo"
                >
                  ✦ Demo
                </Link>
              ) : (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`relative px-4 py-2 text-[14px] font-medium transition-all duration-300 rounded-full ${
                    location === link.href
                      ? transparent
                        ? "text-white bg-white/10"
                        : "text-black bg-black/[0.05]"
                      : transparent
                        ? "text-white/70 hover:text-white hover:bg-white/10"
                        : "text-gray-600 hover:text-gray-900 hover:bg-gray-100/60"
                  }`}
                  data-testid={`link-${link.label.toLowerCase().replace(/\s/g, "-")}`}
                >
                  {link.label}
                </Link>
              )
            ))}
            <div className="ml-3">
              <Link href="/login">
                <Button
                  size="sm"
                  className={`font-medium px-5 h-9 text-[13px] rounded-full transition-all duration-300 gap-1.5 ${
                    transparent
                      ? "bg-white text-black hover:bg-gray-100 shadow-sm"
                      : "bg-black text-white hover:bg-gray-900 shadow-sm hover:shadow-md"
                  }`}
                  data-testid="button-open-app"
                >
                  Open App
                  <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              </Link>
            </div>
          </div>

          <button
            className={`md:hidden p-2 rounded-full transition-colors ${
              transparent ? "text-white hover:bg-white/10" : "text-gray-700 hover:bg-gray-100"
            }`}
            onClick={() => setOpen(!open)}
            data-testid="button-mobile-menu"
            aria-label="Toggle menu"
          >
            {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="md:hidden bg-white/98 backdrop-blur-xl border-t border-gray-100 px-5 pb-5 pt-2 shadow-lg"
          style={{ animation: "slideDown 0.22s cubic-bezier(0.16,1,0.3,1) both" }}>
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`flex items-center justify-between py-3.5 text-[15px] font-medium border-b border-gray-100 transition-colors ${
                location === link.href ? "text-black" : "text-gray-600"
              }`}
              onClick={() => setOpen(false)}
              data-testid={`link-mobile-${link.label.toLowerCase().replace(/\s/g, "-")}`}
            >
              {link.label}
              {location === link.href && <span className="w-1.5 h-1.5 rounded-full bg-black" />}
            </Link>
          ))}
          <Link href="/login" onClick={() => setOpen(false)}>
            <Button
              size="sm"
              className="w-full mt-4 bg-black hover:bg-gray-900 text-white font-semibold h-11 rounded-full"
              data-testid="button-mobile-open-app"
            >
              Open App
              <ArrowRight className="w-4 h-4 ml-1.5" />
            </Button>
          </Link>
        </div>
      )}
    </nav>
  );
}
