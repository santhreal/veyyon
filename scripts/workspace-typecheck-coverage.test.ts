/**
 * Every workspace package is actually covered by the workspace typecheck.
 *
 * WHY THIS SUITE EXISTS. The root gate is
 * `check:ts` = `bun run --workspaces --if-present check:types`, and `--if-present`
 * means a package with no `check:types` script is skipped in silence. So a
 * package opts out of type checking by omission, and the gate still reports
 * success: the run prints a green line per package that HAS the script and says
 * nothing at all about the ones that do not. Absence reads as coverage.
 *
 * That is not hypothetical. `@veyyon/deepswe-bench` had no `check:types`, and a
 * full `bun run check:ts` listed 17 green workspaces without it. When the script
 * was finally added (2026-07-24) it immediately surfaced two real errors in
 * `run.ts`: three hand-written copies of the blank `ArmResult` had drifted, and
 * the reaggregate error path was dropping `argotHandlesLoaded` and
 * `encodeHeadroom`, the two fields that make a zero-encode bench run
 * interpretable. Those had been shipping unnoticed.
 *
 * This is the same class of defect the codebase bans elsewhere: a mechanism that
 * quietly does nothing when its input is missing, instead of failing loudly.
 * Locking it here means a new package cannot join the tree already exempt from
 * the typecheck.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGES_DIR = join(REPO_ROOT, "packages");

interface WorkspacePackage {
	readonly dir: string;
	readonly name: string;
	readonly scripts: Record<string, string>;
}

function readWorkspacePackages(): WorkspacePackage[] {
	const out: WorkspacePackage[] = [];
	for (const entry of readdirSync(PACKAGES_DIR)) {
		const manifest = join(PACKAGES_DIR, entry, "package.json");
		try {
			if (!statSync(manifest).isFile()) continue;
		} catch {
			continue;
		}
		const parsed = JSON.parse(readFileSync(manifest, "utf8"));
		out.push({ dir: entry, name: parsed.name ?? entry, scripts: parsed.scripts ?? {} });
	}
	return out;
}

describe("the workspace typecheck covers every package", () => {
	/** The suite is only meaningful if it found the packages at all; an empty
	 * listing would make every assertion below vacuously true. */
	it("finds the workspace packages", () => {
		expect(readWorkspacePackages().length).toBeGreaterThan(10);
	});

	/**
	 * THE contract. `--if-present` skips a package with no `check:types` and says
	 * nothing, so the only way to know a package is checked is to require the
	 * script exists.
	 */
	it("gives every package a check:types script", () => {
		const missing = readWorkspacePackages()
			.filter(pkg => !pkg.scripts["check:types"])
			.map(pkg => `packages/${pkg.dir} (${pkg.name})`);
		expect(
			missing,
			"these declare no check:types, so `bun run check:ts` skips them with --if-present and " +
				"still reports success; add check:types (tsgo -p tsconfig.json --noEmit) and a tsconfig",
		).toEqual([]);
	});

	/**
	 * A `check:types` that does not invoke the type checker would satisfy the test
	 * above while checking nothing, which is the same silent-skip defect wearing
	 * the script name.
	 */
	it("points every check:types at the type checker", () => {
		const bogus = readWorkspacePackages()
			.filter(pkg => {
				const script = pkg.scripts["check:types"];
				return script !== undefined && !script.includes("tsgo") && !script.includes("tsc");
			})
			.map(pkg => `packages/${pkg.dir}: ${pkg.scripts["check:types"]}`);
		expect(bogus, "these name a check:types script that never runs a type checker").toEqual([]);
	});

	/**
	 * The root gate must keep fanning out to the workspaces. Rewriting `check:ts`
	 * to check one package, or to run nothing, would leave every assertion above
	 * true while the gate stopped covering the tree.
	 */
	it("keeps check:ts fanning out across the workspaces", () => {
		const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
		const checkTs: string = root.scripts["check:ts"];
		expect(checkTs).toContain("--workspaces");
		expect(checkTs).toContain("check:types");
	});
});

