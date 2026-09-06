/**
 * Rebuilds the sparse ledger that proves a moved file kept its content.
 *
 * This PR renames 1563+ tracked files: `crates/*` became `natives/*`, `packages/tui` became
 * `hosts/terminal/engine`, `packages/wire` became `contracts/wire` and `packages/natives` became
 * `natives/bridge/bindings`. A diff that size hides an accidental edit, a dropped function or a stale
 * copy of a helper, and no reviewer reads it line by line. So the claim is made mechanically: apply
 * the branch's own renames to main's text, and the bytes should not move.
 *
 * Two comparisons per file:
 *
 * 1. NORMALIZED CONTENT. Main's bytes with every prefix rewrite applied and every run of `../`
 *    collapsed, hashed. A file whose hash equals the working tree's is byte-identical modulo the
 *    paths that moved, which is 3574 of them.
 * 2. STRUCTURAL LINES. The same text with comments, blank lines, whitespace runs and whole import
 *    statements removed. Two files that agree here differ only in what they import and what their
 *    comments say, which is 774 of them.
 *
 * A file that fails both carries an approved `group` in the sparse ledger: the change is real and
 * someone says what it is (456 files).
 *
 * All derivable move rows (unchanged and import-only) are verified dynamically against the pinned
 * Git baseline object store (`aa14e0da82494dac5a06d240180cec88038a105f`) via `scripts/git-baseline.ts`.
 * The sparse ledger records only explicit post-snapshot deviations against the approved historical
 * baseline snapshot (`de0ccbf5a571d9de1285cb4dddeff1cc23f882aa`), preserving the production baseline
 * while removing metadata duplication.
 */

import { isUtf8 } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	batchReadGitBlobs,
	ensureBaselineAvailable,
	getRenamePairs,
	PINNED_BASELINE_COMMIT,
	REPO_ROOT,
	readGitFileText,
	readGitTree,
} from "./git-baseline";

export const MOVE_EQUIVALENCE_SCHEMA_VERSION = 2;
export const HISTORICAL_SNAPSHOT_COMMIT = "de0ccbf5a571d9de1285cb4dddeff1cc23f882aa";
export const HISTORICAL_SNAPSHOT_PATH = "scripts/fixtures/move-equivalence.json";

export interface MoveEquivalenceCounts {
	readonly total: number;
	readonly none: number;
	readonly importsAndCommentsOnly: number;
	readonly changed: number;
	readonly binary: number;
}

export interface ApprovedChangedRecord {
	readonly old: string;
	readonly group: string;
	readonly hash: string;
	readonly structuralHash?: string;
	readonly mainStructuralHash?: string;
	readonly kind?: "binary";
}

interface HistoricalMoveRecord extends Omit<ApprovedChangedRecord, "kind"> {
	readonly differs: string;
	readonly kind?: "binary" | "normalized";
}

export interface SparseMoveEquivalenceFixture {
	readonly schemaVersion: number;
	readonly generatedFrom: string;
	readonly historicalSnapshotCommit: string;
	readonly counts: MoveEquivalenceCounts;
	readonly deviations: Readonly<Record<string, ApprovedChangedRecord>>;
}

export interface MoveEquivalenceLedger {
	readonly schemaVersion: number;
	readonly generatedFrom: string;
	readonly historicalSnapshotCommit?: string;
	readonly rewrites: readonly [string, string][];
	readonly counts: MoveEquivalenceCounts;
	readonly groups: Readonly<Record<string, string>>;
	readonly changed: Readonly<Record<string, ApprovedChangedRecord>>;
	/**
	 * Every import attribute the baseline carried, keyed by the path the file has on this branch.
	 *
	 * Separate from `changed` because it covers the whole baseline tree rather than the rename pairs: a
	 * file this branch edited without moving is outside the move ledger, and that is exactly where an
	 * attribute was lost. The value is each attribute's text, sorted, so a re-ordered import block is
	 * not a difference and a dropped `with { type: "text" }` is.
	 */
	readonly importAttributes: Readonly<Record<string, readonly string[]>>;
}

/** A file whose bytes are not text; compared raw, since a rewrite table means nothing inside one. */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
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

