import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { moduleSpecifiersIn, typeOnlyModuleSpecifiersIn } from "@veyyon/utils/module-reach";
import { repoRelative, resolveSpecifier, valueImportSpecifiers } from "./helpers/module-graph";

const SRC = path.join(import.meta.dir, "..", "..", "src");
const SESSION = path.join(SRC, "session");

/**
 * `modes/` is the interactive terminal UI. `session/` is the conversation engine
 * underneath it. The dependency runs one way, UI on top of session, and this
 * asserts it.
 *
 * WHY IT NEEDS A GATE RATHER THAN A CONVENTION. Every violation arrived as one
 * convenient import of something small and true: "does this message mention
 * ultrathink", "what colour is the active theme". Each pulled in a module that
 * also owned a piece of terminal rendering, and through it
 * `modes/keywords/gradient-highlight` and the 108-module theme engine. Three keyword
 * modules did this, each mixing a text predicate with an editor gradient, and
 * `session/agent-session` imported all three. Nothing failed, so nothing objected.
 *
 * The fix in each case was to split the file rather than to argue about the
 * import: detection into a leaf, drawing left where it was, both re-exported from
 * the original path so no other caller had to change. If you are here because this
 * test failed, that is the move to copy. Adding your module to the list below is
 * almost never the right answer, and the list says what each entry had to prove.
 */
const ALLOWED = new Map<string, string>([
	[
		"theme/theme-binding",
		"The live `theme` binding and nothing else. Imports one type and no values, which `test/theme/theme-binding-stays-live.test.ts` asserts, so it cannot bring the engine back.",
	],
	[
		"modes/keywords/orchestrate-keyword",
		"Detection half of the `orchestrate` keyword. The gradient that paints it stays in `modes/keywords/orchestrate`.",
	],
	[
		"modes/keywords/ultrathink-keyword",
		"Detection half of the `ultrathink` keyword. The gradient stays in `modes/keywords/ultrathink`.",
	],
	[
		"modes/keywords/workflow-keyword",
		"Detection half of the `workflowz` keyword, plus the notice renderer. The gradient stays in `modes/keywords/workflow`.",
	],
	// `modes/turn-budget` and `modes/terminal/utils/context-usage` used to be here. Neither
	// was a leaf of anything: the first is a directive parser and the second is token
	// accounting, and both were in `modes/` only because the surfaces that DISPLAY
	// them are. They live in `session/` now, which is what an entry on this list is
	// supposed to become. The `/context` panel that draws the numbers stayed behind
	// in `modes/terminal/utils/context-usage.ts` and imports them from `session/`, so the
	// dependency points the way this suite says it should.
]);

/*
 * THE EXTRACTION IS NOT DEFINED HERE. It used to be, as a copy of two patterns, and the first of them was
 * the buggy version: a `[\s\S]*?` middle does not stop at the end of a statement, so a non-re-export
 * `export` ran forward to the next `from "…"` in the file and every real import inside the swallowed span
 * went unexamined. This gate is an absence check, so a hidden import PASSES.
 * `@veyyon/utils/module-reach` owns the extraction and
 * `packages/utils/test/module-reach-reads-code-not-prose.test.ts` pins both directions of that bug.
 */

