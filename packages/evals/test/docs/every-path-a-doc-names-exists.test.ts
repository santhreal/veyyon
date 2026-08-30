/**
 * WHY: consolidating five benchmark packages into `packages/evals` moved almost every module, and
 * the documentation kept naming the old locations. `README.md` pointed the run store at
 * `assets/evals.sqlite` when it is written to `<runs-dir>/_manager/evals.sqlite`; the deep-swe
 * README listed convenience scripts (`smoke`, `pilot:dry`, `compare`) that no longer exist under
 * those names; the Terminal-Bench guide told a reader to import `@veyyon/evals/suites/terminal-bench`,
 * a module path with no file behind it. Each one costs a reader a search that ends in nothing.
 *
 * The class closed here is "a document names a path this package does not have". Every backticked
 * token in every Markdown file under the package that looks like a repository path is resolved on
 * disk, so a rename that leaves a document behind turns this suite red instead of shipping a dead
 * reference. The scan is derived from the file tree at run time, so a new document is covered the
 * moment it is added.
 *
 * What it does not catch: a path that exists but is described wrongly, a stale line number, a
 * script name (covered for deep-swe by `every-arm-flag-and-task-set-the-docs-name-exists.test.ts`), and a prose claim about behavior.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { memberTopLevels } from "../../../../scripts/workspace-layout";

const packageRoot = path.resolve(import.meta.dirname, "..", "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

/**
 * Directories that hold vendored corpora, generated run output, or model-facing prompt text.
 * A `prompts/` Markdown file is an asset a module imports with `{ type: "text" }`: the paths in it
 * name files inside a task workspace, not files in this repository.
 */
const SKIPPED_DIRS = new Set([".cache", "datasets", "node_modules", "runs", ".internal", "prompts"]);

function markdownFiles(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (SKIPPED_DIRS.has(entry.name)) continue;
			markdownFiles(path.join(dir, entry.name), out);
			continue;
		}
		if (entry.name.endsWith(".md")) out.push(path.join(dir, entry.name));
	}
	return out;
}

/**
 * A token is a candidate path when it names one of this repository's source extensions, or starts
 * at a directory this repository has. Python module paths (`pier.agents.installed.base`), container
 * paths (`/opt/veyyon/src`), URLs and placeholders (`<name>`) are not repository paths and are not
 * candidates.
 */
const CANDIDATE = /^(?:packages\/|crates\/|scripts\/|docs\/|website\/|src\/|test\/|agents\/|proof\/)[\w./-]+$/;
const SOURCE_FILE = /\.(?:ts|tsx|js|py|rs|json|toml|yml|yaml|sh|md|sql|sqlite)$/;

function candidatePaths(text: string): string[] {
	const found = new Set<string>();
	for (const match of text.matchAll(/`([^`\n]+)`/g)) {
		const token = (match[1] ?? "").trim();
		if (token.includes(" ") || token.includes("*") || token.includes("<") || token.includes("$")) continue;
		if (!CANDIDATE.test(token)) continue;
		// A bare directory reference is a path too, but only judge one that names a file: a
		// directory mentioned mid-sentence is often a family of paths rather than one that exists.
		if (!SOURCE_FILE.test(token)) continue;
		found.add(token);
	}
	return [...found];
}

/**
 * A shell block's `bun <path>` names a script a reader is told to run. The flags after it are not
 * checked here (each tool parses its own argv), but the script itself has to exist, which is what
 * broke when the measurement tools moved into `src/suites/deep-swe/` and the commands kept the bare
 * filenames.
 */
function commandScripts(text: string): string[] {
	const found = new Set<string>();
	for (const block of text.matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)```/g)) {
		for (const line of (block[1] ?? "").split("\n")) {
			const match = /^\s*(?:[A-Z_]+=\S+\s+)*bun(?:\s+(?:run|--hot|--smol))*\s+(\S+\.tsx?)/.exec(line);
			const script = match?.[1];
			if (script && !script.includes("<") && !script.includes("*")) found.add(script);
		}
	}
	return [...found];
}

/**
 * Resolve against the repository root for a token that starts at a workspace tree, else against this
 * package.
 *
 * The prefixes are read from the workspace manifests rather than named. This listed `packages/` and
 * `crates/`, so a document naming `natives/search/walker/src/cache.rs` -- the tree the Rust crates
 * moved to -- resolved that token against `packages/evals` and then against the document's own
 * directory, and reported a live path as dead.
 */
const REPO_RELATIVE_PREFIXES = [...memberTopLevels(), "docs", "scripts", "tests"].map(top => `${top}/`);

function resolveCandidate(docFile: string, token: string): string {
	const base = REPO_RELATIVE_PREFIXES.some(prefix => token.startsWith(prefix)) ? repoRoot : packageRoot;
	const direct = path.join(base, token);
	if (fs.existsSync(direct)) return direct;
	// A document inside a suite names its siblings relatively.
	return path.join(path.dirname(docFile), token);
}

describe("every path a document names exists", () => {
	const docs = markdownFiles(packageRoot);

	it("finds the documents to check", () => {
		expect(docs.length).toBeGreaterThan(5);
	});

	it("resolves every repository path referenced in a Markdown file", () => {
		const dead: string[] = [];
		for (const doc of docs) {
			const text = fs.readFileSync(doc, "utf8");
			for (const token of candidatePaths(text)) {
				if (fs.existsSync(resolveCandidate(doc, token))) continue;
				dead.push(`${path.relative(repoRoot, doc)}: ${token}`);
			}
		}
		expect(dead).toEqual([]);
	});

	it("resolves every script a documented command tells a reader to run", () => {
		const dead: string[] = [];
		for (const doc of docs) {
			const text = fs.readFileSync(doc, "utf8");
			for (const script of commandScripts(text)) {
				if (fs.existsSync(resolveCandidate(doc, script))) continue;
				dead.push(`${path.relative(repoRoot, doc)}: bun ${script}`);
			}
		}
		expect(dead).toEqual([]);
	});
});