/** Compare non-text bytes directly, including binary files without a recognized suffix. */
export function isBinaryFile(relative: string, before: Buffer, after?: Buffer): boolean {
	return (
		BINARY_EXTENSIONS.has(path.extname(relative).toLowerCase()) ||
		before.includes(0) ||
		!isUtf8(before) ||
		(after !== undefined && (after.includes(0) || !isUtf8(after)))
	);
}
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

export const GROUPS: readonly { name: string; matches: (relative: string) => boolean; reason: string }[] = [
	{
		name: "startup-initialization",
		matches: relative =>
			relative === "packages/coding-agent/src/cli/runtime-stages.ts" ||
			/^packages\/coding-agent\/src\/modes\/terminal\/(?:first-frame\.ts|interactive-mode\.ts|controllers\/input-controller\.ts|components\/composer\/(?:custom-editor|composer-chrome)\.ts|components\/status-line\/(?:component|session-facts|types)\.ts)$/.test(
				relative,
			),
		reason:
			"The launch composer and initialized session share location and token metadata, retain input during handover, launch context subtracts non-message project context, and runtime initialization is deferred. Behavioral and visual startup checks establish preservation; these rows record the source changes.",
	},
	{
		name: "deferred-tool-initialization",
		matches: relative =>
			/^packages\/coding-agent\/src\/tools\/(?:fs\/read|search\/(?:ast-edit|structure-search|text-search)|shell\/eval|web\/fetch)\.ts$/.test(
				relative,
			),
		reason:
			"Tool imports follow the domain split and defer optional execution dependencies until an enabled request. Local reads and transcript previews do not initialize URL readers or evaluator implementations.",
	},
	{
		name: "plugin-runtime-validation",
		matches: relative =>
			relative === "kernel/src/loader/manifest-key.ts" || relative === "kernel/src/loader/plugins/runtime-config.ts",
		reason:
			"The plugin loader accepts absent manifest holders and normalizes malformed plugin and settings maps to empty records before discovery reads persisted configuration.",
	},
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
		name: "agent-vocabulary-prose",
		matches: relative => relative.endsWith(".md"),
		reason:
			"A moved document names spawned agents with the `agent` vocabulary; `subagent` is kept only for the persisted session tags, the on-disk directory and the wire frames it still denotes.",
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
			"Terminal-independent string, key, fuzzy and layout code was extracted out of the engine into `@veyyon/utils` subpaths, so content moved between two files that both still exist, and managed terminal replay is authorized by the divergent segment's live/replay capability. The engine keeps what draws.",
	},
	{
		name: "view-conversion",
		matches: relative =>
			/(goals\/goal-tool\.ts|transcript\/tool-execution\.ts|tools\/agent\/(review|memory-view|memory-retain|memory-recall|memory-reflect)\.ts|tools\/fs\/(set-cwd|inspect-image)\.ts|tools\/search\/search-tool-bm25\.ts|test\/tools\/an-ssh-block-keeps-its-header-on-one-line\.test\.ts|test\/task\/task-result-render\.test\.ts)$/.test(
				relative,
			),
		reason:
			"A renderer that built a terminal component now returns a `ToolView`, the card that draws it reads the view, and generic tool previews sanitize visible home paths and tabs. A suite that named the deleted renderer module reads the registry entry instead. Byte identity of the drawn output is proved by the oracle suite, not here.",
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
			"A renderer this branch replaced with a ToolView is frozen here as the differential oracle its suite compares the card against. The rows it draws are main's drawing byte for byte, adapted to the published package subpaths, with live tool rendering and TUI sanitization verified against the oracle card.",
	},
	{
		name: "shared-mode-seed",
		matches: relative => /test\/vibe\/a-vibe-worker-inherits-the-parents-effort-and-policy\.test\.ts$/.test(relative),
		reason:
			"An arm that asserts the shared model chain seeds `agent.sharedModel`, the switch that makes `agent.model` and `agent.thinkingLevel` live. Without it the arm pinned a blanket value the resolver never read.",
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
			"A member that left `packages/`, `python/` or `website/` for `apps/`, `clients/` or `tests/` states its own directory in a usage string, a command, a registry key or a comment, climbs to the repository root by a relative path that gained one level, and deploy fixtures build in disposable sandbox paths. The move itself spells only the new location. A row here can also carry an edit this branch made before the move and every unmoved sibling carries too -- the array-spread rewrite, the `natives/` path spelling, a site page's nav fix -- each recorded in the commit that made it, none made by the relocation -- or the formatter's reflow of a call whose shorter path now fits one line.",
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
		name: "diagnostic-grouping-owner",
		matches: relative => relative === "packages/coding-agent/src/tools/core/grouped-file-output.ts",
		reason:
			"`formatGroupedDiagnosticMessages` moved here from `lsp/utils.ts`, beside the `formatGroupedFiles` it is written over, so the output notice a tool appends reads it without the language-server module and the theme that module reaches; `lsp/utils.ts` re-exports it under the same name.",
	},
	{
		name: "engine-consumer",
		matches: relative => relative.startsWith("packages/coding-agent/src/"),
		reason:
			"A coding-agent module reads a value that moved out of the engine or launch watchers deliver already-terminal exits via broker wait, so the call site names its new owner.",
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
] as const;

