/**
 * `tools/` reaches `modes/` only to draw, and only through named leaves.
 *
 * WHY THIS SUITE EXISTS. A tool is domain code: it runs a command, reads a file,
 * calls a model. It also renders its own output block, so unlike `session/` it
 * cannot be forbidden the UI outright, and that partial permission is exactly how
 * the boundary rots. Thirty-two files under `tools/` import from `modes/` today.
 * Every one of them wanted a colour, a truncation, or a pad width, and each import
 * reads as obviously fine on its own; what nobody checks is whether the module on
 * the other end is a drawing leaf or a whole interactive component that happens to
 * export one constant.
 *
 * The rule this file enforces is therefore narrower than "no UI imports": every
 * target must be on the list below, and the list says what each one is FOR. Adding
 * an entry is a decision someone made in writing, not an import someone slipped in.
 *
 * If you are here because this failed, the move to copy is the one
 * `session-does-not-import-the-ui.test.ts` documents: split the file, detection or
 * measurement into a leaf, drawing left where it was. Two modules went further and
 * left `modes/` entirely, `turn-budget` and `context-usage`, because neither drew
 * anything at all.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as contextUsagePanel from "@veyyon/coding-agent/modes/terminal/utils/context-usage";
import * as contextUsageNumbers from "@veyyon/coding-agent/session/context-usage";
import { moduleSpecifiersIn, namedImportsFrom } from "@veyyon/utils/module-reach";
import { toolRenderers } from "../../src/tools/renderers";

const SRC = path.join(import.meta.dir, "..", "..", "src");
const TOOLS = path.join(SRC, "tools");

/**
 * Every `modes/` module a tool may import, and the drawing job it does.
 *
 * The theme entries are the bulk and the least interesting: a tool that prints a
 * coloured block needs the palette, and the palette is the UI's. The component
 * entries are the ones worth reading, because a component directory is where a
 * drawing helper hides next to an interactive surface.
 */
const ALLOWED = new Map<string, string>([
	["theme/theme", "The palette and symbol set. What every coloured tool block is coloured with."],
	[
		"modes/terminal/components/dialogs/hook-editor",
		"One layout constant, `HOOK_EDITOR_TEXT_PAD_COLS`, so the ask tool's block lines up with the editor above it. The editor itself is never constructed here.",
	],
	[
		"modes/terminal/components/chrome/modal-shell",
		"One width query, `mediumModalContentWidth`, so the ask tool pre-wraps its title to the width of the card the editor draws it in. Wrapping at the terminal width instead hands the card lines it wraps a second time. No card is constructed, rendered or hit-tested here.",
	],
]);

/**
 * Two allowed targets are whole interactive components that also export one thing a tool
 * legitimately needs. Module-level permission is too coarse for those: the entry reads as
 * "the ask tool may ask a card how wide it is" and grants "any tool may render a card".
 * The names below are the ONLY specifiers a tool may take out of each, so widening the
 * crossing is a decision recorded here rather than an import added upstream.
 */
const NARROW = new Map<string, readonly string[]>([
	["modes/terminal/components/dialogs/hook-editor", ["HOOK_EDITOR_TEXT_PAD_COLS"]],
	["modes/terminal/components/chrome/modal-shell", ["mediumModalContentWidth"]],
]);

