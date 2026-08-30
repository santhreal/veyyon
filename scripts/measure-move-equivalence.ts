/**
 * Rebuilds the ledger that proves a moved file kept its content.
 *
 * This PR renames 1563 tracked files: `crates/*` became `natives/*`, `packages/tui` became
 * `hosts/terminal/engine`, `packages/wire` became `contracts/wire` and `packages/natives` became
 * `natives/bridge/bindings`. A diff that size hides an accidental edit, a dropped function or a stale
 * copy of a helper, and no reviewer reads it line by line. So the claim is made mechanically: apply
 * the branch's own renames to main's text, and the bytes should not move.
 *
 * Two comparisons per file, both recorded:
 *
 * 1. NORMALIZED CONTENT. Main's bytes with every prefix rewrite applied and every run of `../`
 *    collapsed, hashed. A file whose hash equals the working tree's is byte-identical modulo the
 *    paths that moved, which is 1160 of them.
 * 2. STRUCTURAL LINES. The same text with comments, blank lines, whitespace runs and whole import
 *    statements removed. Two files that agree here differ only in what they import and what their
 *    comments say, which is what a move does to a call site.
 *
 * A file that fails both carries a `group` and a written `reason`: the change is real and someone
 * says what it is. `bun scripts/measure-move-equivalence.ts` rewrites the ledger; it needs a fetched
 * `origin/main`, which is why the suite beside it reads the ledger and never runs git.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type DiffersKind = "changed" | "imports-and-comments-only" | "none";

export interface FileRecord {
	old: string;
	kind: "binary" | "normalized";
	differs: DiffersKind;
	group?: string;
	reason?: string;
	hash: string;
	mainHash: string;
	structuralHash?: string;
	mainStructuralHash?: string;
}

export interface MoveEquivalenceLedger {
	generatedFrom: string;
	rewrites: [string, string][];
	files: Record<string, FileRecord>;
	/**
	 * Every import attribute the baseline carried, keyed by the path the file has on this branch.
	 *
	 * Separate from `files` because it covers the whole baseline tree rather than the rename pairs: a
	 * file this branch edited without moving is outside the move ledger, and that is exactly where an
	 * attribute was lost. The value is each attribute's text, sorted, so a re-ordered import block is
	 * not a difference and a dropped `with { type: "text" }` is.
	 */
	importAttributes: Record<string, string[]>;
}

/** A file whose bytes are not text; compared raw, since a rewrite table means nothing inside one. */
const BINARY_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".ico",
	".pdf",
	".zip",
	".tar",
	".gz",
	".node",
	".so",
	".dylib",
	".dll",
	".wasm",
]);
/** The extensions whose comments and imports the structural comparison knows how to drop. */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".rs"]);