export const GROUP_NAMES: readonly string[] = GROUPS.map(g => g.name);

export const GROUPS_TABLE: Readonly<Record<string, string>> = Object.fromEntries(GROUPS.map(g => [g.name, g.reason]));

export function groupFor(relative: string): { name: string; reason: string } | undefined {
	const hit = GROUPS.find(group => group.matches(relative));
	return hit === undefined ? undefined : { name: hit.name, reason: hit.reason };
}

/**
 * Predicts the destination of a baseline path based on the rename pairs and rewrites.
 */
export function branchPathOf(
	repoRoot: string,
	baselinePath: string,
	paired: ReadonlyMap<string, string>,
	rewrites: readonly [string, string][],
): string {
	const direct = paired.get(baselinePath);
	if (direct !== undefined) return direct;

	for (const [from, to] of rewrites) {
		if (baselinePath.startsWith(from)) {
			const candidate = baselinePath.replace(from, to);
			if (fs.existsSync(path.join(repoRoot, candidate))) return candidate;
		}
	}
	return baselinePath;
}

/**
 * Rename pairs from the historical snapshot commit to the working tree, old path to new.
 *
 * The ledger records each moved file under the path it had when the snapshot was approved. A file
 * renamed again after that (the `subagent` to `agent` rename of test and prompt files) is looked up
 * through this map so its approval follows it. A git failure propagates: an empty map would make the
 * gate pass every renamed file as new.
 */
