/**
 * A converted card declares the chrome policy the renderer it replaced declared.
 *
 * WHY THIS SUITE EXISTS. A registry entry carries two separable things: how the card is drawn, and
 * the policy the terminal applies around it -- whether the call row survives the result
 * (`mergeCallAndResult`), whether the call render is a live widget, which lifecycle states consume a
 * spinner frame, whether the rows sit in the response flow (`inline`), and which shape flips ask for a
 * viewport replay. Converting a renderer to a `ToolViewRenderer` rewrites the first half and restates
 * the second by hand, as the option object handed to `viewToolRenderer`. The per-tool differential
 * suites beside this one compare the drawn bytes and never read the option object, so a flag lost in
 * transcription is invisible to every one of them: five were lost, `inline` on `debug`, `resolve`,
 * `retain`, `recall` and `reflect`, and thirty-seven byte comparisons stayed green.
 *
 * `inline` IS INERT TODAY, and this suite says so rather than implying those five changed the screen.
 * `#onRail` in `tool-execution.ts` frames every card it is handed, so no reader consults the flag: the
 * only site that touches it is the gallery, which copies it onto a fixture's fake tool. The five were
 * restored because an entry's declaration is part of what this branch claims to preserve, and a live
 * flag lost the same way -- `mergeCallAndResult`, `callIsLiveWidget`, either animation predicate, either
 * repaint predicate -- does reach the screen, which is what the sweep is for.
 *
 * THE CLASS, NOT THE INCIDENT. The defect is not "resolve lost inline". It is "a conversion restates
 * the policy by hand and nothing compares the restatement to what it replaced". So this suite sweeps
 * `toolRenderers` at run time and compares every policy flag of every entry against the frozen
 * oracle for that tool, which is the renderer as `origin/main` declared it. A boolean is compared by
 * value; a predicate is compared by agreement over an argument matrix, since two predicates are the
 * same policy when they answer the same for every call the tool can make. Adding a tool with no
 * oracle turns this red rather than arriving unchecked.
 *
 * FOUR ENTRIES ARE TRANSCRIBED RATHER THAN DERIVED. The `goal`, `resolve`, `task` and `set_cwd`
 * oracles were frozen as a `renderCall`/`renderResult` pair without the object that carried the
 * flags, so there is nothing in the tree to derive their policy from. Each is recorded below with the
 * file and SHA it was read from, and the recorded value is compared the same way. A transcribed row
 * is the weak spot of this suite and is named as such rather than hidden.
 *
 * WHAT WAS TRIED AGAINST IT. Dropping `inline` from any one of the five restored entries reddens
 * exactly that row. Dropping `mergeCallAndResult` anywhere reddens. Replacing `launch`'s partial
 * predicate with `true` reddens on the ops that answer in one round trip, which a boolean comparison
 * of "is a function" would have missed.
 *
 * WHAT IT DOES NOT CATCH. It proves the declaration survived, not that the declaration is right for
 * the card: a policy `main` had wrong is preserved wrong, deliberately, because this branch's claim is
 * equivalence. It says nothing about an MCP tool, whose card is bound to a tool object built per
 * server rather than to a registry key, and nothing about a tool that draws itself through a renderer
 * on the tool object instead of through the registry.
 */

import { describe, expect, it } from "bun:test";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { toolRenderers } from "@veyyon/coding-agent/tools/renderers";
import { askMainRenderer } from "../oracles/ask-main-renderer";
import { astEditToolRenderer } from "../oracles/ast-edit-main-renderer";
import { bashMainRenderer } from "../oracles/bash-main-renderer";
import { browserToolRenderer } from "../oracles/browser-main-renderer";
import { debugToolRenderer } from "../oracles/debug-main-renderer";
import { editToolRenderer } from "../oracles/edit-main-renderer";
import { evalToolRenderer } from "../oracles/eval-main-renderer";
import { githubToolRenderer } from "../oracles/gh-main-renderer";
import { inspectImageToolRenderer } from "../oracles/inspect-image-main-renderer";
import { ircToolRenderer } from "../oracles/irc-main-renderer";
import { jobToolRenderer } from "../oracles/job-main-renderer";
import { launchToolRenderer } from "../oracles/launch-main-renderer";
import { lspToolRenderer } from "../oracles/lsp-main-renderer";
import { recallToolRenderer, reflectToolRenderer, retainToolRenderer } from "../oracles/memory-main-renderer";
import { readToolRenderer } from "../oracles/read-main-renderer";
import { searchToolRenderer } from "../oracles/search-main-renderer";
import { searchToolBm25Renderer } from "../oracles/search-tool-bm25-main-renderer";
import { sshMainRenderer } from "../oracles/ssh-main-renderer";
import { todoToolRenderer } from "../oracles/todo-main-renderer";
import { createVibeToolRenderer } from "../oracles/vibe-main-renderer";
import { webSearchToolRenderer } from "../oracles/web-search-main-renderer";
import { mainWriteToolRenderer } from "../oracles/write-main-renderer";