/** Every `.ts` file under `tools/`, recursively. */
function toolFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...toolFiles(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/**
 * Specifiers a file imports at runtime, resolved to `src`-relative module paths
 * inside the terminal UI. That is `modes/` and `theme/`: the palette sits beside
 * the modes rather than under the terminal, because the HTML export and the
 * headless modes read it too, and a tool reaching it is the same crossing
 * wherever it is filed.
 */
function uiImportsIn(file: string): string[] {
	const found: string[] = [];
	for (const specifier of moduleSpecifiersIn(fs.readFileSync(file, "utf-8"))) {
		if (!specifier.startsWith(".")) continue;
		const resolved = path.resolve(path.dirname(file), specifier);
		const rel = path.relative(SRC, resolved).replace(/\\/g, "/");
		if (rel.startsWith("modes/") || rel.startsWith("theme/")) found.push(rel);
	}
	return found;
}

/** Named specifiers a file takes out of one `src`-relative `modes/` module. */
function namesTakenFrom(file: string, target: string): string[] {
	const source = fs.readFileSync(file, "utf-8");
	const found: string[] = [];
	for (const specifier of moduleSpecifiersIn(source)) {
		if (!specifier.startsWith(".")) continue;
		const rel = path.relative(SRC, path.resolve(path.dirname(file), specifier)).replace(/\\/g, "/");
		if (rel === target) found.push(...namedImportsFrom(source, specifier));
	}
	return found;
}

describe("tools reach the terminal UI only to draw", () => {
	const files = toolFiles(TOOLS);

	/**
	 * Anti-vacuity first. Every assertion below is an absence, so a walker that
	 * found no files, or an extractor that found no imports, would pass all of them.
	 */
	it("reads a real set of tool modules, and they really do import the UI", () => {
		expect(files.length).toBeGreaterThan(50);
		const targets = new Set(files.flatMap(uiImportsIn));

		expect(targets.size).toBeGreaterThan(2);
		expect(targets).toContain("theme/theme");
	});

	/**
	 * The rule. Reported as `file -> module` pairs because the useful information on
	 * failure is which import to look at, not that a count moved.
	 */
	it("imports nothing from the terminal UI outside the allowed drawing leaves", () => {
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
	 * The narrow entries stay narrow. Asserted by exact equality per module, so a second
	 * name cannot arrive under a count or a superset match, and a name that stops being
	 * imported has to be struck from the list rather than left reading as sanctioned.
	 */
	it("takes only the sanctioned names out of the two interactive components", () => {
		const taken = new Map<string, string[]>();
		for (const [target] of NARROW) {
			taken.set(target, [...new Set(files.flatMap(file => namesTakenFrom(file, target)))].sort());
		}

		expect(taken).toEqual(new Map([...NARROW].map(([target, names]) => [target, [...names].sort()])));
	});

	/** A narrow rule over a module nobody allowed governs nothing, and reads as if it did. */
	it("narrows only modules the allow-list carries", () => {
		expect([...NARROW.keys()].filter(target => !ALLOWED.has(target))).toEqual([]);
	});

	/**
	 * The list stays honest. An entry nothing imports any more reads as sanctioned,
	 * so the next person adds an import to it rather than asking whether it should
	 * be a UI module at all.
	 */
	it("has no stale entries in the allow-list", () => {
		const used = new Set(files.flatMap(uiImportsIn));
		const unused = [...ALLOWED.keys()].filter(allowed => !used.has(allowed));

		expect(unused).toEqual([]);
	});

	/**
	 * Locks out: the token accounting drifting back under `modes/`, where `session/` would have to
	 * import the UI to reach it. `modes/turn-budget` parsed a directive out of message text and
	 * `modes/terminal/utils/context-usage` counted tokens; neither drew anything, and both were imported by
	 * `session/`, which is not allowed the UI at all. They live under `session/` now.
	 *
	 * Asserted by IMPORTING the two modules and checking which one exports which function, not by
	 * searching either file's text for `export function ...`. A text search passes when the export is
	 * spelled `export const computeContextBreakdown = (...) =>` and fails on a comment that mentions
	 * the name, so it tests neither direction of the thing it claims.
	 */
	it("the panel exports the drawing and the session module exports the accounting", () => {
		expect(typeof contextUsagePanel.renderContextUsage).toBe("function");
		expect(contextUsagePanel).not.toHaveProperty("computeContextBreakdown");
		expect(typeof contextUsageNumbers.computeContextBreakdown).toBe("function");
	});

	/** And `modes/turn-budget.ts` is gone outright, so a revert cannot hide behind a re-export. */
	it("has no turn budget left under modes", () => {
		expect(fs.existsSync(path.join(SRC, "modes/turn-budget.ts"))).toBe(false);
		expect(fs.existsSync(path.join(SRC, "session/turn-budget.ts"))).toBe(true);
	});

	/**
	 * Locks out: the accounting module importing the panel, which is the failure the whole split was
	 * for, and the panel taking a RUNTIME edge on the accounting, which is the half a re-export left
	 * behind in `modes/` would satisfy while pointing `session/` back at the UI.
	 *
	 * Both directions are stated as runtime specifiers. The panel needs only the SHAPES
	 * (`CategoryId`, `ContextBreakdown`), and a type import is erased, so the observable contract is
	 * that the panel names the accounting at no runtime edge at all. That used to be asserted by
	 * searching the panel's source for one exact `import type { ... }` line, which reflowing the
	 * import or adding a third type to it would have broken for no reason.
	 */
	it("has the panel depending on the numbers only as types, and the numbers on nothing in the UI", () => {
		const panel = path.join(SRC, "modes/terminal/utils/context-usage.ts");
		const numbers = path.join(SRC, "session/context-usage.ts");

		expect(uiImportsIn(numbers)).toEqual([]);

		const panelRuntime = moduleSpecifiersIn(fs.readFileSync(panel, "utf-8"));

		expect(panelRuntime).not.toContain("../../session/context-usage");
	});
});

/**
 * Every name `tools/` takes out of `@veyyon/tui`, per file, exactly.
 *
 * WHY THIS SUITE EXISTS, and why it is a second axis rather than a second file. The
 * block above governs `tools/` reaching `modes/` and `theme/`, which is a directory
 * boundary inside this package. This one governs `tools/` reaching the renderer
 * PACKAGE, which is what a second front end cannot follow: a GUI can import
 * `modes/terminal/utils/context-usage` and get numbers, and it cannot import
 * `@veyyon/tui` and get a widget it can draw. Same concern, different boundary, so
 * it lives beside its sibling instead of in a file of its own.
 *
 * WHAT THE ROWS SAY NOW. Three rows are left, and none of them draws: `bash-interactive.ts`,
 * `render-utils.ts` and `renderers.ts` take `type Component` and nothing else, so they bind no host
 * at run time. Every card a tool states is a `ToolView` its host draws, which is why the `-render.ts`
 * siblings that used to fill this ledger are gone and `DRAWS_IN_PLACE` below is empty.
 *
 * A `type ` prefix marks a name erased at compile time. It is recorded rather than
 * skipped because an erased import is still a contract this package cannot change
 * alone, and the whole point of the row is what a second host would have to satisfy.
 * `type Component` is the return type of `renderCall` and `renderResult`, so a module
 * that renders is bound to the terminal by its signature before it draws anything.
 *
 * WHAT THIS DOES NOT CATCH. A tool that reaches the terminal through a re-export
 * rather than by naming `@veyyon/tui`, and a tool that draws by string concatenation
 * instead of a node. The sibling block above covers the first for `modes/`; nothing
 * covers the second, and a renderer that builds ANSI by hand would pass this and
 * still be unusable by a GUI.
 */
const TUI_SURFACE = new Map<string, readonly string[]>([
	["tools/shell/bash-interactive.ts", ["type Component"]],
	["tools/core/render-utils.ts", ["type Component"]],
	["tools/renderers.ts", ["type Component"]],
]);

/**
 * Every name a file takes from `@veyyon/tui`, each prefixed `type ` when it is erased.
 *
 * Written here rather than taken from `namedImportsFrom`, which reports runtime
 * specifiers only and so cannot see the `type Component` that every row carries.
 */
function tuiNamesIn(source: string): string[] {
	const names = new Set<string>();
	const statement = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']@veyyon\/tui[^"']*["']/g;
	for (let hit = statement.exec(source); hit !== null; hit = statement.exec(source)) {
		const wholeStatementIsType = hit[1] !== undefined;
		for (const raw of hit[2].split(",")) {
			const specifier = raw.trim();
			if (specifier === "") continue;
			const inlineType = specifier.startsWith("type ");
			const bare = (inlineType ? specifier.slice(5) : specifier).split(/\s+as\s+/)[0].trim();
			names.add(wholeStatementIsType || inlineType ? `type ${bare}` : bare);
		}
	}
	return [...names].sort();
}

/**
 * The tool modules under `src/tools/` that still construct a terminal value in
 * place. A row here is a decision, not a backlog entry: deleting it is how the
 * split finishes.
 *
 * `tools/agent/ask.ts` used to sit here for reading `TERMINAL` to send a notification.
 * It now emits a `HostNotification` through `ToolSession.notify`, which the running
 * host installs and a host without one leaves undefined, so the row is gone rather
 * than reworded. `tools/agent/review.ts` held the last row: its call and result rows are a
 * `TextBlockView` whose priority mark is a symbol span, so the glyph it needed from
 * the terminal is now a registry key the host resolves.
 *
 * EMPTY IS THE POINT, AND IT STILL FAILS CLOSED. The cell below is an equality
 * against these keys, so a tool that starts drawing in place under `src/tools/` reds
 * it with a one-row diff. An empty ledger is the finished state of the split, not a
 * disabled rule.
 *
 * Scoped to `src/tools/`, like `TUI_SURFACE` above. `IN_PLACE_ANYWHERE` below is
 * the same rule asked of the whole tree, and it is the one that fails on a tool
 * shipped from another directory.
 */
const DRAWS_IN_PLACE = new Map<string, string>([]);

/**
 * The terminal's own drawing layer, which the naming convention does not name.
 *
 * `modes/terminal/draw/draw-tool-view.ts` declares `renderCall` and `renderResult` because `viewToolRenderer` builds
 * the terminal's registry entry for a tool that returns a view: those two members are the registry's
 * shape, and this module is the drawer every rule in this file directs a tool toward. Recording it as
 * a tool drawing in place would be a row nobody could ever delete.
 *
 * Pinned by equality, so a second drawer under `modes/terminal/draw/` is recorded here rather than absorbed silently,
 * and asserted to be a module the sweep actually returned.
 */
const TERMINAL_DRAWERS = new Set(["modes/terminal/draw/draw-tool-view.ts"]);

/**
 * The registry module, which declares the renderer SHAPE rather than a card.
 *
 * `tools/renderers.ts` types `renderCall`, `renderResult` and the optional `view` a converted entry
 * carries, so the sweep sees it declaring renderers and the view contract in one file, and it would
 * otherwise read as a tool converted to a view. It is neither a tool nor a drawer: it is the table
 * the terminal resolves a card through. Pinned by equality below, so a second module reaching this
 * shape is recorded rather than absorbed.
 */
const REGISTRY_MODULES = new Set(["tools/renderers.ts"]);

/** A module whose job is drawing, by the naming convention every split follows. */
function isRenderModule(file: string): boolean {
	if (TERMINAL_DRAWERS.has(file)) return true;
	const base = file.slice(file.lastIndexOf("/") + 1);
	return (
		base.endsWith("-render.ts") || base.endsWith("-renderer.ts") || base === "render.ts" || base === "render-utils.ts"
	);
}

/**
 * Every module under `src/` that DECLARES a tool renderer, whatever directory it
 * sits in.
 *
 * WHY THIS EXISTS SEPARATELY. Every cell above is scoped to `src/tools/`, and that
 * scope was the hole, not a simplification. A tool is not a directory: `AgentTool`
 * objects also ship from `autoresearch/tools/`, `goals/`, `web/search/`, `edit/`
 * and `mcp/`, and a renderer declared in one of them was invisible to this whole
 * file. `DRAWS_IN_PLACE` recorded one module and read as the complete record of
 * tools drawing in place; sweeping for the DECLARATION instead of the path returns
 * eight. Seven were unrecorded, and nothing would have failed had an eighth
 * arrived.
 *
 * The sweep is the variant space, taken from the tree at run time. A tool added
 * anywhere under `src/` that declares a renderer and takes a runtime value from
 * `@veyyon/tui` fails the cell below until somebody records a reason, which is the
 * behaviour a hardcoded directory could not give.
 */
function renderDeclaringModules(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__" || entry.name === "node_modules") continue;
			out.push(...renderDeclaringModules(full));
			continue;
		}
		if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
		// A module declares a renderer in one of three spellings, and the pattern matches all three
		// because a view module writes two of them at once. An object member opens with `(`, `<` or
		// `:` (`renderCall(args, ...)`, `renderCall:`, `readonly renderCall =`), which was the only
		// spelling matched before; a module-level `function renderCall(...)` collected into an
		// exported view object writes neither, and reaches the object as a shorthand `renderCall,`.
		// `task/task-view.ts` writes exactly that pair, and the pre-fix pattern read a whole converted
		// card as a module declaring nothing. Either new alternative catches it today, so the pattern
		// keeps both rather than resting on which half a future view module happens to write.
		const declares =
			/^\s*(?:export\s+)?function\s+render(?:Call|Result)\b|^\s*(?:readonly\s+)?render(?:Call|Result)\s*[(<:,]/m;
		if (declares.test(fs.readFileSync(full, "utf8"))) out.push(full);
	}
	return out;
}

/**
 * Every module in the tree that declares a renderer, draws with a runtime terminal
 * value, and is not named as a render module. Each row says why it has not been
 * split.
 *
 * THE MEASUREMENT THE ROWS REST ON. `tool-execution.ts` renders a tool through one
 * of two mutually exclusive branches: the tool-owned path when the `AgentTool`
 * object carries `renderCall`/`renderResult`, and the registry path when
 * `toolRenderers` has an entry for the tool name. Moving a renderer to a sibling
 * moves it between those branches, and the branches are equivalent for every
 * module below. `setPaddingX(COMPOSER_INSET_COLS)` on the tool-owned path is the
 * only `setPaddingX` in the file and it sets the value `#contentBox` was
 * constructed with, so it changes nothing; the one real difference is the fourth
 * argument handed to `renderResult` (`#args` against `getCallArgsForRender()`), and
 * every module below declares a three-parameter `renderResult` that never receives
 * it. So these splits are pixel-neutral and need no capture pair.
 *
 * WHAT IS LEFT. The sweep returned eight modules; the view contract has absorbed
 * seven of them -- the five autoresearch experiment tools, the goal tool and the
 * review tool -- which now return a `ToolView` and are pinned by the cell below. Each
 * grew the contract the one member it needed: a `framedBlock` kind for the goal
 * card's header and sections, and a symbol span for the review row's per-priority
 * mark, which is a registry key the host resolves rather than a glyph the tool picked.
 * `tools/fs/set-cwd.ts` and `tools/web/fetch-view.ts` joined them from the other direction: each
 * card was a `-render.ts` sibling rather than an in-place renderer, and converting it deleted that
 * sibling instead of moving code out of the tool. The fetch card grew the contract the members a
 * fetched page needs: a link target on a span and on a row, a section-level count of what a preview
 * held back, and a card that states whether its body is a report or the data it fetched.
 * One row remains, and it is not waiting on effort: the compatibility shim reproduces
 * the old `pi` API, whose renderers were declared in place, so drawing in place is the
 * contract it exists to keep.
 */
const IN_PLACE_ANYWHERE = new Map<string, string>([
	[
		"extensibility/legacy-pi-coding-agent-shim.ts",
		"The compatibility shim for the old `pi` API. It reproduces a surface whose renderers were declared in place, so drawing in place is the contract it exists to keep rather than a split it is missing. This row is permanent while the shim ships.",
	],
]);

describe("a tool draws in place only where it is recorded, wherever it ships from", () => {
	const declaring = renderDeclaringModules(SRC).map(file => path.relative(SRC, file).split(path.sep).join("/"));

	/**
	 * Anti-vacuity, in both directions. The rule below is an equality against a map,
	 * so a sweep that matched nothing would report an empty set and pass while every
	 * row rotted. Pinning the floor rather than the exact count leaves room for a
	 * renderer to be added or split without editing a number that means nothing.
	 */
	it("finds the renderers it is meant to sweep, across more than one directory", () => {
		expect(declaring.length).toBeGreaterThan(30);
		const directories = new Set(declaring.map(file => file.split("/")[0]));
		expect(directories.size).toBeGreaterThan(4);
		expect(declaring).toContain("tools/agent/review.ts");
		expect(declaring).toContain("autoresearch/tools/run-experiment.ts");
	});

	/**
	 * Every row the view contract has absorbed, asserted as a state rather than left implied.
	 *
	 * A converted tool still declares renderers -- `view.renderCall` and `view.renderResult` -- so the
	 * sweep above still sees it. What it no longer does is take a runtime value from the terminal
	 * package, because it returns a `ToolView` and the terminal draws that. The set is derived from the
	 * tree by two spellings a conversion carries -- the `view:` member on the tool, and an import of
	 * the view contract in the module that describes the cards -- and pinned by equality, so a further
	 * conversion turns this red until it is recorded, and a converted tool that quietly kept its
	 * `@veyyon/tui` import fails here instead of passing as an untouched row.
	 *
	 * The second spelling is what the memory tools needed: `retain`, `recall` and `reflect` share one
	 * card vocabulary, so their views are declared once in `tools/agent/memory-view.ts` and each tool
	 * names the view it owns. Detecting only the tool-side member would have read three conversions as
	 * none.
	 */
	it("sees every converted tool as declaring a renderer without drawing with a terminal value", () => {
		// Three spellings reach the same member: a `ToolDefinition` writes `view: { ... }` inline, a
		// class-based `AgentTool` writes `readonly view = <the exported view>`, because its card is
		// also what the terminal's registry entry draws and one object serves both, and a card shared
		// by several tools is a module of views the contract types.
		const converted = declaring
			.filter(file => !TERMINAL_DRAWERS.has(file) && !REGISTRY_MODULES.has(file))
			.filter(file => {
				const source = fs.readFileSync(path.join(SRC, file), "utf8");
				return /^\s*(readonly\s+)?view\s*(:\s*\{|=)/m.test(source) || /from "@veyyon\/view"/.test(source);
			})
			.sort();
		expect(converted).toEqual([
			"autoresearch/tools/certify-arms.ts",
			"autoresearch/tools/init-experiment.ts",
			"autoresearch/tools/log-experiment.ts",
			"autoresearch/tools/run-experiment.ts",
			"autoresearch/tools/update-notes.ts",
			"edit/edit-view.ts",
			"goals/goal-tool.ts",
			"lsp/view.ts",
			"mcp/view.ts",
			"task/task-view.ts",
			"tools/agent/ask-view.ts",
			"tools/agent/irc-view.ts",
			"tools/agent/memory-view.ts",
			"tools/agent/resolve-view.ts",
			"tools/agent/review.ts",
			"tools/agent/todo-view.ts",
			"tools/agent/vibe-view.ts",
			"tools/fs/inspect-image-view.ts",
			"tools/fs/read-view.ts",
			"tools/fs/set-cwd.ts",
			"tools/fs/write-view.ts",
			"tools/search/ast-edit-view.ts",
			"tools/search/file-search-view.ts",
			"tools/search/search-tool-bm25-view.ts",
			"tools/search/search-view.ts",
			"tools/search/structure-search-view.ts",
			"tools/search/text-search-view.ts",
			"tools/shell/bash-view.ts",
			"tools/shell/debug-view.ts",
			"tools/shell/eval-view.ts",
			"tools/shell/job-view.ts",
			"tools/shell/launch-view.ts",
			"tools/shell/ssh-view.ts",
			"tools/web/browser/view.ts",
			"tools/web/fetch-view.ts",
			"tools/web/gh-view.ts",
			"tools/web/search/view.ts",
		]);
		for (const file of converted) {
			expect([...IN_PLACE_ANYWHERE.keys()]).not.toContain(file);
			const names = tuiNamesIn(fs.readFileSync(path.join(SRC, file), "utf8"));
			expect(names.filter(name => !name.startsWith("type "))).toEqual([]);
		}
	});

	/**
	 * The rule. A module that declares a renderer and takes a runtime value from the
	 * terminal package, without being named as a render module, is drawing in place
	 * and must carry a reason.
	 *
	 * A `type ` name does not count, for the reason the map above gives: an erased
	 * import binds no host at run time. That is what keeps `edit/renderer.ts` and
	 * `task/index.ts` out of this set rather than an exception for either.
	 */
	it("records every module that declares a renderer and draws with a terminal value", () => {
		const drawing = declaring
			.filter(file => !isRenderModule(file))
			.filter(file => tuiNamesIn(fs.readFileSync(path.join(SRC, file), "utf8")).some(n => !n.startsWith("type ")))
			.sort();

		expect(drawing).toEqual([...IN_PLACE_ANYWHERE.keys()].sort());
	});

	/** An excluded module the sweep never returned excludes nothing, and reads as a clean tree. */
	it("excludes only the drawer and the registry, and only where the sweep returned them", () => {
		expect([...TERMINAL_DRAWERS]).toEqual(["modes/terminal/draw/draw-tool-view.ts"]);
		expect([...REGISTRY_MODULES]).toEqual(["tools/renderers.ts"]);
		for (const drawer of TERMINAL_DRAWERS) expect(declaring).toContain(drawer);
		for (const registry of REGISTRY_MODULES) expect(declaring).toContain(registry);
		// The registry is excluded from the converted set and from nothing else: it declares no card,
		// so it must still answer the rule that a module drawing in place carries a reason.
		expect([...IN_PLACE_ANYWHERE.keys()]).not.toContain("tools/renderers.ts");
	});

	/** A row for a module that no longer exists, or no longer draws, hides the split that finished. */
	it("has no stale rows", () => {
		const stale = [...IN_PLACE_ANYWHERE.keys()].filter(file => !declaring.includes(file));
		expect(stale).toEqual([]);
	});

	/** Every row states a reason. An empty one is a backlog entry wearing a decision's clothes. */
	it("gives every row a reason", () => {
		const unexplained = [...IN_PLACE_ANYWHERE]
			.filter(([, reason]) => reason.trim().length < 40)
			.map(([file]) => file);
		expect(unexplained).toEqual([]);
	});
});

describe("a tool names the terminal package only where it is recorded", () => {
	const files = toolFiles(TOOLS);

	/**
	 * Anti-vacuity. The rule below is an equality against a map, so an extractor that
	 * returned nothing for every file would report an empty map and a missing-row
	 * failure rather than a pass -- but a walker that found no FILES would produce the
	 * same empty map from the other side, and the diff would be unreadable. Prove the
	 * extractor works on files whose imports are known before trusting it on the rest:
	 * one that takes an erased name, and one that takes none at all.
	 */
	it("extracts erased names from a real tool and none from a tool that draws nothing", () => {
		expect(files.length).toBeGreaterThan(50);
		expect(tuiNamesIn(fs.readFileSync(path.join(TOOLS, "shell", "bash-interactive.ts"), "utf-8"))).toEqual([
			"type Component",
		]);
		expect(tuiNamesIn(fs.readFileSync(path.join(TOOLS, "shell", "bash-view.ts"), "utf-8"))).toEqual([]);
	});

	/**
	 * The rule, as one equality over the whole surface. A new tool that draws, a new
	 * name taken by an existing one, and a tool migrated off the terminal all show up
	 * as a diff, so each is a decision someone writes down rather than an import that
	 * lands. Stated per file so the failure names the file to open.
	 */
	it("takes exactly the recorded names, file by file", () => {
		const found = new Map<string, readonly string[]>();
		for (const file of files) {
			const names = tuiNamesIn(fs.readFileSync(file, "utf-8"));
			if (names.length > 0) found.set(path.relative(SRC, file).replace(/\\/g, "/"), names);
		}

		expect(found).toEqual(new Map([...TUI_SURFACE].map(([file, names]) => [file, [...names].sort()])));
	});

	/**
	 * The split this suite exists to hold. Drawing lives in a `-render.ts` sibling; the
	 * tool module beside it decides what happened and names no terminal value. Seventeen
	 * tool modules were split to reach this state, so the interesting assertion is not
	 * that the siblings draw -- it is that nothing ELSE does.
	 *
	 * Partitions `TUI_SURFACE` rather than re-walking the tree, so this cell and the map
	 * above catch a new drawing tool in that order: the map diff reds first because the
	 * import is not recorded, and adding the row to clear it reds THIS cell until the
	 * module is either split or given a reason below. Both were mutation-checked in that
	 * sequence. A row survives the filter only by naming a runtime value, since
	 * `type Component` is erased and binds no host.
	 */
	it("draws from a render sibling and nowhere else", () => {
		const drawsInPlace = [...TUI_SURFACE]
			.filter(([file]) => !isRenderModule(file))
			.filter(([, names]) => names.some(name => !name.startsWith("type ")))
			.map(([file]) => file);

		expect(drawsInPlace).toEqual([...DRAWS_IN_PLACE.keys()]);
	});

	/**
	 * The single blocker, stated on its own so it cannot be lost inside the map diff.
	 * `renderCall` and `renderResult` return a `Component`, so a module that renders is
	 * bound to the terminal by its signature whether or not it draws. A render module
	 * that stops carrying the type has been migrated to a host-agnostic view model, and
	 * its row belongs deleted rather than left reading as sanctioned.
	 *
	 * Asked of render modules only, which is every remaining non-sibling row bar
	 * `review.ts`: requiring the return type of a module that renders nothing would
	 * demand an import it has no use for, and would go green the moment it drew.
	 */
	it("binds every render module to the terminal through the renderer return type", () => {
		const withoutTheReturnType = [...TUI_SURFACE]
			.filter(([file]) => isRenderModule(file))
			.filter(([, names]) => !names.includes("type Component"))
			.map(([file]) => file);

		expect(withoutTheReturnType).toEqual([]);
	});
});

/**
 * The conversion frontier, resolved from the live registry rather than from the tree.
 *
 * WHY THIS IS SEPARATE FROM EVERY CELL ABOVE. Those sweep source files, and a file tells you what a
 * module imports, never which card a session actually draws. The registry does: an entry built by
 * `viewToolRenderer` carries the `view` it draws, and an entry that builds terminal components carries
 * none. So the two halves of the migration are readable as a state -- who describes a card and who
 * still draws one -- instead of inferred from an import.
 *
 * THE DEFECT CLASS. A tool added with a terminal-only renderer, which every host but the terminal
 * then draws as raw JSON, and a conversion that lands without moving the tool off the drawing set.
 * Both are silent: the terminal looks right in each case. Both sets are pinned by exact equality, so
 * a tool that arrives drawing components lands red until somebody records the row, and a conversion
 * lands red until the row moves.
 *
 * THE STATE. The drawing set is empty: every registry entry describes its card, so the last three
 * rows -- `apply_patch`, `edit` and `task` -- are gone rather than rewritten. An empty equality is
 * the weakest kind, because a probe that stopped seeing anything also reports empty, so the
 * predicate is exercised against a table holding a component-only entry below.
 *
 * WHAT IT DOES NOT CATCH. Presence, not quality: a `view` that describes the card badly passes here,
 * which is what the per-tool differential suites are for.
 */
describe("a registry entry either describes its card or is recorded as drawing one", () => {
	const entries = Object.keys(toolRenderers).sort();

	/** Anti-vacuity: an empty registry would make both equalities below pass with nothing swept. */
	it("is swept from a registry that loaded", () => {
		expect(entries.length).toBeGreaterThan(30);
		expect(entries).toContain("bash");
		expect(entries).toContain("search");
	});

	/**
	 * The control the empty equality below rests on: the same predicate, over a table whose second
	 * entry draws components, must return that entry and only that entry. A `view` member renamed on
	 * the registry type, or a probe written against a member that no longer exists, turns the rule
	 * into a tautology and fails here instead.
	 */
	it("reports an entry that carries no view", () => {
		const table: Record<string, { view?: unknown }> = {
			describesItsCard: { view: toolRenderers.bash?.view },
			drawsComponents: {},
		};
		expect(table.describesItsCard?.view).toBeDefined();
		expect(Object.keys(table).filter(name => table[name]?.view === undefined)).toEqual(["drawsComponents"]);
	});

	it("records every entry that still draws terminal components", () => {
		const drawing = entries.filter(name => toolRenderers[name]?.view === undefined);
		expect(drawing).toEqual([]);
	});

	it("has a view on every converted entry, and that view draws both halves of the card", () => {
		const described = entries.filter(name => toolRenderers[name]?.view !== undefined);
		expect(described).toEqual([
			"apply_patch",
			"ask",
			"ast_edit",
			"bash",
			"browser",
			"debug",
			"edit",
			"eval",
			"github",
			"goal",
			"inspect_image",
			"irc",
			"job",
			"launch",
			"lsp",
			"read",
			"recall",
			"reflect",
			"resolve",
			"retain",
			"search",
			"search_tool_bm25",
			"set_cwd",
			"ssh",
			"task",
			"todo",
			"vibe_kill",
			"vibe_list",
			"vibe_send",
			"vibe_spawn",
			"vibe_wait",
			"web_search",
			"write",
		]);
		// A half-converted entry describes one render and draws the other, which is a card no host but
		// the terminal can complete.
		for (const name of described) {
			const view = toolRenderers[name]?.view;
			expect(typeof view?.renderCall).toBe("function");
			expect(typeof view?.renderResult).toBe("function");
		}
	});
});
