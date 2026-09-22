import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * WHY THIS SUITE EXISTS:
 *
 * A surface token in `crates/veyyon-desktop-tokens/tokens/surface/*.toml` states
 * a geometry value as a scale name — "s10", "hairline" — and not as a number, so
 * a scene that opened the file itself and called `int()` on the value died with a
 * Python ValueError before it captured a frame. Twenty scenes were in that state
 * at once. `proof/scenes/token_px.py` is the one place a token or theme file is
 * read and a name becomes a measure.
 *
 * THE CLASS:
 * 1. A scene naming a key that no longer resolves — a renamed table, a typo, a
 *    scale step deleted from `scale.toml`, a value restated as a name the
 *    resolver does not cover. Every literal read in every scene is extracted at
 *    run time and resolved through the real resolver, so a key that stops
 *    resolving fails here rather than on the X11 screen.
 * 2. A scene going back to reading a token or theme file on its own, with
 *    `tomllib`, `sed` or a path into the tokens crate. The sweep is over every
 *    scene, so a new one is covered the day it lands.
 * 3. A resolver that answers a missing file, a missing key or an unknown scale
 *    name with something other than a failure naming what it looked for.
 *
 * The read counts are pinned per scene: a scene that starts or stops reading
 * tokens turns this red until the list records it.
 *
 * WHAT IT DOES NOT CATCH: whether a resolved measure is the right measure for
 * the frame, the three reads whose key is built at run time from a scene
 * function's argument, and the token files' own validity, which the tokens
 * crate asserts.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCENES_DIR = path.join(REPO_ROOT, "proof/scenes");
const RESOLVER = path.join(SCENES_DIR, "token_px.py");

/** Scenes that resolve a literal token key, and how many reads each one makes. */
const SCENE_READS: Record<string, number> = {
	"desktop-agent-freeze.sh": 3,
	"desktop-agent-roster.sh": 11,
	"desktop-announcement.sh": 6,
	"desktop-appearance.sh": 8,
	"desktop-artifacts.sh": 1,
	"desktop-branch-draft.sh": 5,
	"desktop-change-scope.sh": 2,
	"desktop-changes-tab.sh": 2,
	"desktop-composer.sh": 7,
	"desktop-cut-diff.sh": 3,
	"desktop-danger-row.sh": 4,
	"desktop-decision-card.sh": 5,
	"desktop-detail.sh": 1,
	"desktop-diff-intraline.sh": 3,
	"desktop-drawer-failure.sh": 4,
	"desktop-drawer-opens-terminal.sh": 4,
	"desktop-empty-copy.sh": 6,
	"desktop-export-header.sh": 5,
	"desktop-live-edge-pill.sh": 1,
	"desktop-long-refusal.sh": 6,
	"desktop-menu-hover.sh": 4,
	"desktop-mono-pane.sh": 4,
	"desktop-navigation.sh": 1,
	"desktop-new-terminal.sh": 5,
	"desktop-panel-failure.sh": 3,
	"desktop-process-send.sh": 5,
	"desktop-process-signal.sh": 5,
	"desktop-process-start.sh": 4,
	"desktop-rail-footer.sh": 3,
	"desktop-rail-search.sh": 6,
	"desktop-reduced-motion.sh": 6,
	"desktop-session-mode.sh": 1,
	"desktop-session-transcript.sh": 4,
	"desktop-session-workflows.sh": 2,
	"desktop-settings-body.sh": 8,
	"desktop-settings-chrome.sh": 6,
	"desktop-settings-column.sh": 6,
	"desktop-settings-field.sh": 6,
	"desktop-settings-keybinding.sh": 10,
	"desktop-settings-refusal.sh": 6,
	"desktop-settings-row.sh": 8,
	"desktop-split-grip.sh": 3,
	"desktop-streamed-shape.sh": 4,
	"desktop-surface-navigation.sh": 4,
	"desktop-tab-restate.sh": 2,
	"desktop-terminal-width.sh": 6,
	"desktop-transcript-prose.sh": 3,
	"desktop-turn-control.sh": 1,
	"desktop-turn-fork.sh": 4,
	"desktop-unsent-rail.sh": 6,
	"desktop-workspace-restate.sh": 2,
};

