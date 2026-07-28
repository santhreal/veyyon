import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

/**
 * Every script under `scripts/` is either called by something automated, or says
 * in its own header what it is for AND the exact command that runs it.
 *
 * WHY THIS SUITE EXISTS. Seventeen scripts had no automated caller: nothing in a
 * `package.json` recipe, nothing in `.github/workflows/`, and no other script
 * importing or spawning them. Two completely different situations wear that same
 * face. Some are real hand-run tools, the session-stats analyses an operator runs
 * against their own history, the live-model edit benchmarks that cost money and
 * so cannot be a gate. Some are leftovers from work that finished. From a
 * directory listing nobody can tell which is which, so nothing is ever deleted
 * and `scripts/` only grows.
 *
 * The header is what separates them, and the RUN COMMAND is the half that
 * matters. A docstring saying what a script does decays gracefully; an
 * invocation nobody remembers is a script that is already dead whatever its
 * docstring claims. So an unowned script must state both, and the statement is
 * what a future reader uses to decide whether it still earns its place.
 *
 * Ownership is resolved three ways, and the resolver is tested against known-
 * owned scripts on purpose: a resolver that quietly stopped matching would turn
 * this gate into a hundred false findings rather than an honest failure, and the
 * response to a hundred findings is to delete the gate.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");

/** Extensions that are a script rather than data, a suite, or a fixture. */
const SCRIPT_EXTENSIONS = new Set([".ts", ".sh", ".py", ".jl", ".ps1", ".mjs"]);

/** Subdirectories of `scripts/` that hold scripts rather than fixtures or output. */
const SCANNED_SUBDIRS = ["", "demos", "install-tests", "session-stats"] as const;

/** Every script path relative to the repo root. */
async function scriptFiles(): Promise<string[]> {
	const found: string[] = [];
	for (const sub of SCANNED_SUBDIRS) {
		const dir = sub === "" ? SCRIPTS_DIR : path.join(SCRIPTS_DIR, sub);
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			if (entry.name.endsWith(".test.ts")) continue;
			if (!SCRIPT_EXTENSIONS.has(path.extname(entry.name))) continue;
			found.push(path.relative(REPO_ROOT, path.join(dir, entry.name)));
		}
	}
	return found.sort();
}

/** Text of every manifest and workflow that could name a script. */
async function callerText(): Promise<string> {
	const parts: string[] = [];
	parts.push(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));

	const packages = await readdir(path.join(REPO_ROOT, "packages"), { withFileTypes: true }).catch(() => []);
	for (const pkg of packages) {
		if (!pkg.isDirectory()) continue;
		const manifest = path.join(REPO_ROOT, "packages", pkg.name, "package.json");
		const text = await readFile(manifest, "utf8").catch(() => undefined);
		if (text !== undefined) parts.push(text);
	}

	const workflowDir = path.join(REPO_ROOT, ".github", "workflows");
	for (const entry of await readdir(workflowDir, { withFileTypes: true }).catch(() => [])) {
		if (!entry.isFile()) continue;
		parts.push(await readFile(path.join(workflowDir, entry.name), "utf8"));
	}
	return parts.join("\n");
}

/** Text of every script and script suite, for "another script runs this one". */
async function peerText(exclude: string): Promise<string> {
	const parts: string[] = [];
	for (const sub of SCANNED_SUBDIRS) {
		const dir = sub === "" ? SCRIPTS_DIR : path.join(SCRIPTS_DIR, sub);
		for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
			if (!entry.isFile()) continue;
			const rel = path.relative(REPO_ROOT, path.join(dir, entry.name));
			if (rel === exclude) continue;
			parts.push(await readFile(path.join(dir, entry.name), "utf8").catch(() => ""));
		}
	}
	return parts.join("\n");
}

const SCRIPTS = await scriptFiles();
const CALLERS = await callerText();
const SOURCES = new Map<string, string>(
	await Promise.all(SCRIPTS.map(async file => [file, await readFile(path.join(REPO_ROOT, file), "utf8")] as const)),
);

/**
 * Is this script named by a manifest recipe, a workflow, another script, or a
 * suite anywhere in the tree?
 *
 * The last route is the one that needs the repo-wide search. A script can be a
 * LIBRARY: `workspace-manifests.ts` exports the rules its own suite asserts, and
 * `ensure-tool-views.ts` exports a path that a coding-agent test helper imports.
 * Both are owned, and both are imported as `./workspace-manifests` with no
 * extension, so a filename match never finds them. The search runs only after
 * the cheap corpus misses, which is a handful of scripts rather than all of
 * them.
 */