/** Every `.ts` file under `session/`, recursively. */
function sessionFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sessionFiles(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/**
 * Specifiers a file imports at runtime, resolved to `src`-relative module paths
 * inside the terminal UI: `modes/` and `theme/`. The palette is filed beside
 * the modes because the HTML export and the headless modes read it too, and a
 * session file reaching it is the same crossing wherever it sits.
 */
function uiImportsIn(file: string): string[] {
	const found: string[] = [];
	for (const specifier of specifiersIn(file)) {
		if (!specifier.startsWith(".")) continue;
		const resolved = path.resolve(path.dirname(file), specifier);
		const rel = path.relative(SRC, resolved).replace(/\\/g, "/");
		if (rel.startsWith("modes/") || rel.startsWith("theme/")) found.push(rel);
	}
	return found;
}

/** Raw specifiers a file imports at runtime, unresolved. */
function specifiersIn(file: string): string[] {
	return moduleSpecifiersIn(fs.readFileSync(file, "utf-8"));
}

describe("session does not import the terminal UI", () => {
	const files = sessionFiles(SESSION);

	/**
	 * Anti-vacuity first. A bug in the walker or the pattern would make every case
	 * below pass by finding nothing, and this is the whole suite's foundation.
	 */
	it("reads a real, non-trivial set of session modules", () => {
		expect(files.length).toBeGreaterThan(10);
		expect(files.some(file => file.endsWith("agent-session.ts"))).toBe(true);
	});

	/**
	 * The rule. Reported as a list of `file -> module` pairs rather than one
	 * boolean, because the useful information on failure is which import to look at.
	 */
	it("imports nothing from modes/ outside the allowed leaves", () => {
		const violations: string[] = [];
		for (const file of files) {
			for (const target of uiImportsIn(file)) {
				if (ALLOWED.has(target)) continue;
				violations.push(`${path.relative(SRC, file)} -> ${target}`);
			}
		}

		expect(violations).toEqual([]);
	});

	/**
	 * The allow-list stays honest. An entry that no session file imports any more is
	 * a door left open: it reads as sanctioned, so the next person adds an import to
	 * it rather than asking whether the layering is right.
	 */
	it("has no stale entries in the allow-list", () => {
		const used = new Set(files.flatMap(uiImportsIn));
		const unused = [...ALLOWED.keys()].filter(allowed => !used.has(allowed));

		expect(unused).toEqual([]);
	});

	/**
	 * The one that actually holds the line, and the reason the rule is worth a test
	 * rather than a comment. `gradient-highlight` reaches the theme engine, and the
	 * three keyword leaves exist precisely so that nothing in `session/` reaches it.
	 * A leaf that re-acquired the import would still satisfy the allow-list above.
	 *
	 * Matched against the IMPORTS, not the raw text: each of these files explains in
	 * a comment why it does not import the highlighter, and naming it there is
	 * correct. A substring check over the whole source fails on the explanation.
	 */
	it.each([
		"modes/keywords/orchestrate-keyword",
		"modes/keywords/ultrathink-keyword",
		"modes/keywords/workflow-keyword",
	])("%s does not import the gradient highlighter", relative => {
		const file = path.join(SRC, `${relative}.ts`);

		expect(uiImportsIn(file).concat(specifiersIn(file))).not.toContain("./gradient-highlight");
	});
});

/**
 * The same boundary, stated against the TUI PACKAGE rather than this package's
 * terminal tree, and the reason a GUI can attach where the terminal does.
 *
 * `modes/` was only ever the near half of the crossing. A session file that
 * imported `@veyyon/tui` directly satisfied every case above and still made the
 * engine unusable without a terminal: `session/session-paths.ts` took a session
 * id from a TTY, and `session/image-visibility.ts` read a rendering singleton to
 * tell the model whether a picture reached the screen. The first was a string
 * function filed in the wrong package and moved to `@veyyon/utils/ttyid`; the
 * second was a question only the client can answer, so the client installs the
 * answer through `setImageDisplayProbe` and an uninstalled probe means "draws
 * nothing", which is what a piped run does.
 *
 * Runtime and erased edges are separated because they are different claims. A
 * type-only edge costs nothing at runtime and blocks no front end; a runtime one
 * puts a terminal renderer in the engine's graph.
 */
describe("the conversation engine does not instantiate the TUI package", () => {
	const TASK = path.join(SRC, "task");
	const engineFiles = [...sessionFiles(SESSION), ...sessionFiles(TASK)];

	/** Runtime and type-only `@veyyon/tui` specifiers, as `file -> specifier` rows. */
	function tuiEdges(kind: "runtime" | "type"): string[] {
		const rows: string[] = [];
		for (const file of engineFiles) {
			const source = fs.readFileSync(file, "utf-8");
			const found = kind === "runtime" ? moduleSpecifiersIn(source) : typeOnlyModuleSpecifiersIn(source);
			for (const specifier of found) {
				if (!specifier.startsWith("@veyyon/tui")) continue;
				rows.push(`${path.relative(SRC, file).replace(/\\/g, "/")} -> ${specifier}`);
			}
		}
		return [...new Set(rows)].sort();
	}

	/**
	 * No runtime edge is left, pinned by exact equality so the first one turns this red.
	 *
	 * `task/render.ts` was the last: 1886 lines of terminal drawing filed under `task/` because the
	 * published renderer signature returned a TUI `Component`. The task tool describes a
	 * `ToolViewRenderer` now, so the drawing is `modes/terminal/draw/draw-tool-view.ts` reading a view, the frozen
	 * copy of what it used to draw is `test/oracles/task-main-renderer.ts`, and the engine names the
	 * package nowhere.
	 */
	const RUNTIME_EDGES: string[] = [];

	/**
	 * No erased edge either, pinned the same way and for the same reason.
	 *
	 * `task/subprocess-tool-registry.ts` declared `renderInline` and `renderFinal`, terminal drawing
	 * typed into the subprocess protocol, consumed by `task/render.ts` beside it and by nothing else.
	 * Neither was reachable — all three registered handlers are skipped by name before the lookup
	 * that would have found them — so both are gone and the registry names a `Theme` no more than it
	 * names a `Component`.
	 */
	const TYPE_EDGES: string[] = [];

	/**
	 * Anti-vacuity. Both cases below are absence checks over a list this walker produces, so a walker
	 * that reads nothing passes them, and the positive control that used to stand here was the very
	 * edge this change removed. So the control is a file OUTSIDE the engine that really does import
	 * the package: the same extractor over `modes/terminal/draw/output-block.ts` finds it, which is what says an
	 * empty result above is a fact about the engine rather than about the reader.
	 */
	it("reads the whole engine, with an extractor that finds a TUI import where one exists", () => {
		expect(engineFiles.length).toBeGreaterThan(40);
		expect(engineFiles.some(file => file.endsWith(`${path.sep}factory-tools.ts`))).toBe(true);
		const drawn = fs.readFileSync(path.join(SRC, "modes", "terminal", "draw", "output-block.ts"), "utf-8");
		expect(moduleSpecifiersIn(drawn).filter(specifier => specifier.startsWith("@veyyon/tui"))).not.toEqual([]);
	});

	it("instantiates the TUI package nowhere in the engine", () => {
		expect(tuiEdges("runtime")).toEqual(RUNTIME_EDGES);
	});

	it("names the TUI package for types nowhere in the engine", () => {
		expect(tuiEdges("type")).toEqual(TYPE_EDGES);
	});

	/**
	 * The two files this suite was written for. Named one by one, because the
	 * equality above would also pass if `session/` grew an edge and `task/render.ts`
	 * lost one. `session-paths.ts` is read from `kernel/`, where the session spine now
	 * owns it, so the case follows the file instead of asserting on a path.
	 */
	it.each([
		path.join(import.meta.dir, "..", "..", "..", "..", "kernel", "src", "session", "session-paths.ts"),
		path.join(SRC, "session", "image-visibility.ts"),
	])("%s names no TUI package at all", file => {
		const source = fs.readFileSync(file, "utf-8");
		const named = [...moduleSpecifiersIn(source), ...typeOnlyModuleSpecifiersIn(source)];

		expect(named.filter(specifier => specifier.startsWith("@veyyon/tui"))).toEqual([]);
	});

	/**
	 * The ledger of what a mode that draws nothing still loads, and the measure of
	 * this boundary's progress.
	 *
	 * `-p` writes text to a pipe and renders no frame, yet its runtime graph
	 * instantiates `@veyyon/tui` through two clusters: the theme engine and the
	 * slash-command registry that reaches a dialog. Each is a front-end concern
	 * filed outside the front end, and each is its own piece of work.
	 *
	 * `session/image-visibility.ts`, `tools/agent/todo.ts`,
	 * `slash-commands/builtin-registry.ts`, `modes/terminal/draw/code-cell.ts`,
	 * `modes/terminal/draw/output-block.ts` and
	 * `modes/terminal/draw/width-aware-text.ts` used to be on this list.
	 * That is the delta those probes bought: a question about a pipe is no longer
	 * answered by loading a renderer, the todo tool's drawing moved to
	 * `tools/agent/todo-view.ts`, which print mode never reaches, the `/collab`
	 * QR block draws its own spacing instead of the registry stacking a terminal
	 * component above it, and the three block helpers that still import the
	 * package are no longer on print mode's graph. Shrink-only -- a row
	 * leaves when the edge is cut, and none is added, so a new module reaching the
	 * package from print mode's graph reds this.
	 *
	 * Walked over VALUE imports only, and that is the whole claim: a type edge is
	 * erased, and following one reports the entire component tree as loaded by a
	 * mode that renders nothing. `reachableFrom` follows every import and is the
	 * wrong tool here for exactly that reason.
	 */
	const PRINT_MODE_TUI_EDGES = [
		"packages/coding-agent/src/modes/terminal/components/dialogs/pause-screen.ts -> @veyyon/tui",
		"packages/coding-agent/src/modes/terminal/draw/hyperlink.ts -> @veyyon/tui/terminal-capabilities",
		"packages/coding-agent/src/theme/theme-class.ts -> @veyyon/tui/terminal-capabilities",
		"packages/coding-agent/src/theme/theme.ts -> @veyyon/tui/terminal-capabilities",
	];

	/** Files print mode loads at runtime, and the TUI edges among them. */
	function printModeRuntimeGraph(): { files: Set<string>; tuiEdges: string[] } {
		const files = new Set<string>();
		const pending = [path.join(SRC, "modes", "print-mode.ts")];
		const tuiEdges: string[] = [];
		while (pending.length > 0) {
			const file = pending.pop();
			if (file === undefined || files.has(file)) continue;
			files.add(file);
			for (const specifier of valueImportSpecifiers(file)) {
				if (specifier.startsWith("@veyyon/tui")) tuiEdges.push(`${repoRelative(file)} -> ${specifier}`);
				const target = resolveSpecifier(file, specifier);
				if (target !== undefined) pending.push(target);
			}
		}
		return { files, tuiEdges: [...new Set(tuiEdges)].sort() };
	}

	it("loads the TUI package only through the recorded front-end clusters", () => {
		const { files, tuiEdges } = printModeRuntimeGraph();

		expect(files.size).toBeGreaterThan(40);
		expect(tuiEdges).toEqual(PRINT_MODE_TUI_EDGES);
	});

	/**
	 * The rule the ledger above is measured against, and the one this PR closes:
	 * whatever else print mode drags in, no part of the conversation engine is in
	 * it. Stated separately because the equality above would still pass if a
	 * `session/` row replaced a front-end one.
	 */
	it("reaches the TUI package through no engine module", () => {
		const engine = printModeRuntimeGraph().tuiEdges.filter(row =>
			/\/src\/(session|task)\//.test(row.slice(0, row.indexOf(" -> "))),
		);

		expect(engine).toEqual([]);
	});
});
