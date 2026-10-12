import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFiles, renderMarkdown, scanRepo } from "../examples/useful-agent/dossier.js";

let root: string;
const put = (f: string, s: string) => { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), s); };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "dossier-test-"));
  put("Anchor.toml", '[toolchain]\nanchor_version = "0.30.1"\n');
  put("Cargo.toml", '[workspace]\n[profile.release]\noverflow-checks = true\n');
  put("programs/vault/Cargo.toml", '[dependencies]\nanchor-lang = { version = "0.30.1", features = ["init-if-needed"] }\n');
  put("programs/vault/src/lib.rs", [
    'declare_id!("E3XAx7qEKHte9kmWKhuyAVxb8CgE2g4k5FqkrRx2kdsF");',
    "pub struct Deposit<'info> {",
    "    /// CHECK: owner checked in handler",
    "    pub vault: UncheckedAccount<'info>,",
    "    #[account(init_if_needed, payer = user, space = 8)]",
    "    pub state: Account<'info, State>,",
    "}",
    "fn h(ctx: Context<Deposit>) { let x = ctx.remaining_accounts[0].key; let y = amount as u32; foo().unwrap(); }",
    "// foo().unwrap() in a comment is ignored",
  ].join("\n"));
  put("programs/vault/tests/t.rs", "fn t() { a().unwrap(); }\n");
  put("node_modules/x/lib.rs", "unsafe { }\n");
  put("LICENSE", "MIT");
  put(".github/workflows/ci.yml", "on: push");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("useful-agent dossier", () => {
  it("skips build output and vendored dirs", () => {
    expect(listFiles(root).some((f) => f.startsWith("node_modules"))).toBe(false);
  });

  it("extracts Anchor facts, program ids and hygiene", () => {
    const d = scanRepo(root, "https://github.com/x/y", "a".repeat(40));
    expect(d.anchor).toMatchObject({ anchorToml: true, anchorVersion: "0.30.1", anchorLang: ["0.30.1"] });
    expect(d.programIds).toEqual([{ id: "E3XAx7qEKHte9kmWKhuyAVxb8CgE2g4k5FqkrRx2kdsF", file: "programs/vault/src/lib.rs:1" }]);
    expect(d.hygiene).toMatchObject({ license: true, securityPolicy: false, overflowChecksInRelease: true, ciWorkflows: 1, checkComments: 1 });
  });

  it("counts review pointers in program code only, ignoring tests and comments", () => {
    const d = scanRepo(root, "r", "c");
    const n = Object.fromEntries(d.patterns.map((p) => [p.id, p.hits.length]));
    expect(n).toMatchObject({ "unchecked-account": 1, "init-if-needed": 1, "remaining-accounts": 1, unwrap: 1, "raw-arith": 1, unsafe: 0 });
    expect(d.patterns.find((p) => p.id === "unwrap")!.hits).toEqual([{ file: "programs/vault/src/lib.rs", line: 8 }]);
  });

  it("renders deterministically and states it is not an audit", () => {
    const d = { ...scanRepo(root, "r", "b".repeat(40)), onChain: [{ programId: "E3XAx7qEKHte9kmWKhuyAVxb8CgE2g4k5FqkrRx2kdsF", state: "upgradeable" as const, authority: "HBZPPQpw" }] };
    const md = renderMarkdown(d);
    expect(md).toBe(renderMarkdown(d));
    expect(md).toContain("**Not a security audit**");
    expect(md).toContain("upgradeable, upgrade authority `HBZPPQpw`");
    expect(md).toContain(`Commit \`${"b".repeat(40)}\``);
  });
});
