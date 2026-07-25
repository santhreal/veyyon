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
