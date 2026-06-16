// Refuses to boot when NODE_ENV=production has been combined with EHR
// configuration that looks like the sandbox/preview environment. Catches
// the deploy-time foot-gun where the wrong .env is shipped to prod and
// the app would otherwise happily push real notes to a sandbox or — worse
// — fail open in mock mode against a real practice.

const SANDBOX_HOSTS = [
  "preview.platform.athenahealth.com",
  "sandbox.platform.athenahealth.com",
];

const REAL_PROVIDERS = new Set(["athenahealth", "epic", "cerner"]);

export function validateEhrProductionConfig(env: NodeJS.ProcessEnv): void {
  if (env["NODE_ENV"] !== "production") return;

  const mode = env["EHR_MODE"]?.trim().toLowerCase();
  if (!mode) {
    throw new Error(
      "EHR_MODE must be set explicitly in production (e.g. 'athenahealth'). " +
        "Refusing to boot in implicit-mock mode.",
    );
  }
  if (!REAL_PROVIDERS.has(mode)) {
    throw new Error(
      `EHR_MODE="${mode}" is not a real provider. ` +
        "Production deploys must target a real EHR; refusing to boot.",
    );
  }

  if (mode === "athenahealth") {
    const fhirBase = env["ATHENA_FHIR_BASE_URL"] ?? "";
    const tokenUrl = env["ATHENA_TOKEN_URL"] ?? "";
    for (const host of SANDBOX_HOSTS) {
      if (fhirBase.includes(host) || tokenUrl.includes(host)) {
        throw new Error(
          `ATHENA endpoint points at sandbox host "${host}" while ` +
            "NODE_ENV=production. Refusing to boot to prevent pushing " +
            "real notes to a sandbox.",
        );
      }
    }
    const redirect = env["ATHENA_REDIRECT_URI"] ?? "";
    if (redirect.startsWith("http://") && !redirect.includes("localhost")) {
      throw new Error(
        "ATHENA_REDIRECT_URI must be https:// in production " +
          "(SMART on FHIR requires it and Athena will reject http://).",
      );
    }
  }
}