/** Every flag the terminal reads off a registry entry, which is the policy surface a conversion restates. */
const POLICY_FLAGS = [
	"inline",
	"mergeCallAndResult",
	"callIsLiveWidget",
	"animatedPendingPreview",
	"animatedPartialResult",
	"forceFirstResultViewportRepaint",
	"forceResultViewportRepaintOnSettle",
] as const;

type PolicyFlag = (typeof POLICY_FLAGS)[number];

/** A policy holder: the frozen oracle, the live entry, or a recorded declaration. */
type PolicyBearer = Partial<Record<PolicyFlag, unknown>>;

/** The frozen renderer each registry key was converted from. */
const ORACLE_POLICY: Record<string, PolicyBearer> = {
	apply_patch: editToolRenderer,
	ask: askMainRenderer,
	ast_edit: astEditToolRenderer,
	bash: bashMainRenderer,
	browser: browserToolRenderer,
	debug: debugToolRenderer,
	edit: editToolRenderer,
	eval: evalToolRenderer,
	github: githubToolRenderer,
	inspect_image: inspectImageToolRenderer,
	irc: ircToolRenderer,
	job: jobToolRenderer,
	launch: launchToolRenderer,
	lsp: lspToolRenderer,
	read: readToolRenderer,
	recall: recallToolRenderer,
	reflect: reflectToolRenderer,
	retain: retainToolRenderer,
	search: searchToolRenderer,
	search_tool_bm25: searchToolBm25Renderer,
	ssh: sshMainRenderer,
	todo: todoToolRenderer,
	vibe_kill: createVibeToolRenderer("kill"),
	vibe_list: createVibeToolRenderer("list"),
	vibe_send: createVibeToolRenderer("send"),
	vibe_spawn: createVibeToolRenderer("spawn"),
	vibe_wait: createVibeToolRenderer("wait"),
	web_search: webSearchToolRenderer,
	write: mainWriteToolRenderer,
};

/**
 * The four entries whose oracle carries no policy object, with what `main` declared and where.
 *
 * Read from `origin/main` at `1a6bcba79c5e125e82d8fa5ac33a98c26b838f5c`:
 *  - `goal` -> `packages/coding-agent/src/goals/tools/goal-tool.ts`
 *  - `resolve` -> `packages/coding-agent/src/tools/resolve.ts`
 *  - `task` -> `packages/coding-agent/src/task/renderer.ts`
 *  - `set_cwd` -> `packages/coding-agent/src/tools/set-cwd.ts`, which declared none of the seven.
 */
const RECORDED_POLICY: Record<string, PolicyBearer> = {
	goal: { mergeCallAndResult: true },
	resolve: { inline: true, mergeCallAndResult: true },
	set_cwd: {},
	task: { mergeCallAndResult: true },
};

/**
 * The calls each predicate flag is compared over.
 *
 * A predicate is the policy for every argument shape the tool is called with, so comparing two of
 * them means asking both the same questions. The entries are the branches the predicates read: the
 * browser action, the launch op, whether SSH args arrived as a partial JSON buffer, and whether a
 * write's content clears the streaming window. A tool with no predicate flag needs no row here.
 */
