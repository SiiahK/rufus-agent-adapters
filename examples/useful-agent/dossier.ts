/**
 * Technical dossier of a Solana repository: static facts and review pointers, deterministic for a given commit
 * (no timestamps), so the same job always hashes to the same bytes. Not a security audit: it lists where a human
 * reviewer should look, it does not certify anything.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", "build", ".anchor", "coverage", "vendor"]);
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 1_000_000;
const SAMPLES = 5;
const ANCHOR_PLACEHOLDER_ID = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS";

export interface Hit { file: string; line: number }
export interface Pattern { id: string; title: string; why: string; hits: Hit[] }
export interface OnChainProgram { programId: string; state: "upgradeable" | "immutable" | "not_found" | "not_a_program" | "unchecked"; authority?: string | null }

export interface Dossier {
  repo: string; commit: string; files: number; byExtension: Record<string, number>; rustLines: number;
  anchor: { anchorToml: boolean; anchorVersion: string | null; anchorLang: string[]; solanaProgram: string[] };
  programIds: { id: string; file: string }[];
  hygiene: Record<string, boolean | number>;
  patterns: Pattern[];
  onChain: OnChainProgram[];
}

/** Files of the clone, sorted, skipping build output and vendored code. */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (out.length >= MAX_FILES) return;
      const p = join(dir, name);
      const s = statSync(p, { throwIfNoEntry: false });
      if (!s) continue;
      if (s.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(p); }
      else if (s.isFile() && s.size <= MAX_FILE_BYTES) out.push(relative(root, p));
    }
  };
  walk(root);
  return out;
}

