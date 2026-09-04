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
 * That is not hypothetical. The DeepSWE bench had no `check:types` while it was its
 * own package, and a
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
 *
 * THE MEMBERS ARE DERIVED, NOT NAMED. This suite enumerated `packages/` literally, which reproduced the
 * very defect it exists to prevent as soon as a second root appeared. `contracts/*` is in the
 * workspace glob, so `--if-present` fans out to it, but nothing here required a contract to declare
 * `check:types` at all -- so a contract could opt out of type checking by omission with this suite
 * green. Literal members like `natives/bridge/bindings` and `python/veybot/web` were likewise
 * invisible to root globs. The members now come from `scripts/workspace-layout.ts`.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { runnerSources } from "./runner-references";
import { REPO_ROOT, typeScriptMembers } from "./workspace-layout";

interface WorkspacePackage {
	/** Repo-relative directory, so a failure names the root as well as the member. */
	readonly dir: string;
	readonly name: string;
	readonly scripts: Record<string, string>;
}

function readWorkspacePackages(): WorkspacePackage[] {
	const out: WorkspacePackage[] = [];
	for (const member of typeScriptMembers()) {
		const manifest = join(REPO_ROOT, member, "package.json");
		try {
			if (!statSync(manifest).isFile()) continue;
		} catch {
			continue;
		}
		const parsed = JSON.parse(readFileSync(manifest, "utf8"));
		out.push({ dir: member, name: parsed.name ?? member, scripts: parsed.scripts ?? {} });
	}
	return out;
}

describe("the workspace typecheck covers every package", () => {
	/** The suite is only meaningful if it found the packages at all; an empty
	 * listing would make every assertion below vacuously true. */
	it("finds the workspace packages under every declared root", () => {
		const packages = readWorkspacePackages();
		expect(packages.length).toBeGreaterThan(10);
		// A member outside `packages/`. The literal enumeration could not see one, so a contract was
		// free to ship with no `check:types` while this suite reported full coverage.
		expect(packages.map(pkg => pkg.dir)).toContain("contracts/wire");
		expect(packages.map(pkg => pkg.dir)).toContain("contracts/view");
	});

	/**
	 * THE contract. `--if-present` skips a package with no `check:types` and says
	 * nothing, so the only way to know a package is checked is to require the
	 * script exists.
	 */
	it("gives every package a check:types script", () => {
		const missing = readWorkspacePackages()
			.filter(pkg => !pkg.scripts["check:types"])
			.map(pkg => `${pkg.dir} (${pkg.name})`);
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
			.map(pkg => `${pkg.dir}: ${pkg.scripts["check:types"]}`);
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
 * `scripts/` is checked too, and it is the blind spot the suite above cannot see.
 *
 * The workspace fan-out covers the declared member globs and nothing else, so every generator,
 * CI driver, and repo-level test under `scripts/` — thousands of lines that
 * import package sources directly — was typechecked by NOTHING. `tsconfig.tools.json`
 * existed and included them, and no command ever ran it.
 *
 * What that cost (2026-07-25): `gen-settings-reference.ts` declared its tab
 * titles as `Record<SettingTab, string>` with three tabs that do not exist and
 * six real ones missing. That is a compile error the moment anything checks it.
 * Unchecked, the lookup returned `undefined` and the shipped settings reference
 * carried six headings reading `## undefined`. Running the check then found five
 * more, including a since-removed port manager fingerprinting a `{name, key}`
 * object as if it were the API key and passing that object as the credential,
 * a lane path that could never have authenticated.
 */
describe("the typecheck covers scripts/ as well as the workspaces", () => {
	const rootScripts = (): Record<string, string> =>
		JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts ?? {};

	/** The root's own check:types is what points at tsconfig.tools.json. */
	it("declares a root check:types that runs the type checker on the tools project", () => {
		const script = rootScripts()["check:types"];
		expect(script, "the root package must declare check:types for scripts/").toBeDefined();
		expect(script).toContain("tsconfig.tools.json");
		expect(script?.includes("tsgo") || script?.includes("tsc")).toBe(true);
	});

	/** Declaring it is not running it: the gate has to invoke it. */
	it("runs it from check:ts, so the gate covers scripts/", () => {
		expect(
			rootScripts()["check:ts"],
			"check:ts must run the root check:types; --workspaces alone never reaches scripts/",
		).toContain("check:types");
		expect(rootScripts()["check:ts"]).toContain("bun run check:types");
	});

	/**
	 * The tools project must stay non-composite. Composite requires every file in
	 * the program to be listed, and these scripts import package sources by
	 * relative path, so composite turns five legitimate imports into TS6307 and the
	 * check becomes unrunnable — which is how it came to be skipped in the first
	 * place.
	 */
	it("keeps the tools project non-composite so the check can actually run", () => {
		const config = readFileSync(join(REPO_ROOT, "tsconfig.tools.json"), "utf8");
		expect(config).not.toContain('"composite": true');
		expect(config).toContain('"noEmit": true');
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

/** Every place a repo-level suite can legitimately be run from, as one text to
 * search. `runner-references.ts` owns which files those are, so this lock and
 * `script-tests-coverage.test.ts` cannot disagree about whether a workflow
 * exists. */
function otherRunnerSources(): string {
	return runnerSources().join("\n");
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
	// Empty, and that is the intended resting state. The one entry that lived here
	// was `scripts/sync-root-changelog.test.ts`, held back while the root sync's
	// scope was an open question: the generator read only
	// `packages/coding-agent/CHANGELOG.md`, so entries recorded in any other
	// package vanished on regeneration. The generator now aggregates every package
	// and cuts inherited history at the fork point, so the suite is wired into
	// `repoScriptTests` like any other.
	const KNOWN_UNRUN = new Map<string, string>([]);

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