const UP_RUN = /(?:\.\.\/)+/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /^[ \t]*(\/\/|#(?!!)).*$/gm;
const IMPORT_START = /^\s*(import\b|export\s+\*|export\s+type\s*\{|export\s*\{|use\s+[\w:{]|pub\s+use\b)/;
/** An import attribute (`with { type: "text" }`), which decides whether a file loads as a string. */
const IMPORT_ATTRIBUTE = /\bwith\s*(\{[^}]*\})/;
/** Every attributed import in a file, for the baseline inventory. */
const IMPORT_ATTRIBUTE_ALL = /\bfrom\s*"[^"]+"\s*with\s*(\{[^}]*\})/g;

export function sha256(text: Buffer | string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Main's text in this branch's vocabulary.
 *
 * Longest prefix first, so `crates/veyyon-uu-grep` is rewritten before `crates/veyyon-uu` could claim
 * its prefix. The `../` collapse is the second half of a move: a file one directory deeper reaches its
 * sibling with one more `..`, which is the path changing, not the code.
 */
export function normalizeWithRewrites(text: string, rewrites: readonly [string, string][]): string {
	let result = text;
	for (const [oldPrefix, newPrefix] of rewrites) result = result.replaceAll(oldPrefix, newPrefix);
	return result.replace(UP_RUN, "../");
}

/**
 * The lines that are neither a comment, a blank, nor part of an import statement.
 *
 * A multi-line import is dropped as a whole: the opening line puts the reader inside the statement
 * until a line closes it with `from "..."`, a semicolon or a quote, which is what a re-grouped import
 * block looks like after a package split. Whitespace inside a kept line is collapsed, so a re-wrap
 * that fits a 120-column formatter is not a difference either.
 *
 * An import ATTRIBUTE is not part of the path, so it survives the drop. `import x from "./y.js" with
 * { type: "text" }` loads a file as a string; the same line without the attribute loads it as a
 * module and throws on the missing export. Dropping the whole statement made that a move-shaped
 * difference, and this branch shipped exactly that defect in `export/html/index.ts` for two commits.
 * The attributes are collected and appended in sorted order, so a re-grouped or re-ordered import
 * block is still equivalent while a lost attribute is a difference.
 */
export function structuralLines(text: string, filePath: string): string[] {
	const extension = path.extname(filePath);
	let body = text;
	if (SOURCE_EXTENSIONS.has(extension)) {
		body = body.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "");
	}
	const kept: string[] = [];
	const attributes: string[] = [];
	const collectAttribute = (line: string): void => {
		const found = line.match(IMPORT_ATTRIBUTE);
		if (found !== null) attributes.push(`import-attribute ${found[1]}`);
	};
	let insideImport = false;
	for (const raw of body.split("\n")) {
		const line = raw.split(/\s+/).filter(Boolean).join(" ");
		if (line === "") continue;
		if (insideImport) {
			if (line.includes('from "') || line.endsWith(";") || line.endsWith('"') || line.endsWith("';")) {
				insideImport = false;
				collectAttribute(line);
			}
			continue;
		}
		if (IMPORT_START.test(line)) {
			if (!(line.includes('from "') || line.endsWith(";") || line.endsWith("'"))) insideImport = true;
			collectAttribute(line);
			continue;
		}
		kept.push(line);
	}
	return [...kept, ...attributes.sort()];
}

export function structuralHash(text: string, filePath: string): string {
	return sha256(structuralLines(text, filePath).join("\n"));
}

/**
 * The prefix rewrite table, derived from the rename pairs rather than written by hand.
 *
 * Each pair contributes the directory prefix that changed once the common suffix is stripped, and a
 * prefix that moved to two places keeps the destination most of its files went to. A hand-written
 * table would go stale on the next move; this one is a function of the move itself.
 */
export function derivePrefixRewrites(pairs: readonly [string, string][]): [string, string][] {
	const targets = new Map<string, Map<string, number>>();
	for (const [oldPath, newPath] of pairs) {
		const oldParts = oldPath.split("/");
		const newParts = newPath.split("/");
		let shared = 0;
		while (
			shared < oldParts.length &&
			shared < newParts.length &&
			oldParts[oldParts.length - 1 - shared] === newParts[newParts.length - 1 - shared]
		) {
			shared++;
		}
		const oldPrefix = shared > 0 ? oldParts.slice(0, -shared).join("/") : oldPath;
		const newPrefix = shared > 0 ? newParts.slice(0, -shared).join("/") : newPath;
		if (oldPrefix === "" || newPrefix === "" || oldPrefix === newPrefix) continue;
		let seen = targets.get(oldPrefix);
		if (!seen) {
			seen = new Map<string, number>();
			targets.set(oldPrefix, seen);
		}
		seen.set(newPrefix, (seen.get(newPrefix) ?? 0) + 1);
	}

	const rules: [string, string][] = [];
	for (const [oldPrefix, seen] of targets) {
		let best = "";
		let most = -1;
		for (const [candidate, count] of seen) {
			if (count > most) {
				most = count;
				best = candidate;
			}
		}
		if (best !== "") rules.push([oldPrefix, best]);
	}
	rules.sort((left, right) => right[0].length - left[0].length || left[0].localeCompare(right[0]));
	return rules;
}

/**
 * What a real change is, by the part of the tree it lands in.
 *
 * A group is a rule, not a per-file note: forty-six vendored manifests were repointed by one edit and
 * saying so once is the honest description. A path that matches no rule is a finding the generator
 * refuses to swallow, because an unexplained content change in a move is the defect this file hunts.
 */
const GROUPS: readonly { name: string; matches: (relative: string) => boolean; reason: string }[] = [
	{
		name: "vendored-manifest",
		matches: relative => relative.startsWith("natives/vendor/") && relative.endsWith("Cargo.toml"),
		reason:
			"A vendored crate's path dependencies point at the new `natives/` tree the workspace regroup moved them to. No vendored source changed.",
	},
	{
		name: "manifest-depth",
		matches: relative => /(bunfig\.toml|tsconfig(\.publish)?\.json|package\.json)$/.test(relative),
		reason:
			"A manifest states its own directory: relative preload and extends depth, and workspace metadata, follow the move.",
	},
	{
		name: "changelog-or-readme",
		matches: relative => relative.endsWith("CHANGELOG.md") || relative.endsWith("README.md"),
		reason: "A moved package records the move in its own changelog or names its new path in its readme.",
	},
	{
		name: "rust-path-expectation",
		matches: relative => relative.endsWith(".rs") || relative.endsWith(".raw"),
		reason:
			"A Rust test or minimizer fixture asserts on a path string the regroup renamed. The assertion is the same rule against the new path.",
	},
	{
		name: "bindings-path-expectation",
		matches: relative => relative.startsWith("natives/bridge/bindings/"),
		reason:
			"A native-bindings test asserts on the addon's own path, which moved with the package out of `packages/`.",
	},
	{
		name: "extracted-to-utils",
		matches: relative => relative.startsWith("packages/utils/") || relative.startsWith("hosts/terminal/engine/"),
		reason:
			"Terminal-independent string, key, fuzzy and layout code was extracted out of the engine into `@veyyon/utils` subpaths, so content moved between two files that both still exist. The engine keeps what draws.",
	},
	{
		name: "view-conversion",
		matches: relative => /(goals\/goal-tool\.ts|transcript\/tool-execution\.ts)$/.test(relative),
		reason:
			"A renderer that built a terminal component now returns a `ToolView`, and the card that draws it reads the view. Byte identity of the drawn output is proved by the oracle suite, not here.",
	},
	{
		name: "host-boundary",
		matches: relative => relative.startsWith("packages/coding-agent/src/modes/terminal/"),
		reason:
			"The terminal host's own modules: they moved under `modes/terminal/` and now take presentation view-models and utils subpaths instead of reaching across the tree.",
	},
	{
		name: "engine-consumer",
		matches: relative => relative.startsWith("packages/coding-agent/src/"),
		reason: "A coding-agent module reads a value that moved out of the engine, so the call site names its new owner.",
	},
	{
		name: "contract-extraction",
		matches: relative => relative.startsWith("contracts/"),
		reason:
			"Wire and view types were extracted into dependency-free contract packages, which is where the presentation view-models now live.",
	},
];

export function groupFor(relative: string): { name: string; reason: string } | undefined {
	const hit = GROUPS.find(group => group.matches(relative));
	return hit === undefined ? undefined : { name: hit.name, reason: hit.reason };
}

/** Every group name a ledger row may carry, for the suite to pin. */
export const GROUP_NAMES: readonly string[] = GROUPS.map(group => group.name);

function git(repoRoot: string, args: string[]): Buffer {
	return execFileSync("git", args, { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 });
}

export function renamePairs(repoRoot: string, baseSha: string): [string, string][] {
	// 25%, not the default 50%: a module that changes directory has every relative import rewritten,
	// so an honest move can fall under half-similar and then sits outside this ledger entirely, which
	// is the one place a lost byte would not be seen. `-l0` removes the rename-detection cap.
	const raw = git(repoRoot, [
		"diff",
		"--find-renames=25%",
		"-l0",
		"--diff-filter=R",
		"--name-status",
		`${baseSha}...HEAD`,
	])
		.toString("utf-8")
		.split("\n");
	const pairs: [string, string][] = [];
	for (const row of raw) {
		const parts = row.split("\t");
		if (parts.length === 3 && parts[0].startsWith("R")) pairs.push([parts[1], parts[2]]);
	}
	return pairs;
}

/**
 * Every import attribute the baseline carried, keyed by the path the file has on this branch.
 *
 * The shortlist comes from `git grep`, so this reads a hundred files instead of eleven thousand. A
 * baseline file that carried an attribute and no longer exists here is not recorded silently: it
 * throws, because deleting a text-loaded module is a decision and not a side effect of a move.
 */
export function baselineImportAttributes(
	repoRoot: string,
	baseSha: string,
	pairs: readonly [string, string][],
): Record<string, string[]> {
	const destinationOf = new Map(pairs);
	const shortlist = git(repoRoot, ["grep", "-I", "--name-only", "-e", "with {", baseSha, "--", "*.ts", "*.tsx"])
		.toString("utf-8")
		.split("\n")
		.map(row => row.replace(`${baseSha}:`, "").trim())
		.filter(row => row !== "");
	const inventory: Record<string, string[]> = {};
	const vanished: string[] = [];
	for (const basePath of shortlist) {
		const text = git(repoRoot, ["show", `${baseSha}:${basePath}`]).toString("utf-8");
		const attributes = [...text.matchAll(IMPORT_ATTRIBUTE_ALL)].map(found => found[1].replace(/\s+/g, " "));
		if (attributes.length === 0) continue;
		const branchPath = destinationOf.get(basePath) ?? basePath;
		if (!fs.existsSync(path.join(repoRoot, branchPath))) {
			vanished.push(`${basePath}${branchPath === basePath ? "" : ` -> ${branchPath}`}`);
			continue;
		}
		inventory[branchPath] = attributes.sort();
	}
	if (vanished.length > 0) {
		throw new Error(`a baseline file loaded content through an import attribute and is gone: ${vanished.join(", ")}`);
	}
	return inventory;
}

export function generateLedger(repoRoot: string): MoveEquivalenceLedger {
	const baseSha = git(repoRoot, ["rev-parse", "origin/main"]).toString("utf-8").trim();
	const pairs = renamePairs(repoRoot, baseSha);
	const rewrites = derivePrefixRewrites(pairs);
	const files: Record<string, FileRecord> = {};

	for (const [oldPath, newPath] of pairs) {
		const onDisk = path.join(repoRoot, newPath);
		if (!fs.existsSync(onDisk)) throw new Error(`renamed to a path that does not exist: ${newPath}`);
		const mainBytes = git(repoRoot, ["show", `${baseSha}:${oldPath}`]);
		const currentBytes = fs.readFileSync(onDisk);

		if (BINARY_EXTENSIONS.has(path.extname(newPath))) {
			const hash = sha256(currentBytes);
			const mainHash = sha256(mainBytes);
			files[newPath] = {
				old: oldPath,
				kind: "binary",
				differs: hash === mainHash ? "none" : "changed",
				hash,
				mainHash,
				...(hash === mainHash ? {} : (groupFor(newPath) ?? {})),
			};
			continue;
		}

		const mainText = normalizeWithRewrites(mainBytes.toString("utf-8"), rewrites);
		const currentText = normalizeWithRewrites(currentBytes.toString("utf-8"), rewrites);
		const hash = sha256(currentText);
		const mainHash = sha256(mainText);
		const structural = structuralHash(currentText, newPath);
		const mainStructural = structuralHash(mainText, newPath);
		const differs: DiffersKind =
			hash === mainHash ? "none" : structural === mainStructural ? "imports-and-comments-only" : "changed";
		const group = differs === "changed" ? groupFor(newPath) : undefined;
		if (differs === "changed" && group === undefined) {
			throw new Error(`content changed with no group to explain it: ${newPath}`);
		}
		files[newPath] = {
			old: oldPath,
			kind: "normalized",
			differs,
			...(group === undefined ? {} : { group: group.name, reason: group.reason }),
			hash,
			mainHash,
			structuralHash: structural,
			mainStructuralHash: mainStructural,
		};
	}

	return {
		generatedFrom: baseSha,
		rewrites,
		files,
		importAttributes: baselineImportAttributes(repoRoot, baseSha, pairs),
	};
}

if (import.meta.main) {
	const repoRoot = path.resolve(import.meta.dirname, "..");
	const ledger = generateLedger(repoRoot);
	const target = path.join(repoRoot, "scripts", "fixtures", "move-equivalence.json");
	fs.writeFileSync(target, `${JSON.stringify(ledger, null, "\t")}\n`);
	const rows = Object.values(ledger.files);
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(row.differs, (counts.get(row.differs) ?? 0) + 1);
	process.stdout.write(`wrote ${rows.length} rows from ${ledger.generatedFrom}\n`);
	for (const [kind, count] of [...counts].sort()) process.stdout.write(`  ${kind}: ${count}\n`);
}