const PREDICATE_CALLS: Record<string, readonly unknown[]> = {
	browser: [{ action: "run" }, { action: "open" }, { action: "close" }, {}],
	launch: [
		{ op: "start" },
		{ op: "logs" },
		{ op: "wait" },
		{ op: "list" },
		{ op: "describe" },
		{ op: "stop" },
		{ op: "restart" },
		{ op: "send" },
		{},
	],
	ssh: [{ __partialJson: '{"host":"build-01"' }, { __partialJson: 17 }, { host: "build-01" }, {}],
	write: [
		{ file_path: "src/app.ts", content: Array.from({ length: 400 }, (_, line) => `line ${line}`).join("\n") },
		{ file_path: "src/app.ts", content: "one line" },
		{ path: "src/app.ts", content: "" },
		{},
	],
};

/** Both disclosure states, since a repaint predicate reads `expanded`. */
const OPTIONS: readonly RenderResultOptions[] = [
	{ expanded: false, isPartial: false },
	{ expanded: true, isPartial: false },
];

function expected(tool: string): PolicyBearer {
	const oracle = ORACLE_POLICY[tool];
	if (oracle !== undefined) return oracle;
	const recorded = RECORDED_POLICY[tool];
	if (recorded === undefined) throw new Error(`no oracle and no recorded policy for ${tool}`);
	return recorded;
}

/** What a predicate answers for every call the tool is compared over, as a comparable string. */
function answers(tool: string, flag: PolicyFlag, predicate: unknown): string {
	if (typeof predicate !== "function") return `not-a-predicate:${String(predicate)}`;
	const calls = PREDICATE_CALLS[tool];
	if (calls === undefined) throw new Error(`${tool}.${flag} is a predicate with no calls to compare it over`);
	const call = predicate as (args: unknown, options: RenderResultOptions) => unknown;
	return calls.map(args => OPTIONS.map(options => String(call(args, options))).join(",")).join("|");
}

/**
 * A flag left out and a flag declared `false` are one policy.
 *
 * Every one of the seven is read as a truthy value or called as a predicate -- `inline` gates the
 * card's frame, and the animation flags resolve through `typeof value === "function" ? value(args) :
 * value === true` -- so no reader can tell an absent flag from a false one. The vibe factory spells
 * both animation flags on every op and answers `false` for the ops that do not animate, where the
 * table beside the view omits the row; comparing raw values there would report a difference the
 * terminal cannot see.
 */
function normalize(value: unknown): unknown {
	return value === undefined ? false : value;
}

describe("a converted card's chrome policy", () => {
	/**
	 * The sweep is derived, so a tool that joins the registry arrives with nothing to compare it to
	 * and this cell names it. Pinned in both directions: an oracle mapping left behind by a retired
	 * tool is the same silence from the other side.
	 */
	it("has a frozen or recorded declaration for every registry entry, and no others", () => {
		const known = [...Object.keys(ORACLE_POLICY), ...Object.keys(RECORDED_POLICY)].sort();
		expect(Object.keys(toolRenderers).sort()).toEqual(known);
		// A key cannot be both derived and recorded, or the recorded row silently shadows nothing.
		for (const tool of Object.keys(RECORDED_POLICY)) expect(ORACLE_POLICY[tool]).toBeUndefined();
	});

	/**
	 * The anti-vacuity cell. Every comparison below reads flags off an oracle, so an oracle refactored
	 * down to its two render functions would compare an empty policy against an empty policy and pass
	 * for every tool at once. `set_cwd` is the one entry whose policy is legitimately empty.
	 */
	it("reads a non-empty declaration from every oracle it derives from", () => {
		const empty = Object.entries(ORACLE_POLICY)
			.filter(([, bearer]) => POLICY_FLAGS.every(flag => bearer[flag] === undefined))
			.map(([tool]) => tool);
		expect(empty).toEqual([]);
		expect(
			Object.keys(RECORDED_POLICY).filter(tool =>
				POLICY_FLAGS.every(flag => RECORDED_POLICY[tool][flag] === undefined),
			),
		).toEqual(["set_cwd"]);
	});

	it.each(Object.keys(toolRenderers).sort())("declares what main declared (%s)", tool => {
		const live = toolRenderers[tool] as PolicyBearer;
		const main = expected(tool);
		for (const flag of POLICY_FLAGS) {
			const mainValue = main[flag];
			const liveValue = live[flag];
			if (typeof mainValue === "function" || typeof liveValue === "function") {
				expect(answers(tool, flag, liveValue)).toBe(answers(tool, flag, mainValue));
				continue;
			}
			expect(normalize(liveValue)).toBe(normalize(mainValue));
		}
	});
});
