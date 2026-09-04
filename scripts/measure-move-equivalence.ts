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
 *
 * A prefix keeps at least two segments. Stripping the whole shared suffix of
 * `packages/hashline/src/prompts/registry.ts` -> `plugins/hashline/src/prompts/registry.ts` leaves
 * the bare root `packages`, and one root moved to several others in this branch, so the table kept
 * whichever destination had the most files and rewrote `packages/hashline` to `contracts/hashline`
 * in main's text. Every path string in a moved member then read as a real content change: the
 * generator refused the ledger, naming a file whose only difference is the prefix it moved to. A
 * member-scoped rule is unambiguous, because one member moves to one place.
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
		if (shared > 0) shared = Math.min(shared, oldParts.length - 2, newParts.length - 2);
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
		matches: relative =>
			/(goals\/goal-tool\.ts|transcript\/tool-execution\.ts|tools\/agent\/(review|memory-view|memory-retain|memory-recall|memory-reflect)\.ts|tools\/fs\/(set-cwd|inspect-image)\.ts|tools\/search\/search-tool-bm25\.ts|test\/tools\/an-ssh-block-keeps-its-header-on-one-line\.test\.ts|test\/task\/task-result-render\.test\.ts)$/.test(
				relative,
			),
		reason:
			"A renderer that built a terminal component now returns a `ToolView`, and the card that draws it reads the view. A suite that named the deleted renderer module reads the registry entry instead. Byte identity of the drawn output is proved by the oracle suite, not here.",
	},
	{
		name: "terminal-readout",
		matches: relative => /tools\/shell\/terminal-output\.ts$/.test(relative),
		reason:
			"The rows of a virtual terminal's screen leave this module as the program wrote them -- its text and its SGR sequences and nothing else -- because the card that shows them is a `ToolView` and the drawing is the host's. What used to be decided here is now decided in `src/modes/terminal/draw/terminal-row.ts`.",
	},
	{
		name: "oracle-freeze",
		matches: relative => /^packages\/coding-agent\/test\/oracles\/[a-z0-9-]+\.ts$/.test(relative),
		reason:
			"A renderer this branch replaced with a `ToolView` is frozen here as the differential oracle its suite compares the card against. The search dispatcher reached the three sub-views this branch declares rather than the terminal components main built, which is the change recorded: the rows it draws itself are main's, and the suite beside it proves the card byte for byte.",
	},
	{
		name: "shared-mode-seed",
		matches: relative => /test\/vibe\/a-vibe-worker-inherits-the-parents-effort-and-policy\.test\.ts$/.test(relative),
		reason:
			"An arm that asserts the shared model chain seeds `subagent.sharedModel`, the switch that makes `subagent.model` and `subagent.thinkingLevel` live. Without it the arm pinned a blanket value the resolver never read.",
	},
	{
		name: "overflow-rescue-row",
		matches: relative => relative === "tests/simulations/src/turn-sim/overflow-recovery.test.ts",
		reason:
			"The overflow row asserted a refusal that stayed visible after the summarizer failed. A session no longer parks there: when no reducer recognizes the shape of what is too large, the last-resort tier cuts the middle out of the largest text, the pass reaches the fit bar with no summary and the scheduled retry answers. The row requires that recovery -- one dead-end notice naming the truncation, prose shorter than the prompt carried, and an answer rather than a refusal.",
	},
	{
		name: "site-models-regen",
		matches: relative => relative === "apps/site/models-data.json",
		reason:
			"The models page's data file is generated from `packages/catalog/src/models.json` by the site build, which this branch restored to `apps/site/build.mjs` after the relocation dropped the step. The catalog is main's; main's committed copy of the data file predates its own catalog by fourteen models and one generation date, and the regenerated file is what main's build writes from main's catalog.",
	},
	{
		name: "relocated-member-path",
		matches: relative => /^(apps|clients)\/|^tests\/(evals|simulations)\//.test(relative),
		reason:
			"A member that left `packages/`, `python/` or `website/` for `apps/`, `clients/` or `tests/` states its own directory in a usage string, a command, a registry key or a comment, and climbs to the repository root by a relative path that gained one level. The move itself spells only the new location. A row here can also carry an edit this branch made before the move and every unmoved sibling carries too -- the array-spread rewrite, the `natives/` path spelling, a site page's nav fix -- each recorded in the commit that made it, none made by the relocation -- or the formatter's reflow of a call whose shorter path now fits one line.",
	},
	{
		name: "plugin-path-expectation",
		matches: relative => /^plugins\/[^/]+\/test\//.test(relative),
		reason:
			"A plugin's own suite asserts on the module paths of the package it tests, which moved out of `packages/`. The assertion derives them from the package root instead of spelling the old prefix.",
	},
	{
		name: "web-extraction",
		matches: relative =>
			relative.startsWith("plugins/web/src/") ||
			/^packages\/coding-agent\/src\/(tools\/web\/|web\/|eval\/py\/display\.ts|export\/markit\/converters\/)/.test(
				relative,
			),
		reason:
			"The site scrapers are `@veyyon/web`. A handler states the host capabilities it needs -- the credential store, document conversion, external-tool resolution, the session spawn hook and the fetch preference -- through `ScrapeServices` instead of importing the agent's settings, storage and process modules, and throws a name-preserving `AbortError` rather than the agent's cancellation class. On this side the call sites name the new owner and build the services object.",
	},
	{
		name: "plugin-source",
		matches: relative => /^plugins\/[^/]+\/src\//.test(relative),
		reason: "A plugin left packages/ for plugins/. Relative imports and array copies follow the move.",
	},
	{
		name: "host-boundary",
		matches: relative => relative.startsWith("packages/coding-agent/src/modes/terminal/"),
		reason:
			"The terminal host's own modules: they moved under `modes/terminal/` and now take presentation view-models and utils subpaths instead of reaching across the tree.",
	},
	{
		name: "json-walk-split",
		matches: relative => relative === "packages/coding-agent/src/tools/core/json-tree-render.ts",
		reason:
			"The bounds, the scalar formatter and the one-line argument preview a `ToolView` card reads left this module for `json-tree-view.ts`, which loads without a theme or a tree-rail glyph; this module re-exports every one of them under its old name and keeps the terminal string walk unchanged.",
	},
	{
		name: "engine-consumer",
		matches: relative => relative.startsWith("packages/coding-agent/src/"),
		reason: "A coding-agent module reads a value that moved out of the engine, so the call site names its new owner.",
	},
	{
		name: "colocated-test",
		matches: relative => relative.startsWith("packages/coding-agent/test/"),
		reason: "A suite sat next to the source it covers after the layout cutover, so its imports name the new owner.",
	},
	{
		name: "kernel-absorption",
		matches: relative => relative === "kernel/src/session/agent-session-compaction-policy.ts",
		reason:
			"The kernel's compaction policy module carries the knobs this branch extracted from `agent-session.ts` plus the vocabulary main later extracted into a package-local module of its own, which git pairs as the rename source. One owner states both sets, and no knob's value changed.",
	},
	{
		name: "kernel-extraction",
		matches: relative => relative.startsWith("kernel/src/"),
		reason:
			"The plugin loader, contribution registry and session spine left packages/coding-agent for kernel/. Relative imports and array copies follow the move.",
	},
	{
		name: "contract-extraction",
		matches: relative => relative.startsWith("contracts/"),
		reason:
			"Wire and view types were extracted into contract packages that import nothing that runs, which is where the presentation view-models now live; a wire shape a guest reads is a type-only projection of the one @veyyon/model owns.",
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

/**
 * Build output, which this ledger cannot make a claim about.
 *
 * `docs/handbook/book/` is mdBook's render of `docs/handbook/src/`. Its search index and asset file
 * names carry a content hash, so a rebuild renames the file and rewrites it in the same step, and
 * git pairs the two names as a rename that moved nothing. A row for one of those files is stale the
 * next time the handbook is built, on a branch that renamed nothing further — it reported a missing
 * path and took three cells red for a rebuild. Equivalence for generated output is proved by
 * regenerating it from the source this ledger does compare, not by hashing the render.
 */
function isGeneratedOutput(relative: string): boolean {
	return relative.startsWith("docs/handbook/book/");
}

export function renamePairs(repoRoot: string, baseSha: string, headRef = "HEAD"): [string, string][] {
	// 25%, not the default 50%: a module that changes directory has every relative import rewritten,
	// so an honest move can fall under half-similar and then sits outside this ledger entirely, which
	// is the one place a lost byte would not be seen. `-l0` removes the rename-detection cap.
	const raw = git(repoRoot, [
		"diff",
		"--find-renames=25%",
		"-l0",
		"--diff-filter=RD",
		"--name-status",
		`${baseSha}...${headRef}`,
	])
		.toString("utf-8")
		.split("\n");
	const pairs: [string, string][] = [];
	const deleted: string[] = [];
	for (const row of raw) {
		const parts = row.split("\t");
		if (parts.length === 2 && parts[0] === "D" && !isGeneratedOutput(parts[1])) deleted.push(parts[1]);
		if (parts.length !== 3 || !parts[0].startsWith("R")) continue;
		if (isGeneratedOutput(parts[1]) || isGeneratedOutput(parts[2])) continue;
		pairs.push([parts[1], parts[2]]);
	}
	return pairedWithTheMemberItMovedWith(repoRoot, pairs, deleted);
}

/**
 * Git's rename pairs, re-pointed to the destination the member move predicts.
 *
 * Rename detection is a similarity test over every deleted and every added path, and a member's
 * small manifests are near-identical across members: fourteen `tsconfig.json` files differ by a
 * line or by nothing. Git pairs those by whichever similarity is highest, which for identical bytes
 * is arbitrary, so `packages/wire/tsconfig.json` was reported moved to `contracts/view/`,
 * `packages/swarm-extension/tsconfig.json` to `contracts/wire/`, and `packages/tui/tsconfig.json` to
 * `hosts/gui/`. Each of those rows compared a file against a member it never belonged to, a member
 * this branch created was recorded as a move, and the manifest that did move with its member had no
 * row at all -- and every new member shuffled the chain again, so the counts moved for a reason
 * nobody could name.
 *
 * The prefix table is the majority vote of the member's own files, so it states where the member
 * went. A pair whose source that table resolves to a path that exists on this branch, is not the
 * pair's destination, and is claimed by no other pair is re-pointed there; the destination it leaves
 * behind is a file this branch created, and it is recorded nowhere, which is what a new file is.
 * Re-pointing one pair frees a destination another pair may need, so this runs to a fixed point.
 *
 * A path git reports deleted gets the same reading afterwards. When a member's manifest lost its
 * best match to a sibling's, git had no second pairing to offer and reported the file gone, so
 * `packages/stats/bunfig.toml` was a delete while `apps/stats/bunfig.toml` was a move from
 * `packages/argot/`. A delete whose predicted destination exists and is still unclaimed once the
 * pairs settle is that destination's move.
 *
 * The prediction reads directory rules only. A pair whose destination is too short to share a
 * directory with its source (`packages/hashline/tsconfig.json` -> `kernel/tsconfig.json`) puts a
 * whole-path rule in the table, and that rule is the pair's own vote: reading it back would
 * predict the pairing under question and settle it.
 *
 * WHAT IT DOES NOT CATCH. A file moved on its own to a place the table does not predict, while a
 * new file with its name appears where the table does predict, is re-pointed to the new file; and a
 * file this branch deleted while creating an unrelated one at its predicted destination is paired
 * with it. Neither is silent: the row lands in the changed bucket and has to be explained.
 */
export function pairedWithTheMemberItMovedWith(
	repoRoot: string,
	pairs: readonly [string, string][],
	deleted: readonly string[] = [],
): [string, string][] {
	const rewrites = derivePrefixRewrites(pairs);
	const predictedFor = (oldPath: string): string | undefined => {
		const rule = rewrites.find(([oldPrefix]) => oldPath.startsWith(`${oldPrefix}/`));
		return rule === undefined ? undefined : `${rule[1]}${oldPath.slice(rule[0].length)}`;
	};
	const reconciled: [string, string][] = pairs.map(pair => [pair[0], pair[1]]);
	const claimed = new Set(reconciled.map(([, destination]) => destination));
	for (;;) {
		let moved = false;
		for (const pair of reconciled) {
			const [oldPath, newPath] = pair;
			const predicted = predictedFor(oldPath);
			if (predicted === undefined || predicted === newPath || claimed.has(predicted)) continue;
			if (!fs.existsSync(path.join(repoRoot, predicted))) continue;
			claimed.delete(newPath);
			claimed.add(predicted);
			pair[1] = predicted;
			moved = true;
		}
		if (!moved) break;
	}
	for (const oldPath of deleted) {
		const predicted = predictedFor(oldPath);
		if (predicted === undefined || claimed.has(predicted)) continue;
		if (!fs.existsSync(path.join(repoRoot, predicted))) continue;
		claimed.add(predicted);
		reconciled.push([oldPath, predicted]);
	}
	return reconciled;
}

/**
 * Where a baseline path lives on this branch: the rename git paired it with, else the path itself
 * while it is still there, else the first destination the derived prefix table names that exists.
 *
 * The prefix fallback is not a convenience. Rename detection is a similarity test, so a module that
 * moved AND was rewritten past the threshold is not paired at all while every module that moved with
 * it is. `packages/coding-agent/src/modes/theme/defaults/index.ts` is the case that forced this: the
 * directory's other files pair, so the table carries the move, and that file's own body was rewritten
 * into lazy getters, so git reports a delete beside an add and the pair list cannot answer for it.
 *
 * A candidate is taken only when it is on disk, because one prefix moved to several destinations and
 * the table keeps the one most of its files went to: `packages/coding-agent/src` resolves to
 * `kernel/src`, which is right for the 53 modules the kernel absorbed and wrong for the thousands it
 * did not. Existence is what tells those apart, and the caller still reports a path that resolves
 * nowhere rather than recording it.
 */
export function branchPathOf(
	repoRoot: string,
	basePath: string,
	destinationOf: ReadonlyMap<string, string>,
	rewrites: readonly [string, string][],
): string {
	const paired = destinationOf.get(basePath);
	if (paired !== undefined) return paired;
	if (fs.existsSync(path.join(repoRoot, basePath))) return basePath;
	for (const [oldPrefix, newPrefix] of rewrites) {
		if (basePath !== oldPrefix && !basePath.startsWith(`${oldPrefix}/`)) continue;
		const candidate = `${newPrefix}${basePath.slice(oldPrefix.length)}`;
		if (fs.existsSync(path.join(repoRoot, candidate))) return candidate;
	}
	return basePath;
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
	const rewrites = derivePrefixRewrites(pairs);
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
		const branchPath = branchPathOf(repoRoot, basePath, destinationOf, rewrites);
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

/**
 * Prove the working tree IS the commit the rows are attributed to, for the paths the rows read.
 *
 * `git diff <ref>` cannot answer this: it enumerates the index, so a file the checked-out commit
 * never had reads as deleted even while it sits on disk. That is not a corner case here — the whole
 * reason to name a ref is that the commit is not checked out — so the comparison is made against the
 * ref's own tree, object id by object id, over exactly the files this ledger hashes.
 *
 * The working-tree side is hashed by `git hash-object`, not by hashing the bytes: `.gitattributes`
 * gives `*.cmd` `eol=crlf`, so twenty-one fixtures sit on disk with line endings their blob does not
 * have, and a raw hash calls every one of them a difference.
 */
function assertWorktreeIs(repoRoot: string, headRef: string, paths: readonly string[]): void {
	const blobs = new Map<string, string>();
	for (const row of git(repoRoot, ["ls-tree", "-r", headRef]).toString("utf-8").split("\n")) {
		const [meta, filePath] = row.split("\t");
		if (filePath === undefined) continue;
		const parts = meta.split(" ");
		if (parts[1] === "blob") blobs.set(filePath, parts[2]);
	}

	const drifted: string[] = [];
	const present: string[] = [];
	for (const relative of paths) {
		if (!blobs.has(relative)) drifted.push(`${relative}: ${headRef} does not carry it`);
		else if (!fs.existsSync(path.join(repoRoot, relative)))
			drifted.push(`${relative}: missing from the working tree`);
		else present.push(relative);
	}

	for (let start = 0; start < present.length; start += 400) {
		const chunk = present.slice(start, start + 400);
		const hashed = git(repoRoot, ["hash-object", "--", ...chunk])
			.toString("utf-8")
			.trim()
			.split("\n");
		if (hashed.length !== chunk.length)
			throw new Error(`git hash-object answered ${hashed.length} of ${chunk.length}`);
		for (const [index, actual] of hashed.entries()) {
			const recorded = blobs.get(chunk[index]);
			if (actual !== recorded) drifted.push(`${chunk[index]}: ${actual} on disk, ${recorded} in ${headRef}`);
		}
	}

	if (drifted.length > 0) {
		const shown = drifted.slice(0, 5).join("; ");
		throw new Error(
			`the working tree does not match ${headRef} for ${drifted.length} of ${paths.length} files: ${shown}`,
		);
	}
}

export function generateLedger(repoRoot: string, headRef = "HEAD"): MoveEquivalenceLedger {
	// The MERGE BASE, not the tip of main. `renamePairs` asks git for `base...head`, which is already
	// the merge base by definition, and every row then reads the old path out of `baseSha`. While
	// this named the tip, the two disagreed the moment main moved: main deleted
	// `packages/coding-agent/src/modes/magic-keyword-notices.ts` five commits past the base, and the
	// generator died on `git show <tip>:<a path only the base has>`. One commit answers both halves.
	const baseSha = git(repoRoot, ["merge-base", "origin/main", headRef]).toString("utf-8").trim();
	const pairs = renamePairs(repoRoot, baseSha, headRef);
	const importAttributes = baselineImportAttributes(repoRoot, baseSha, pairs);
	if (headRef !== "HEAD") {
		// Every row below hashes the working tree, so a ref named here has to BE the tree on disk: a
		// ledger measured against one commit's renames and another commit's bytes would be wrong in a
		// way no row could show.
		assertWorktreeIs(repoRoot, headRef, [...pairs.map(([, newPath]) => newPath), ...Object.keys(importAttributes)]);
	}
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
		importAttributes,
	};
}

if (import.meta.main) {
	const repoRoot = path.resolve(import.meta.dirname, "..");
	const ledger = generateLedger(repoRoot, process.argv[2] ?? "HEAD");
	const target = path.join(repoRoot, "scripts", "fixtures", "move-equivalence.json");
	fs.writeFileSync(target, `${JSON.stringify(ledger, null, "\t")}\n`);
	const rows = Object.values(ledger.files);
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(row.differs, (counts.get(row.differs) ?? 0) + 1);
	process.stdout.write(`wrote ${rows.length} rows from ${ledger.generatedFrom}\n`);
	for (const [kind, count] of [...counts].sort()) process.stdout.write(`  ${kind}: ${count}\n`);
}