async function hasAutomatedCaller(file: string): Promise<boolean> {
	const base = path.basename(file);
	// Matched by path AND by bare filename: workflows spell the full path, while a
	// sibling script usually spells only the name it sits next to.
	if (CALLERS.includes(file) || CALLERS.includes(base)) return true;
	const peers = await peerText(file);
	if (peers.includes(file) || peers.includes(base)) return true;

	// The extensionless stem, as an import specifier ends in it. Anchored on a
	// path separator or a quote so a stem like `release` cannot match the word in
	// a sentence.
	const stem = base.replace(/\.[^.]+$/, "");
	const hits = await $`git -C ${REPO_ROOT} grep -lE ${`["'./]${stem}["']`} -- ${"*.ts"} ${"*.js"}`.nothrow().text();
	return hits
		.split("\n")
		.map(line => line.trim())
		.some(hit => hit.length > 0 && hit !== file);
}

/**
 * The first comment block, in whichever syntax the file uses.
 *
 * Read as a block rather than line by line because the rule is about a header
 * that explains the script, and a lone `# shellcheck disable` line is not that.
 */
function headerOf(file: string, text: string): string {
	const lines = text.split("\n");
	let at = 0;
	if (lines[at]?.startsWith("#!")) at++;
	while (lines[at]?.trim() === "") at++;

	const rest = lines.slice(at).join("\n");
	if (path.extname(file) === ".py") {
		const match = /^"""([\s\S]*?)"""/.exec(rest.trimStart());
		if (match) return match[1];
	}
	// The `* ` continuation prefix is stripped, without which a `Usage:` line in a
	// JSDoc block reads as ` * Usage:` and no anchored pattern matches it. That
	// was the first draft's bug: it reported eight scripts as having no run
	// command when every one of them documented it.
	const block = /^\/\*\*?([\s\S]*?)\*\//.exec(rest.trimStart());
	if (block) {
		return block[1]
			.split("\n")
			.map(line => line.replace(/^\s*\*\s?/, ""))
			.join("\n");
	}

	const collected: string[] = [];
	for (let index = at; index < lines.length; index++) {
		const line = lines[index].trim();
		if (line.startsWith("#") || line.startsWith("//")) collected.push(line.replace(/^(#|\/\/)\s?/, ""));
		else break;
	}
	return collected.join("\n");
}

/** Does the header both explain the script and say how to run it? */
function headerIsUsable(file: string, text: string): { ok: boolean; why: string } {
	const header = headerOf(file, text);
	const words = header.trim().split(/\s+/).filter(Boolean).length;
	if (words < 15) return { ok: false, why: `header is ${words} words; say what it is for` };
	if (!/^\s*(run|usage|examples?)\b/im.test(header)) {
		return { ok: false, why: "header has no `Run:` / `Usage:` / `Example:` line with the exact command" };
	}
	return { ok: true, why: "" };
}

describe("every script under scripts/ has an owner", () => {
	/**
	 * Guard on the guard, part one: the walk finds a real directory.
	 *
	 * The rule below asserts an empty offender list, which an empty script list
	 * satisfies. The floor is measured against the top-level count rather than
	 * the total including subdirectories, because those are different numbers and
	 * asserting the wrong one is how a floor stops being a floor.
	 */
	it("finds the scripts it claims to check", () => {
		expect(SCRIPTS.length).toBeGreaterThan(50);
		expect(SCRIPTS).toContain("scripts/ci-test-ts.ts");
		expect(SCRIPTS).toContain("scripts/session-stats/sync.py");
	});

	/**
	 * Guard on the guard, part two: the OWNERSHIP resolver still resolves.
	 *
	 * This is the assertion that keeps the gate honest. If `hasAutomatedCaller`
	 * stopped matching, every wired script would look unowned and the suite would
	 * report a hundred findings, none of them real. These four are wired in four
	 * different ways: a root recipe, the release pipeline, a workflow step, and a
	 * shell entrypoint.
	 */
	it("recognises the scripts that are wired", async () => {
		for (const owned of [
			"scripts/ci-test-ts.ts",
			"scripts/release.ts",
			"scripts/check-doc-links.ts",
			"scripts/install-tests/run-ci.sh",
		]) {
			expect(await hasAutomatedCaller(owned), `${owned} reads as unowned`).toBe(true);
		}
	});

	/**
	 * Guard on the guard, part three: the header reader really reads headers.
	 *
	 * A regex over comment syntax is exactly the kind of check that silently
	 * stops matching after a formatting change, and if it did, every hand-run
	 * script would fail with "no header" and the fix would look like adding
	 * headers to files that already have them.
	 */
	it("reads a header out of each comment syntax", () => {
		const python = headerOf("scripts/tool_io.py", SOURCES.get("scripts/tool_io.py") ?? "");
		expect(python).toContain("Shared session-log reader");
		const typescript = headerOf("scripts/sync-versions.ts", SOURCES.get("scripts/sync-versions.ts") ?? "");
		expect(typescript).toContain("lockstep");
		const shell = headerOf("scripts/demos/launch.sh", SOURCES.get("scripts/demos/launch.sh") ?? "");
		expect(shell).toContain("demo recording");
	});

	/**
	 * The rule. A script with no automated caller states what it is for and the
	 * command that runs it.
	 *
	 * Reported as one list so a change that leaves three scripts unexplained
	 * shows all three, and each entry carries the reason rather than just the
	 * path: "no header" and "header without a run command" are different fixes.
	 */
	it("explains every script that nothing calls", async () => {
		const offenders: string[] = [];
		for (const file of SCRIPTS) {
			if (await hasAutomatedCaller(file)) continue;
			const verdict = headerIsUsable(file, SOURCES.get(file) ?? "");
			if (!verdict.ok) offenders.push(`${file}: ${verdict.why}`);
		}
		expect(offenders).toEqual([]);
	});
});
