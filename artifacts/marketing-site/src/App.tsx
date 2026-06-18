import { Route, Switch } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";

import LandingPage from "@/pages/marketing/LandingPage";
import ProductPage from "@/pages/marketing/ProductPage";
import DemoPage from "@/pages/marketing/DemoPage";
import PricingPage from "@/pages/marketing/PricingPage";
import SecurityPage from "@/pages/marketing/SecurityPage";
import AboutPage from "@/pages/marketing/AboutPage";
import RequestAccessPage from "@/pages/marketing/RequestAccessPage";
import SpecialtyPage from "@/pages/marketing/SpecialtyPage";

import PrivacyPolicyPage from "@/pages/legal/PrivacyPolicyPage";
import TermsOfServicePage from "@/pages/legal/TermsOfServicePage";
import HipaaNoticePage from "@/pages/legal/HipaaNoticePage";
import BAAPage from "@/pages/legal/BAAPage";
import DataRightsPage from "@/pages/legal/DataRightsPage";

// All routes mirror the live Replit project's wouter routing.
// Specialty pages share one component and read the slug from the URL.

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Switch>
        <Route path="/" component={LandingPage} />
        <Route path="/product" component={ProductPage} />
        <Route path="/demo" component={DemoPage} />
        <Route path="/pricing" component={PricingPage} />
        <Route path="/security" component={SecurityPage} />
        <Route path="/about" component={AboutPage} />
        <Route path="/request-access" component={RequestAccessPage} />
        <Route path="/specialties/:slug">
          {(params) => {
            const valid = ["primary-care", "cardiology", "psychiatry"] as const;
            type Slug = (typeof valid)[number];
            const slug = params.slug as Slug;
            if (!valid.includes(slug)) return <LandingPage />;
            return <SpecialtyPage specialty={slug} />;
          }}
        </Route>

        <Route path="/privacy" component={PrivacyPolicyPage} />
        <Route path="/terms" component={TermsOfServicePage} />
        <Route path="/hipaa-notice" component={HipaaNoticePage} />
        <Route path="/baa" component={BAAPage} />
        <Route path="/data-rights" component={DataRightsPage} />

        {/* Unknown route → landing. */}
        <Route>
          <LandingPage />
        </Route>
      </Switch>
      <Toaster />
    </QueryClientProvider>
  );
}