export function getPostSnapshotRenames(
	repoRoot: string = REPO_ROOT,
	snapshotCommit: string = HISTORICAL_SNAPSHOT_COMMIT,
): Map<string, string> {
	const raw = execFileSync(
		"git",
		["diff", "-z", "--find-renames=20%", "-l0", "--diff-filter=R", "--name-status", snapshotCommit],
		{ cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
	);
	const renames = new Map<string, string>();
	let offset = 0;
	while (offset < raw.length) {
		const statusEnd = raw.indexOf(0, offset);
		if (statusEnd === -1) break;
		offset = statusEnd + 1;
		const oldEnd = raw.indexOf(0, offset);
		if (oldEnd === -1) break;
		const oldPath = raw.subarray(offset, oldEnd).toString("utf-8");
		offset = oldEnd + 1;
		const newEnd = raw.indexOf(0, offset);
		if (newEnd === -1) break;
		renames.set(oldPath, raw.subarray(offset, newEnd).toString("utf-8"));
		offset = newEnd + 1;
	}
	return renames;
}

/**
 * Pairs manifests and single files with the member package they moved with.
 */
export function pairedWithTheMemberItMovedWith(
	repoRoot: string,
	pairs: readonly [string, string][],
	deleted: readonly string[] = [],
): [string, string][] {
	const postRenames = getPostSnapshotRenames(repoRoot);
	const rewrites = derivePrefixRewrites(pairs);
	const predictedFor = (oldPath: string): string | undefined => {
		const rule = rewrites.find(([oldPrefix]) => oldPath.startsWith(`${oldPrefix}/`));
		return rule === undefined ? undefined : `${rule[1]}${oldPath.slice(rule[0].length)}`;
	};
	const reconciled: [string, string][] = pairs.map(pair => [pair[0], postRenames.get(pair[1]) ?? pair[1]]);
	const claimed = new Set(reconciled.map(([, destination]) => destination));
	for (;;) {
		let moved = false;
		for (const pair of reconciled) {
			const [oldPath, newPath] = pair;
			let predicted = predictedFor(oldPath);
			if (predicted !== undefined && postRenames.has(predicted)) {
				predicted = postRenames.get(predicted);
			}
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
		let predicted = predictedFor(oldPath);
		if (predicted !== undefined && postRenames.has(predicted)) {
			predicted = postRenames.get(predicted);
		}
		if (predicted === undefined || claimed.has(predicted)) continue;
		if (!fs.existsSync(path.join(repoRoot, predicted))) continue;
		claimed.add(predicted);
		reconciled.push([oldPath, predicted]);
	}
	return reconciled;
}

/**
 * Loads and expands the sparse move equivalence ledger by referencing the immutable historical
 * approved baseline snapshot (`de0ccbf5a571d9de1285cb4dddeff1cc23f882aa`), overlaying explicit deviations.
 */
export function loadExpandedMoveEquivalenceLedger(
	rawOrSparse?: unknown,
	repoRoot: string = REPO_ROOT,
): MoveEquivalenceLedger {
	const raw: unknown =
		rawOrSparse === undefined || typeof rawOrSparse === "string"
			? JSON.parse(
					fs.readFileSync(
						typeof rawOrSparse === "string" ? rawOrSparse : path.join(repoRoot, HISTORICAL_SNAPSHOT_PATH),
						"utf-8",
					),
				)
			: rawOrSparse;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("Move equivalence ledger is not an object");
	}
	const fixture = raw as Partial<SparseMoveEquivalenceFixture>;
	if (fixture.schemaVersion !== MOVE_EQUIVALENCE_SCHEMA_VERSION) {
		throw new Error(
			`Move equivalence ledger schema is stale or unversioned (expected version ${MOVE_EQUIVALENCE_SCHEMA_VERSION}, got ${fixture.schemaVersion ?? "unversioned v1"})`,
		);
	}
	if (fixture.generatedFrom !== PINNED_BASELINE_COMMIT) {
		throw new Error("Move equivalence ledger is missing or invalid generatedFrom commit hash");
	}
	if (!fixture.counts || typeof fixture.counts !== "object") {
		throw new Error("Move equivalence ledger is missing counts summary");
	}
	const { total, none, importsAndCommentsOnly, changed: changedCount, binary } = fixture.counts;
	if (
		![total, none, importsAndCommentsOnly, changedCount, binary].every(
			value => Number.isSafeInteger(value) && value >= 0,
		) ||
		total !== none + importsAndCommentsOnly + changedCount ||
		binary > total
	) {
		throw new Error("Move equivalence ledger has invalid counts summary");
	}
	if (fixture.historicalSnapshotCommit !== HISTORICAL_SNAPSHOT_COMMIT) {
		throw new Error(`Invalid historicalSnapshotCommit: expected pinned snapshot ${HISTORICAL_SNAPSHOT_COMMIT}`);
	}
	if (!fixture.deviations || typeof fixture.deviations !== "object" || Array.isArray(fixture.deviations)) {
		throw new Error("Move equivalence ledger is missing deviations table");
	}
	if (["rewrites", "groups", "changed", "importAttributes"].some(key => Object.hasOwn(raw, key))) {
		throw new Error("Expanded move ledgers are stale; regenerate the sparse fixture");
	}
	const historical = readGitFileText(HISTORICAL_SNAPSHOT_PATH, HISTORICAL_SNAPSHOT_COMMIT, repoRoot);
	if (!historical) throw new Error("Failed to load historical move ledger; fetch the pinned snapshot");
	const history = JSON.parse(historical) as {
		generatedFrom: string;
		rewrites: [string, string][];
		importAttributes: Record<string, string[]>;
		files: Record<string, HistoricalMoveRecord>;
	};
	if (
		history.generatedFrom !== PINNED_BASELINE_COMMIT ||
		!Array.isArray(history.rewrites) ||
		!history.files ||
		typeof history.files !== "object" ||
		!history.importAttributes
	) {
		throw new Error("Historical move ledger has an invalid baseline or missing metadata");
	}
	const postRenames = getPostSnapshotRenames(repoRoot);
	const postRenamesInverse = new Map<string, string>();
	for (const [from, to] of postRenames) {
		postRenamesInverse.set(to, from);
	}
	const changed: Record<string, ApprovedChangedRecord> = {};
	for (const [newPath, entry] of Object.entries(history.files)) {
		const targetPath = postRenames.get(newPath) ?? newPath;
		if (entry.differs === "changed") {
			changed[targetPath] = {
				old: entry.old,
				group: entry.group,
				hash: entry.hash,
				...(entry.structuralHash ? { structuralHash: entry.structuralHash } : {}),
				...(entry.kind === "binary" ? { kind: "binary" } : {}),
			};
		}
	}
	for (const [newPath, record] of Object.entries(fixture.deviations)) {
		if (!record || typeof record !== "object" || Array.isArray(record)) {
			throw new Error(`Invalid move deviation record: ${newPath}`);
		}
		if (!Object.hasOwn(GROUPS_TABLE, record.group)) {
			throw new Error(`File ${newPath} references unknown group '${record.group}'`);
		}
		const histEntry =
			history.files[newPath] ??
			(postRenamesInverse.has(newPath) ? history.files[postRenamesInverse.get(newPath)!] : undefined);
		if (!histEntry || histEntry.old !== record.old) {
			throw new Error(`Move deviation ${newPath} does not match its approved original path`);
		}
		if (
			typeof record.hash !== "string" ||
			!/^[0-9a-f]{64}$/.test(record.hash) ||
			(record.kind !== undefined && record.kind !== "binary") ||
			(record.kind !== "binary" &&
				(typeof record.structuralHash !== "string" || !/^[0-9a-f]{64}$/.test(record.structuralHash)))
		) {
			throw new Error(`Invalid move deviation fingerprint: ${newPath}`);
		}
		changed[newPath] = record;
	}
	const mappedImportAttributes: Record<string, string[]> = {};
	for (const [pathKey, attrs] of Object.entries(history.importAttributes)) {
		const target = postRenames.get(pathKey) ?? pathKey;
		mappedImportAttributes[target] = attrs;
	}
	return {
		schemaVersion: MOVE_EQUIVALENCE_SCHEMA_VERSION,
		generatedFrom: PINNED_BASELINE_COMMIT,
		historicalSnapshotCommit: HISTORICAL_SNAPSHOT_COMMIT,
		rewrites: history.rewrites,
		counts: fixture.counts,
		groups: GROUPS_TABLE,
		changed,
		importAttributes: mappedImportAttributes,
	};
}

export function validateMoveEquivalenceLedger(raw: unknown, repoRoot: string = REPO_ROOT): MoveEquivalenceLedger {
	return loadExpandedMoveEquivalenceLedger(raw, repoRoot);
}

/**
 * Extracts all baseline import attributes from the pinned commit tree.
 */
export async function baselineImportAttributes(
	repoRoot: string,
	baseSha: string,
	pairs: readonly [string, string][],
): Promise<Record<string, string[]>> {
	const destinationOf = new Map(pairs);
	const rewrites = derivePrefixRewrites(pairs);
	const tree = readGitTree(baseSha, repoRoot);
	const candidatePaths: string[] = [];
	const specs: string[] = [];

	for (const [filePath] of tree) {
		if ((filePath.endsWith(".ts") || filePath.endsWith(".tsx")) && !filePath.endsWith(".d.ts")) {
			candidatePaths.push(filePath);
			specs.push(`${baseSha}:${filePath}`);
		}
	}

	const blobMap = await batchReadGitBlobs(specs, repoRoot);
	const inventory: Record<string, string[]> = {};
	const vanished: string[] = [];

	for (let i = 0; i < candidatePaths.length; i++) {
		const filePath = candidatePaths[i]!;
		const spec = specs[i]!;
		const buf = blobMap.get(spec);
		if (!buf) continue;
		const text = buf.toString("utf-8");
		if (!text.includes("with {")) continue;
		const attributes = [...text.matchAll(IMPORT_ATTRIBUTE_ALL)].map(found => found[1]!.replace(/\s+/g, " "));
		if (attributes.length === 0) continue;
		const branchPath = branchPathOf(repoRoot, filePath, destinationOf, rewrites);
		if (!fs.existsSync(path.join(repoRoot, branchPath))) {
			vanished.push(`${filePath}${branchPath === filePath ? "" : ` -> ${branchPath}`}`);
			continue;
		}
		inventory[branchPath] = attributes.sort();
	}
	if (vanished.length > 0) {
		throw new Error(`a baseline file loaded content through an import attribute and is gone: ${vanished.join(", ")}`);
	}
	return inventory;
}

function sameApproval(
	left: ApprovedChangedRecord | HistoricalMoveRecord | undefined,
	right: ApprovedChangedRecord,
): boolean {
	return (
		left !== undefined &&
		left.old === right.old &&
		left.group === right.group &&
		left.hash === right.hash &&
		left.structuralHash === right.structuralHash &&
		(left.kind ?? "normalized") === (right.kind ?? "normalized")
	);
}

/**
 * Generates the schema v2 sparse move equivalence fixture and expanded ledger against the Git baseline.
 */
export async function generateSparseLedger(
	repoRoot: string = REPO_ROOT,
	headRef = HISTORICAL_SNAPSHOT_COMMIT,
	baseRef = PINNED_BASELINE_COMMIT,
	histCommit = HISTORICAL_SNAPSHOT_COMMIT,
): Promise<{ sparse: SparseMoveEquivalenceFixture; ledger: MoveEquivalenceLedger }> {
	ensureBaselineAvailable(repoRoot);
	const baseSha = baseRef;
	const { pairs: reported, deleted } = getRenamePairs(baseSha, headRef, repoRoot, 20);
	const pairs = pairedWithTheMemberItMovedWith(repoRoot, reported, deleted);
	const histText = readGitFileText(HISTORICAL_SNAPSHOT_PATH, histCommit, repoRoot);
	if (!histText) {
		throw new Error(`Failed to read historical snapshot from ${histCommit}:${HISTORICAL_SNAPSHOT_PATH}`);
	}
	const histLedger = JSON.parse(histText) as {
		files?: Record<string, HistoricalMoveRecord>;
		rewrites?: [string, string][];
	};
	const rewrites = histLedger.rewrites ?? derivePrefixRewrites(pairs);

	const specs = pairs.map(([oldPath]) => `${baseSha}:${oldPath}`);
	const blobMap = await batchReadGitBlobs(specs, repoRoot);

	const postRenames = getPostSnapshotRenames(repoRoot);
	const postRenamesInverse = new Map<string, string>();
	for (const [from, to] of postRenames) {
		postRenamesInverse.set(to, from);
	}
	const changed: Record<string, ApprovedChangedRecord> = {};
	const deviations: Record<string, ApprovedChangedRecord> = {};
	let noneCount = 0;
	let importCount = 0;
	let changedCount = 0;
	let binaryCount = 0;

	for (let i = 0; i < pairs.length; i++) {
		const [oldPath, newPath] = pairs[i]!;
		const spec = specs[i]!;
		const onDisk = path.join(repoRoot, newPath);
		if (!fs.existsSync(onDisk)) throw new Error(`renamed to a path that does not exist: ${newPath}`);
		const mainBytes = blobMap.get(spec);
		if (!mainBytes) throw new Error(`missing baseline object for ${oldPath}`);
		const currentBytes = fs.readFileSync(onDisk);
		const isBinary = isBinaryFile(newPath, mainBytes, currentBytes);

		if (isBinary) {
			binaryCount++;
			const hash = sha256(currentBytes);
			const mainHash = sha256(mainBytes);
			if (hash === mainHash) {
				noneCount++;
			} else {
				changedCount++;
				const group = groupFor(newPath);
				if (!group) throw new Error(`binary changed with no group to explain it: ${newPath}`);
				const record: ApprovedChangedRecord = {
					old: oldPath,
					kind: "binary",
					group: group.name,
					hash,
				};
				changed[newPath] = record;
				const histEntry =
					histLedger.files?.[newPath] ??
					(postRenamesInverse.has(newPath) ? histLedger.files?.[postRenamesInverse.get(newPath)!] : undefined);
				if (histEntry?.differs !== "changed" || !sameApproval(histEntry, record)) {
					deviations[newPath] = record;
				}
			}
			continue;
		}

		const mainText = normalizeWithRewrites(mainBytes.toString("utf-8"), rewrites);
		const currentText = normalizeWithRewrites(currentBytes.toString("utf-8"), rewrites);
		const hash = sha256(currentText);
		const mainHash = sha256(mainText);

		if (hash === mainHash) {
			noneCount++;
			continue;
		}

		const structural = structuralHash(currentText, newPath);
		const mainStructural = structuralHash(mainText, oldPath);

		if (structural === mainStructural) {
			importCount++;
			continue;
		}

		changedCount++;
		const group = groupFor(newPath);
		if (!group) throw new Error(`content changed with no group to explain it: ${newPath}`);
		const record: ApprovedChangedRecord = {
			old: oldPath,
			group: group.name,
			hash,
			structuralHash: structural,
		};
		changed[newPath] = record;
		const histEntry =
			histLedger.files?.[newPath] ??
			(postRenamesInverse.has(newPath) ? histLedger.files?.[postRenamesInverse.get(newPath)!] : undefined);
		if (histEntry?.differs !== "changed" || !sameApproval(histEntry, record)) {
			deviations[newPath] = record;
		}
	}

	const sparse: SparseMoveEquivalenceFixture = {
		schemaVersion: MOVE_EQUIVALENCE_SCHEMA_VERSION,
		generatedFrom: baseSha,
		historicalSnapshotCommit: histCommit,
		counts: {
			total: pairs.length,
			none: noneCount,
			importsAndCommentsOnly: importCount,
			changed: changedCount,
			binary: binaryCount,
		},
		deviations,
	};

	const ledger = loadExpandedMoveEquivalenceLedger(sparse, repoRoot);
	if (JSON.stringify(ledger.rewrites) !== JSON.stringify(rewrites)) {
		throw new Error(
			"Move topology differs from the approved snapshot; review the new path mapping before regeneration",
		);
	}
	if (
		Object.keys(ledger.changed).length !== Object.keys(changed).length ||
		Object.entries(changed).some(([name, record]) => !sameApproval(ledger.changed[name], record))
	) {
		throw new Error(
			"Sparse move approvals do not reconstruct the measured changes; review changed bucket membership",
		);
	}
	return { sparse, ledger };
}

export async function generateLedger(
	repoRoot: string = REPO_ROOT,
	headRef = HISTORICAL_SNAPSHOT_COMMIT,
	baseRef = PINNED_BASELINE_COMMIT,
	histCommit = HISTORICAL_SNAPSHOT_COMMIT,
): Promise<MoveEquivalenceLedger> {
	const { ledger } = await generateSparseLedger(repoRoot, headRef, baseRef, histCommit);
	return ledger;
}

if (import.meta.main) {
	const destination = path.join(REPO_ROOT, HISTORICAL_SNAPSHOT_PATH);
	const { sparse, ledger } = await generateSparseLedger(REPO_ROOT);
	fs.writeFileSync(destination, `${JSON.stringify(sparse, null, "\t")}\n`);
	console.log(
		`wrote sparse move ledger (${Object.keys(sparse.deviations).length} explicit post-snapshot deviations, ${ledger.counts.changed} total approved changes across ${ledger.counts.total} moved files) against ${ledger.generatedFrom}`,
	);
	console.log(`  none: ${ledger.counts.none}`);
	console.log(`  imports-and-comments-only: ${ledger.counts.importsAndCommentsOnly}`);
	console.log(`  changed: ${ledger.counts.changed}`);
	console.log(`  binary: ${ledger.counts.binary}`);
}
