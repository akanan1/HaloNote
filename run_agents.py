from pathlib import Path
from openai import OpenAI
from dotenv import load_dotenv
import os

load_dotenv()

MODEL = "gpt-4.1-mini"
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

ROOT = Path(__file__).parent
AGENTS = ROOT / "agents"
REPORTS = ROOT / "agent_reports"
REPORTS.mkdir(exist_ok=True)

# ----------------------------------------------------------------------------
# Modular context pipeline.
#
# Previously a single `collect_context()` walked the whole repo, applied a
# handful of directory excludes, and shipped the same 250k-char blob to every
# specialist agent. That blob was dominated by Drizzle migration snapshots,
# generated TS clients, dist/ bundles, and tests the agent didn't need —
# which crowded out the actual code the agent was supposed to reason about
# and made truncation order non-deterministic.
#
# The replacement:
#   1. discover() walks once, classifies each file into one DOMAIN, and
#      drops anything that's noise (size limits, path exclusions).
#   2. AGENT_PROFILES names which domains + optional path-substring filters
#      each agent receives.
#   3. collect_context_for() picks files for a specific agent and renders
#      them in deterministic (path-sorted) order under a budget.
# ----------------------------------------------------------------------------

# Any path containing one of these segments is skipped. Covers vendored
# code, build output, codegen output, caches, and the reports directory
# we're writing into.
EXCLUDE_DIRS = {
    "node_modules", ".git", ".next", "__pycache__",
    "agent_reports", "dist", "build", "coverage",
    ".cache", ".turbo", ".vite", "generated",
    "migrations",  # SQL + meta snapshots — internal bookkeeping
}

# Files we never include regardless of suffix.
EXCLUDE_FILES = {
    "pnpm-lock.yaml", "package-lock.json", "yarn.lock",
    ".env", ".env.local", ".env.production",
}

# Suffixes that are always build / generated artifacts.
EXCLUDE_SUFFIXES = (
    ".d.ts", ".d.ts.map", ".map",
    ".min.js", ".bundle.js",
    ".lock", ".lockb",
)

# Files larger than this are skipped entirely. The agent gains nothing
# from a partial read of a 200 KB fixture; truncating mid-file just
# wastes tokens on context the agent can't act on.
MAX_FILE_BYTES = 50_000

# Per-file char cap for rendering. Files exceeding this are truncated
# with a footer so the agent knows it didn't see the whole thing.
PER_FILE_CHAR_CAP = 12_000

# Only these specific *.json filenames carry signal; every other JSON in
# the repo is a fixture, snapshot, or lockfile.
CONFIG_JSON_NAMES = {
    "package.json", "tsconfig.json", "tsconfig.base.json",
    "pnpm-workspace.yaml",
}

# *.config.* files + a few well-known build/config entrypoints. Names,
# not suffixes, because the patterns are exact.
CONFIG_NAMES = CONFIG_JSON_NAMES | {
    "Dockerfile", "drizzle.config.ts", "orval.config.ts",
    "vitest.config.ts", "vitest.integration.config.ts",
    "playwright.config.ts", "build.mjs", ".env.example",
}

TEST_SUFFIXES = (
    ".test.ts", ".test.tsx",
    ".integration.test.ts", ".spec.ts",
)

# Heuristic: anything under these path prefixes is browser-side code.
FRONTEND_PREFIXES = (
    "artifacts/provider-app/",
    "artifacts/mockup-sandbox/",
)


def classify(rel: Path) -> str | None:
    """Return the domain bucket for a file, or None to skip it.

    Domains are mutually exclusive — a file lives in exactly one bucket.
    Order matters: tests are checked before backend/frontend because
    `*.test.ts` would otherwise be miscategorised as source.
    """
    name = rel.name
    posix = rel.as_posix()
    suffix = rel.suffix

    # Config first — package.json must not fall into the generic JSON
    # bucket below.
    if (
        name in CONFIG_NAMES
        or name.endswith(".config.ts")
        or name.endswith(".config.js")
        or name.endswith(".config.mjs")
    ):
        return "config"

    if name.endswith(TEST_SUFFIXES):
        return "tests"

    if suffix == ".md":
        return "docs"

    if suffix == ".py":
        return "backend"

    if suffix in (".ts", ".tsx"):
        if any(posix.startswith(p) for p in FRONTEND_PREFIXES):
            return "frontend"
        return "backend"

    # Any other .json got past the config check above → noise.
    return None


def _is_excluded(rel: Path) -> bool:
    if set(rel.parts) & EXCLUDE_DIRS:
        return True
    if rel.name in EXCLUDE_FILES:
        return True
    if rel.name.endswith(EXCLUDE_SUFFIXES):
        return True
    return False


def discover() -> list[tuple[Path, str]]:
    """Walk the repo once. Return sorted [(rel_path, domain), ...]."""
    out: list[tuple[Path, str]] = []
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(ROOT)
        if _is_excluded(rel):
            continue
        domain = classify(rel)
        if domain is None:
            continue
        try:
            if path.stat().st_size > MAX_FILE_BYTES:
                continue
        except OSError:
            continue
        out.append((rel, domain))
    out.sort(key=lambda t: t[0].as_posix())
    return out