/**
 * Scenes whose key is a function argument rather than a literal, so the key
 * itself cannot be resolved from the source. The file they read is still
 * checked, and the count is pinned so a fourth one is a decision.
 */
const SCENE_DYNAMIC_READS: Record<string, number> = {
	"desktop-composer.sh": 2,
	"desktop-question-answer.sh": 1,
};

/** How a read is resolved, and what shape its answer must have. */
type ReadKind = "integer" | "measure" | "text";

interface TokenRead {
	scene: string;
	kind: ReadKind;
	file: string;
	key: string;
}

const KEYED = /token_px\.(value_of|measure_of|text_of)\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*\)/g;
const NAMED = /token_px\.(px|measure)\(\s*["']([^"']+)["']\s*\)/g;
const CLI = /token_px\.py"?\s*\\?\s*\n?\s*--text\s+(\S+)\s+([\w."'$]+)/g;
const LITERAL_KEY = /^[A-Za-z][\w.]*$/;

const KEYED_KIND: Record<string, ReadKind> = {
	value_of: "integer",
	measure_of: "measure",
	text_of: "text",
};

/** Every scene, with the source the sweeps read. */
const SCENE_SOURCES: { scene: string; source: string }[] = fs
	.readdirSync(SCENES_DIR)
	.filter(name => name.endsWith(".sh"))
	.sort()
	.map(scene => ({
		scene,
		source: fs.readFileSync(path.join(SCENES_DIR, scene), "utf-8"),
	}));

/** Every read a scene states with a literal key, and the kind it reads it as. */
function sceneTokenReads(): TokenRead[] {
	const reads: TokenRead[] = [];
	for (const { scene, source } of SCENE_SOURCES) {
		for (const match of source.matchAll(KEYED)) {
			const kind = KEYED_KIND[match[1]];
			if (kind === undefined) throw new Error(`unknown resolver call ${match[1]}`);
			reads.push({ scene, kind, file: match[2], key: match[3] });
		}
		for (const match of source.matchAll(NAMED)) {
			const kind: ReadKind = match[1] === "px" ? "integer" : "measure";
			reads.push({ scene, kind, file: "scale.toml", key: match[2] });
		}
		for (const match of source.matchAll(CLI)) {
			if (!LITERAL_KEY.test(match[2])) continue;
			reads.push({ scene, kind: "text", file: match[1], key: match[2] });
		}
	}
	return reads;
}

/** Every read whose key the scene builds at run time. */
function dynamicReads(): { scene: string; file: string }[] {
	const reads: { scene: string; file: string }[] = [];
	for (const { scene, source } of SCENE_SOURCES) {
		for (const match of source.matchAll(CLI)) {
			if (LITERAL_KEY.test(match[2])) continue;
			reads.push({ scene, file: match[1] });
		}
	}
	return reads;
}

function counted(entries: { scene: string }[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const entry of entries) {
		counts[entry.scene] = (counts[entry.scene] ?? 0) + 1;
	}
	return counts;
}

function resolverArgs(read: TokenRead): string[] {
	if (read.file === "scale.toml" && !read.key.includes(".")) {
		return read.kind === "measure" ? ["--measure", read.key] : [read.key];
	}
	if (read.kind === "text") return ["--text", read.file, read.key];
	if (read.kind === "measure") return ["--measure", read.file, read.key];
	return ["--resolve", read.file, read.key];
}

function resolve(args: string[]): string {
	return execFileSync("python3", [RESOLVER, ...args], {
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	}).trim();
}