/**
 * Repo-level test suites are only coverage if some runner runs them.
 *
 * `repoScriptTests` in `ci-test-ts.ts` is a hand-maintained list, and drift
 * showed up in both directions. Outward: 13 suites existed on disk that NO
 * runner referenced, including all seven installer-parity checks, so 155
 * passing assertions about the install flow, the product surface the dogfooding
 * doctrine says to judge, never ran in CI. Inward: the file's own comment
 * records a listed `ci-test-ts.test.ts` that never existed, which bun ignores in
 * silence whenever at least one other filter matches.
 *
 * Both directions fail loudly now.
 */
const REPO_SCRIPT_TESTS = (() => {
	const source = readFileSync(join(REPO_ROOT, "scripts/ci-test-ts.ts"), "utf8");
	const block = /const repoScriptTests = \[(.*?)\];/s.exec(source);
	return block ? [...block[1].matchAll(/"([^"]+)"/g)].map(match => match[1] as string) : [];
})();

/** Every place a repo-level suite can legitimately be run from. */
function otherRunnerSources(): string {
	const parts = [readFileSync(join(REPO_ROOT, "package.json"), "utf8")];
	const workflows = join(REPO_ROOT, ".github", "workflows");
	try {
		for (const entry of readdirSync(workflows)) parts.push(readFileSync(join(workflows, entry), "utf8"));
	} catch {
		// No workflows directory in a source checkout without CI config.
	}
	return parts.join("\n");
}

describe("every repo-level test suite is actually run by something", () => {
	/** Guards the parse above: an empty list would make the checks vacuous. */
	it("parses the repoScriptTests list", () => {
		expect(REPO_SCRIPT_TESTS.length).toBeGreaterThan(10);
	});

	/** Inward drift. bun silently ignores an unmatched filter when another filter
	 * matches, so a listed-but-deleted file looks exactly like a passing suite. */
	it("lists no suite that has been deleted", () => {
		const missing = REPO_SCRIPT_TESTS.filter(rel => {
			try {
				return !statSync(join(REPO_ROOT, rel)).isFile();
			} catch {
				return true;
			}
		});
		expect(missing, "these are listed in repoScriptTests but do not exist; bun ignores them silently").toEqual([]);
	});

	/**
	 * Suites deliberately not wired yet, each with the reason it is not.
	 *
	 * An exception belongs here, in the open, rather than as an absence nobody can
	 * see. That is the whole point of the check: silence was the defect.
	 */
	const KNOWN_UNRUN = new Map<string, string>([
		[
			// The committed root CHANGELOG.md does not match a fresh render, and the
			// mismatch is a real generator scope bug, not stale output: the root sync
			// reads ONLY packages/coding-agent/CHANGELOG.md, so every fix recorded in
			// another package's changelog vanishes on regeneration. A collab-web IME
			// fix was hand-added to the root in 07975344 for exactly that reason.
			// Wiring this suite before the scope is settled would make CI red on an
			// unresolved content question. Tracked as CHANGELOG-ROOT-SYNC-SCOPE.
			"scripts/sync-root-changelog.test.ts",
			"CHANGELOG-ROOT-SYNC-SCOPE: root sync reads only coding-agent, dropping other packages' entries",
		],
	]);

	/** Outward drift. A suite referenced by nothing runs nowhere, and its green
	 * assertions are decoration. */
	it("leaves no scripts/*.test.ts unreferenced by any runner", () => {
		const others = otherRunnerSources();
		const unreferenced = readdirSync(join(REPO_ROOT, "scripts"))
			.filter(name => name.endsWith(".test.ts"))
			.map(name => `scripts/${name}`)
			.filter(rel => !REPO_SCRIPT_TESTS.includes(rel) && !others.includes(rel) && !KNOWN_UNRUN.has(rel));
		expect(
			unreferenced,
			"these suites are run by nothing: not repoScriptTests, not a workflow, not a root script. " +
				"Add each to repoScriptTests or a workflow, or delete it; a suite nobody runs is not coverage",
		).toEqual([]);
	});
});