# ---- Per-agent profiles ---------------------------------------------------
#
# Each profile says which domains the agent receives, an optional list of
# substring filters applied to the lowercased posix path (file is kept only
# if it matches AT LEAST ONE marker), and a char budget for the assembled
# context. Filters are intentionally lenient — agents are instructed to flag
# missing evidence rather than invent, so over-filtering is the worse
# failure mode.
#
# Agents not listed here (chief-of-staff, implementation-planner) receive
# no codebase context — they aggregate other reports.

AGENT_PROFILES: dict[str, dict] = {
    "02_jackson_architect.md": {
        "domains": {"backend", "frontend", "config"},
        "path_filter": None,
        "budget_chars": 180_000,
    },
    "03_sophia_security.md": {
        "domains": {"backend", "config"},
        "path_filter": [
            "auth", "csrf", "session", "token", "rate-limit",
            "middleware", "logger", "ehr-oauth", "encrypt", "crypto",
            "helmet", "cors", "admin", "totp", "password",
        ],
        "budget_chars": 180_000,
    },
    "04_oliver_ehr.md": {
        "domains": {"backend"},
        "path_filter": [
            "ehr", "fhir", "oauth", "athena", "epic",
            "schema/ehr", "smart", "document-reference",
            "patient", "practitioner",
        ],
        "budget_chars": 180_000,
    },
    "05_chloe_qa.md": {
        "domains": {"tests", "config"},
        "path_filter": None,
        "budget_chars": 180_000,
    },
}


def collect_context_for(
    agent_file: str,
    files: list[tuple[Path, str]],
) -> str:
    profile = AGENT_PROFILES.get(agent_file)
    if profile is None:
        return ""

    filters: list[str] | None = profile["path_filter"]
    domains: set[str] = profile["domains"]
    budget: int = profile["budget_chars"]

    parts: list[str] = []
    used = 0
    for rel, domain in files:
        if domain not in domains:
            continue
        if filters is not None:
            posix_lower = rel.as_posix().lower()
            if not any(marker in posix_lower for marker in filters):
                continue
        try:
            text = (ROOT / rel).read_text(errors="ignore")
        except OSError:
            continue
        if len(text) > PER_FILE_CHAR_CAP:
            text = text[:PER_FILE_CHAR_CAP] + "\n...[truncated]"
        chunk = f"\n\n--- FILE: {rel.as_posix()} ---\n{text}"
        if used + len(chunk) > budget:
            break
        parts.append(chunk)
        used += len(chunk)
    return "".join(parts)


def ask_ai(prompt: str) -> str:
    response = client.responses.create(model=MODEL, input=prompt)
    return response.output_text


# Discovery is expensive (filesystem walk + stat on every file). Cache it
# across the 4 specialist agent calls in the same run.
_files_cache: list[tuple[Path, str]] | None = None


def all_files() -> list[tuple[Path, str]]:
    global _files_cache
    if _files_cache is None:
        _files_cache = discover()
    return _files_cache


def run_agent(agent_file: str, output_file: str) -> None:
    print(f"Running {agent_file}...")
    agent_prompt = (AGENTS / agent_file).read_text(errors="ignore")
    context = collect_context_for(agent_file, all_files())

    prompt = f"""
{agent_prompt}

Rules:
- Do not invent files.
- Cite exact files when possible.
- If evidence is missing, say so.
- Prioritize Halo Note execution, not generic advice.
- Be direct and brutal.

Codebase context:
{context}
"""
    output = ask_ai(prompt)
    (REPORTS / output_file).write_text(output, errors="ignore")
    print(f"Saved {output_file}  (context: {len(context):,} chars)")


run_agent("02_jackson_architect.md", "architect_report.md")
run_agent("03_sophia_security.md", "security_report.md")
run_agent("04_oliver_ehr.md", "ehr_report.md")
run_agent("05_chloe_qa.md", "qa_report.md")

# Chief-of-staff and planner only read the other agents' reports.
# Their flow is unchanged from before.

print("Running Emma Chief of Staff...")

reports = ""
for file in ["architect_report.md", "security_report.md", "ehr_report.md", "qa_report.md"]:
    path = REPORTS / file
    if path.exists():
        reports += f"\n\n--- {file} ---\n"
        reports += path.read_text(errors="ignore")[:12000]

chief_prompt = (AGENTS / "01_emma_chief_of_staff.md").read_text(errors="ignore")

daily_brief = ask_ai(f"""
{chief_prompt}

Agent reports:
{reports}
""")

(REPORTS / "daily_brief.md").write_text(daily_brief, errors="ignore")

print("Running Mia Implementation Planner...")

mia_prompt = (AGENTS / "06_mia_implementation_planner.md").read_text(errors="ignore")

mia_context = ""
for file in [
    "daily_brief.md",
    "security_report.md",
    "ehr_report.md",
    "architect_report.md",
    "qa_report.md",
]:
    path = REPORTS / file
    if path.exists():
        mia_context += f"\n\n--- {file} ---\n"
        mia_context += path.read_text(errors="ignore")[:12000]

implementation_plan = ask_ai(f"""
{mia_prompt}

Agent findings:
{mia_context}
""")

(REPORTS / "implementation_plan.md").write_text(implementation_plan, errors="ignore")

print("Done. Open agent_reports/daily_brief.md and agent_reports/implementation_plan.md")
