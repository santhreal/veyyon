/**
 * WHY THIS SUITE EXISTS. A test file named after the module it imports or after an issue number
 * hides the contract it defends. This suite sweeps every package for test files whose name
 * matches a module stem, ratchets existing collisions against a shrink-only baseline, and forbids
 * issue-numbered test names. What it does not catch: a test file whose name is prose but
 * inaccurate, or a suite that asserts no invariant.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { typeScriptMembers, typeScriptMemberTopLevels } from "./workspace-layout";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BASELINE_PATH = path.join(REPO_ROOT, "scripts", "data", "module-named-suites.txt");

const SKIP_DIRS: Record<string, true> = {
	".cache": true,
	".git": true,
	".internal": true,
	dist: true,
	node_modules: true,
	runs: true,
};

function walk(dir: string, keep: (filePath: string) => boolean): string[] {
	const found: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		if (SKIP_DIRS[entry.name]) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...walk(full, keep));
		} else if (keep(full)) {
			found.push(full);
		}
	}
	return found;
}

/**
 * Every workspace member directory, repo-relative.
 *
 * The members are read from the root manifest rather than assumed from globs. While this was
 * `packages/` alone, a suite under any other root was outside the rule: `contracts/wire/test`
 * carries eight of them, and a module-named suite there would have been accepted in silence. The
 * root view was in turn blind to literal paths (`natives/bridge/bindings`, `python/veybot/web`), which
 * `typeScriptMembers()` now reaches.
 */
function packageRoots(): string[] {
	return typeScriptMembers();
}

function collectModuleNamedSuites(): {
	colliding: string[];
	allTestCount: number;
} {
	const colliding: string[] = [];
	let allTestCount = 0;

	for (const pkgRel of packageRoots()) {
		const pkgDir = path.join(REPO_ROOT, pkgRel);
		const srcDir = path.join(pkgDir, "src");
		const srcFiles = walk(
			srcDir,
			file => (file.endsWith(".ts") || file.endsWith(".tsx")) && !file.endsWith(".d.ts") && !file.includes(".test."),
		);
		const moduleStems = new Set(srcFiles.map(file => path.basename(file).replace(/\.tsx?$/, "")));

		const testFiles = walk(pkgDir, file => /\.test\.tsx?$/.test(file)).map(file => path.relative(REPO_ROOT, file));
		allTestCount += testFiles.length;

		for (const testFile of testFiles) {
			const claim = path.basename(testFile).replace(/\.test\.tsx?$/, "");
			if (moduleStems.has(claim)) {
				colliding.push(testFile);
			}
		}
	}

	const otherRoots = ["scripts", "website", "proof"];
	for (const root of otherRoots) {
		const rootDir = path.join(REPO_ROOT, root);
		const testFiles = walk(rootDir, file => /\.test\.tsx?$/.test(file));
		allTestCount += testFiles.length;
	}

	return {
		colliding: colliding.sort(),
		allTestCount,
	};
}

function collectIssueNamedSuites(): string[] {
	const scanRoots = [...new Set([...typeScriptMemberTopLevels(), "scripts", "website", "proof"])];
	const issueNamed: string[] = [];

	for (const root of scanRoots) {
		const rootDir = path.join(REPO_ROOT, root);
		const testFiles = walk(rootDir, file => /\.test\.tsx?$/.test(file)).map(file => path.relative(REPO_ROOT, file));
		for (const testFile of testFiles) {
			const claim = path.basename(testFile).replace(/\.test\.tsx?$/, "");
			if (/^(?:issue-?)?\d+$/i.test(claim)) {
				issueNamed.push(testFile);
			}
		}
	}
	return issueNamed.sort();
}

function readBaseline(): string[] {
	if (!fs.existsSync(BASELINE_PATH)) {
		return [];
	}
	const content = fs.readFileSync(BASELINE_PATH, "utf8");
	return content
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith("#"))
		.sort();
}

describe("a suite is named for the behavior it defends", () => {
	it("finds no test named after an issue number", () => {
		const issueNamed = collectIssueNamedSuites();
		expect(issueNamed).toEqual([]);
	});

	it("keeps packages/evals at zero module-named suites", () => {
		const { colliding } = collectModuleNamedSuites();
		const evalsColliding = colliding.filter(file => file.startsWith("packages/evals/"));
		expect(evalsColliding).toEqual([]);

		const baseline = readBaseline();
		const evalsBaseline = baseline.filter(file => file.startsWith("packages/evals/"));
		expect(evalsBaseline).toEqual([]);
	});

	it("guards against a vacuous sweep", () => {
		const { colliding, allTestCount } = collectModuleNamedSuites();
		expect(allTestCount).toBeGreaterThan(4000);
		expect(colliding).toContain("packages/coding-agent/src/memory/hindsight/client.test.ts");
	});

	// A member under a root the sweep never opened is unreachable: its suites can be named after
	// their module and this gate stays green, because a name it never read cannot collide.
	it("reaches a member under every root the workspace declares", () => {
		const roots = new Set(packageRoots().map(member => member.split("/")[0]));

		expect([...roots].sort()).toEqual(typeScriptMemberTopLevels());
		expect(packageRoots()).toContain("contracts/wire");
	});

	it("matches the shrink-only baseline exactly", () => {
		const { colliding } = collectModuleNamedSuites();
		const baseline = readBaseline();

		const observedSet = new Set(colliding);
		const baselineSet = new Set(baseline);

		const extra = colliding.filter(file => !baselineSet.has(file));
		const missing = baseline.filter(file => !observedSet.has(file));

		if (extra.length > 0 || missing.length > 0) {
			const messages: string[] = [];
			if (extra.length > 0) {
				messages.push(
					`New module-named test suites found (rename in prose or add to baseline if approved):\n${extra.map(f => `+ ${f}`).join("\n")}`,
				);
			}
			if (missing.length > 0) {
				messages.push(
					`Baseline entries no longer collide (shrink baseline by removing lines):\n${missing.map(f => `- ${f}`).join("\n")}`,
				);
			}
			expect(messages.join("\n\n")).toBe("");
		}

		expect(colliding).toEqual(baseline);
	});
});