function resolveStderr(args: string[]): string {
	try {
		execFileSync("python3", [RESOLVER, ...args], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		const failure = error as { stderr?: string };
		return failure.stderr ?? "";
	}
	throw new Error(`the resolver answered ${args.join(" ")} instead of failing`);
}

const SHAPE: Record<ReadKind, RegExp> = {
	integer: /^-?\d+$/,
	measure: /^-?\d+(\.\d+)?$/,
	text: /^\S.*$/,
};

describe("a scene reads a token through the resolver", () => {
	const reads = sceneTokenReads();

	it("reads tokens in the scenes the list records, and in no other", () => {
		expect(counted(reads)).toEqual(SCENE_READS);
	});

	it("builds a key at run time only in the scenes the list records", () => {
		expect(counted(dynamicReads())).toEqual(SCENE_DYNAMIC_READS);
	});

	it("opens no token or theme file except through the resolver", () => {
		const offenders: string[] = [];
		for (const { scene, source } of SCENE_SOURCES) {
			// A comment opens nothing. The recorded command a scene documents names the before-tree
			// it was captured against, tokens crate and all, and reporting that line as a direct
			// read leaves the scene's own instructions unwritable.
			const code = source
				.split("\n")
				.filter(line => !/^\s*#/.test(line))
				.join("\n");
			if (code.includes("tomllib")) offenders.push(`${scene}: parses a token file itself`);
			if (code.includes("crates/veyyon-desktop-tokens")) {
				offenders.push(`${scene}: names a path into the tokens crate`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("resolves every key a scene names to a value of the shape it reads it as", () => {
		const unresolved: string[] = [];
		for (const read of reads) {
			let resolved: string;
			try {
				resolved = resolve(resolverArgs(read));
			} catch (error) {
				unresolved.push(`${read.scene}: ${read.file} ${read.key} raised ${error}`);
				continue;
			}
			if (!SHAPE[read.kind].test(resolved)) {
				unresolved.push(`${read.scene}: ${read.file} ${read.key} gave ${resolved}`);
			}
		}
		expect(unresolved).toEqual([]);
	});

	it("loads the file every run-time key is read from", () => {
		const unreadable: string[] = [];
		for (const read of dynamicReads()) {
			const stderr = resolveStderr(["--text", read.file, "no_such_key_the_scene_would_ask_for"]);
			if (stderr.includes("token file not found")) {
				unreadable.push(`${read.scene}: ${read.file} is not a token file`);
			}
		}
		expect(unreadable).toEqual([]);
	});

	it("resolves a scale name to the step the scale states", () => {
		const scale = fs.readFileSync(path.join(REPO_ROOT, "crates/veyyon-desktop-tokens/tokens/scale.toml"), "utf-8");
		const step = scale.match(/^s10\s*=\s*(\d+)/m)?.[1];
		if (step === undefined) throw new Error("scale.toml states no s10 spacing step");
		expect(resolve(["s10"])).toBe(step);
	});

	it("names the key it could not find, and the segment it stopped on", () => {
		const stderr = resolveStderr(["--resolve", "surface/panels.toml", "right_panel.no_such_key"]);
		expect(stderr).toContain("surface/panels.toml");
		expect(stderr).toContain("right_panel.no_such_key");
		expect(stderr).toContain("missing segment 'no_such_key'");
	});

	it("names the token file it could not find, rather than a key inside it", () => {
		const stderr = resolveStderr(["--resolve", "surface/no-such-file.toml", "geometry.gutter"]);
		expect(stderr).toContain("token file not found");
		expect(stderr).toContain("surface/no-such-file.toml");
	});

	it("names a scale step no scale states, rather than resolving it to zero", () => {
		const stderr = resolveStderr(["s_nobody_declared"]);
		expect(stderr).toContain("unknown token scale name");
		expect(stderr).toContain("s_nobody_declared");
	});

	it("refuses a table where a scene asked for text, rather than printing the table", () => {
		const stderr = resolveStderr(["--text", "themes/dark.toml", "role"]);
		expect(stderr).toContain("themes/dark.toml");
		expect(stderr).toContain("rather than text");
	});
});