const RISK_PATTERNS: { id: string; title: string; why: string; re: RegExp }[] = [
  { id: "unchecked-account", title: "Unchecked accounts (`UncheckedAccount` / raw `AccountInfo`)", why: "Anchor does not validate owner or type; each one needs a `/// CHECK:` reason and manual checks.", re: /\bUncheckedAccount<|:\s*AccountInfo<'info>/ },
  { id: "init-if-needed", title: "`init_if_needed`", why: "Can let an existing account be re-used or re-initialized; check every field is validated.", re: /\binit_if_needed\b/ },
  { id: "remaining-accounts", title: "`remaining_accounts`", why: "Not validated by Anchor; owner, signer and address checks must be manual.", re: /\bremaining_accounts\b/ },
  { id: "cpi", title: "Cross-program invocations (`invoke` / `invoke_signed` / `CpiContext`)", why: "Check the target program id is pinned and signer seeds cannot be forged.", re: /\binvoke(_signed)?\s*\(|CpiContext::new/ },
  { id: "unwrap", title: "`unwrap()` / `expect()` in program code", why: "A panic aborts the instruction with an opaque error; prefer typed errors.", re: /\.unwrap\(\)|\.expect\(/ },
  { id: "unsafe", title: "`unsafe` blocks", why: "Memory-safety guarantees are off; needs line-by-line review.", re: /\bunsafe\s*\{/ },
  { id: "realloc", title: "Account `realloc`", why: "Check payer, zero-init and size limits.", re: /\brealloc\b/ },
  { id: "raw-arith", title: "Unchecked `as` casts to narrower integers", why: "Silent truncation; prefer `try_into()`.", re: /\bas\s+(u8|u16|u32|i8|i16|i32)\b/ },
];

const isProgramSource = (f: string) => f.endsWith(".rs") && !/(^|\/)(tests?|benches|examples|fuzz)\//.test(f) && !f.endsWith("_test.rs");

/** Scans a checked-out repository. `read` is injectable for tests. */
export function scanRepo(root: string, repo: string, commit: string, read: (f: string) => string = (f) => readFileSync(join(root, f), "utf-8")): Omit<Dossier, "onChain"> {
  const files = listFiles(root);
  const byExtension: Record<string, number> = {};
  for (const f of files) {
    const ext = f.includes(".") ? f.slice(f.lastIndexOf(".")) : "(none)";
    byExtension[ext] = (byExtension[ext] ?? 0) + 1;
  }
  const anchor = { anchorToml: files.includes("Anchor.toml"), anchorVersion: null as string | null, anchorLang: [] as string[], solanaProgram: [] as string[] };
  if (anchor.anchorToml) anchor.anchorVersion = /anchor_version\s*=\s*"([^"]+)"/.exec(read("Anchor.toml"))?.[1] ?? null;
  const programIds: { id: string; file: string }[] = [];
  const patterns: Pattern[] = RISK_PATTERNS.map(({ id, title, why }) => ({ id, title, why, hits: [] }));
  let rustLines = 0, checkComments = 0, overflowChecks = false, cfgTest = 0;

  for (const f of files) {
    if (f.endsWith("Cargo.toml")) {
      const t = read(f);
      for (const m of t.matchAll(/^anchor-lang\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/gm)) anchor.anchorLang.push(m[1] ?? m[2]);
      for (const m of t.matchAll(/^solana-program\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/gm)) anchor.solanaProgram.push(m[1] ?? m[2]);
      if (/\[profile\.release\][^[]*overflow-checks\s*=\s*true/.test(t)) overflowChecks = true;
    }
    if (!f.endsWith(".rs")) continue;
    const lines = read(f).split("\n");
    rustLines += lines.length;
    lines.forEach((l, i) => {
      const id = /declare_id!\s*\(\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"\s*\)/.exec(l)?.[1];
      if (id && !programIds.some((p) => p.id === id)) programIds.push({ id, file: `${f}:${i + 1}` });
      if (/\/\/\/\s*CHECK:/.test(l)) checkComments++;
      if (/#\[cfg\(test\)\]/.test(l)) cfgTest++;
      if (!isProgramSource(f) || /^\s*\/\//.test(l)) return;
      RISK_PATTERNS.forEach((p, k) => { if (p.re.test(l)) patterns[k].hits.push({ file: f, line: i + 1 }); });
    });
  }
  const has = (re: RegExp) => files.some((f) => re.test(f));
  const hygiene = {
    license: has(/^LICENSE/i), securityPolicy: has(/(^|\/)SECURITY\.md$/i), auditReports: has(/audit/i),
    pinnedRustToolchain: has(/^rust-toolchain(\.toml)?$/), overflowChecksInRelease: overflowChecks,
    ciWorkflows: files.filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f)).length,
    testFiles: files.filter((f) => /(^|\/)tests?\/|\.(test|spec)\.[jt]s$/.test(f)).length, rustTestModules: cfgTest,
    lockfiles: files.filter((f) => /(^|\/)(Cargo\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f)).length,
    checkComments,
  };
  anchor.anchorLang = [...new Set(anchor.anchorLang)].sort();
  anchor.solanaProgram = [...new Set(anchor.solanaProgram)].sort();
  return { repo, commit, files: files.length, byExtension, rustLines, anchor, programIds, hygiene, patterns };
}

const yes = (b: boolean | number) => (typeof b === "number" ? String(b) : b ? "yes" : "**no**");

export function renderMarkdown(d: Dossier): string {
  const L: string[] = [];
  L.push(`# Technical dossier: ${d.repo}`, "");
  L.push(`Commit \`${d.commit}\`. Automated static review by a Select service agent. **Not a security audit**: it points to code a reviewer should read; it does not certify the absence of bugs.`, "");
  L.push("## 1. Overview", "");
  const top = Object.entries(d.byExtension).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
  L.push(`- Files scanned: ${d.files}; Rust lines: ${d.rustLines}`, `- Top extensions: ${top.map(([e, n]) => `${e} ${n}`).join(", ") || "none"}`);
  L.push(`- Anchor workspace: ${d.anchor.anchorToml ? "yes" : "no"}${d.anchor.anchorVersion ? ` (anchor ${d.anchor.anchorVersion})` : ""}`);
  L.push(`- anchor-lang: ${d.anchor.anchorLang.join(", ") || "not used"}; solana-program: ${d.anchor.solanaProgram.join(", ") || "not a direct dependency"}`, "");
  L.push("## 2. Programs and on-chain state (mainnet)", "");
  if (!d.programIds.length) L.push("No `declare_id!` found.");
  for (const p of d.programIds) {
    const c = d.onChain.find((o) => o.programId === p.id);
    const state = !c || c.state === "unchecked" ? "not checked (no RPC)"
      : c.state === "upgradeable" ? `upgradeable, upgrade authority \`${c.authority}\``
      : c.state === "immutable" ? "immutable (no upgrade authority)" : c.state === "not_found" ? "not deployed on mainnet" : "account exists but is not a program";
    const placeholder = p.id === ANCHOR_PLACEHOLDER_ID ? " — Anchor's template id, not a real deployment" : "";
    L.push(`- \`${p.id}\` (${p.file}): ${state}${placeholder}`);
  }
  L.push("", "## 3. Engineering hygiene", "");
  const h = d.hygiene;
  L.push(`| Check | Result |`, `|---|---|`);
  for (const [k, label] of [["license", "License file"], ["securityPolicy", "SECURITY.md"], ["auditReports", "Audit reports in repo"], ["pinnedRustToolchain", "Pinned Rust toolchain"],
    ["overflowChecksInRelease", "`overflow-checks = true` in release profile"], ["ciWorkflows", "CI workflows"], ["testFiles", "Test files"], ["rustTestModules", "Rust `#[cfg(test)]` modules"],
    ["lockfiles", "Lockfiles"], ["checkComments", "`/// CHECK:` justifications"]] as const) L.push(`| ${label} | ${yes(h[k])} |`);
  L.push("", "## 4. Review pointers (program code, tests excluded)", "");
  for (const p of d.patterns) {
    L.push(`### ${p.title}: ${p.hits.length}`, "", p.why);
    for (const x of p.hits.slice(0, SAMPLES)) L.push(`- ${x.file}:${x.line}`);
    if (p.hits.length > SAMPLES) L.push(`- … ${p.hits.length - SAMPLES} more`);
    L.push("");
  }
  L.push("## 5. Limits", "", "Pattern counts are leads, not findings. No code was executed, no fuzzing, no economic or access-control review. A professional audit is still required before holding user funds.", "");
  return L.join("\n");
}
