/**
 * The plan the model is following survives every pass that rewrites history.
 *
 * WHY THIS FILE EXISTS. A session shrinks its own context in four places, and
 * each of them takes bytes out of a tool result the operator already saw: the
 * end-of-turn maintenance pass, the redundant-result dedup, the shake elide
 * tier, and the prune that runs just before a compaction summarizes history
 * away. Every one of them is handed the plan matcher through one helper
 * (`#withPlanProtection`), and the plan is exactly the result that must not be
 * touched: it is the instruction set the model is executing, so a pass that
 * blanks it to "[Superseded by a newer read of this file]" does not cost tokens,
 * it costs the plan. The matcher has unit coverage; that it is actually wired
 * into each pass a live session reaches did not, and a missing matcher at any
 * one site is invisible until a run quietly forgets what it was doing.
 *
 * ASSERTED, once per pass, with a NON-plan read of identical size in the same
 * session as the positive control: the plan read keeps its bytes and the control
 * read is rewritten. The control is what makes a green row evidence, because a
 * pass that did nothing at all would leave the plan intact too.
 *
 * MEASURED ATTRIBUTION. Each row was run against a build with the matcher taken
 * off its own site, and against a build with the helper adding no matcher at all:
 *   - Read by the canonical `local://PLAN.md` alias, the maintenance row could not
 *     fail. `readToolSupersedeKey` exempts any `scheme://` path on its own, so a
 *     plan read by alias is protected twice and the row proves an outcome without
 *     attributing it. That row therefore reads the plan by the name the session
 *     set (no scheme), which is the spelling where the matcher is load-bearing.
 *   - The dedup and shake rows key on tool name plus arguments plus output, with
 *     no scheme exemption, so the alias is enough there and both rows red when
 *     their own site loses the matcher.
 *   - Removing the matcher at every site reds all three rows, so no row is passing
 *     on another site's protection.
 *   - The maintenance row is also the regression test for a crash it found: with
 *     the plan reference resolved as a URL unconditionally, a plan named without a
 *     scheme threw `Invalid URL: docs/roadmap-plan.md` out of `prompt()` and the
 *     row fails with that error rather than an assertion.
 *
 * NOT asserted. The plan matcher's own path rules (`local:/` against `local://`,
 * a trailing read selector): those are the matcher's contract and belong where
 * the matcher is. This suite pins the WIRING. The pre-compaction prune is the
 * fourth site and is not covered here: reaching it means driving a real
 * compaction, and what it protects (the plan text inside the summarizer's input)
 * belongs with the compaction suites.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { AgentTool } from "@veyyon/agent-core";
import { SUPERSEDED_NOTICE } from "@veyyon/agent-core/compaction/pruning";
import { TOOL } from "@veyyon/coding-agent/tools/builtin-names";
import { createSimulation, type Simulation, scriptTurns, simTool } from "./harness";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/** The alias every session's `local://` root resolves to a plan. */
const PLAN_ALIAS = "local://PLAN.md";
/** A plan the session named itself, with no URL scheme. See MEASURED ATTRIBUTION. */
const PLAN_NAMED = "docs/roadmap-plan.md";
const CONTROL_PATH = "src/control.ts";

/** Identical shape for both paths, so size can never explain a difference in outcome. */
function bodyFor(path: string): string {
	return `contents of ${path}\n${"step: do the next thing carefully;\n".repeat(30)}`;
}

function readTool(): AgentTool[] {
	return [
		simTool(TOOL.read, async (_id, args) => ({
			content: [{ type: "text", text: bodyFor(String(args.path)) }],
		})),
	];
}

function textOfResult(simulation: Simulation, toolCallId: string): string {
	for (const message of simulation.session.messages) {
		if (message.role !== "toolResult" || message.toolCallId !== toolCallId) continue;
		return message.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("");
	}
	return "(no result recorded)";
}

/**
 * Two prompts, each reading the plan and the control file in one batch, so both
 * paths end the session with an older copy a pass may rewrite and a newer copy
 * it must keep. `maintenance` decides whether the end-of-turn pass is armed.
 */
async function runTwoRounds(maintenance: boolean, planPath: string = PLAN_ALIAS): Promise<Simulation> {
	const created = await createSimulation({
		persist: true,
		settings: {
			"retry.enabled": false,
			"compaction.supersedeReads": maintenance,
			"compaction.dropUseless": maintenance,
		},
		tools: readTool(),
		script: scriptTurns(
			turn => {
				turn.toolCall(TOOL.read, { path: planPath }, "plan-1");
				turn.toolCall(TOOL.read, { path: CONTROL_PATH }, "control-1");
				turn.finish("toolUse");
			},
			turn => {
				turn.text("first round done");
				turn.finish();
			},
			turn => {
				turn.toolCall(TOOL.read, { path: planPath }, "plan-2");
				turn.toolCall(TOOL.read, { path: CONTROL_PATH }, "control-2");
				turn.finish("toolUse");
			},
			turn => {
				turn.text("second round done");
				turn.finish();
			},
		),
	});
	sim = created;
	created.session.setPlanReferencePath(planPath);
	await created.session.prompt("read the plan and the file");
	await created.session.prompt("read them both again");
	return created;
}

describe("every pass that rewrites history leaves the plan alone", () => {
	it("the end-of-turn maintenance pass supersedes the control read and not the plan", async () => {
		// The plan is read by the name the session set, so the matcher is the only thing
		// standing between it and the supersede rewrite.
		const simulation = await runTwoRounds(true, PLAN_NAMED);

		// The pass already ran, twice, at the end of each prompt.
		expect(textOfResult(simulation, "control-1")).toBe(SUPERSEDED_NOTICE);
		expect(textOfResult(simulation, "plan-1")).toBe(bodyFor(PLAN_NAMED));
		expect(textOfResult(simulation, "plan-2")).toBe(bodyFor(PLAN_NAMED));
	});

	it("the redundant-result dedup elides the control read and not the plan", async () => {
		// Maintenance off: it would supersede the control read first and leave dedup
		// nothing to find, and this row is about the dedup pass's own matcher.
		const simulation = await runTwoRounds(false);

		const dedup = await simulation.session.dedupeRedundantToolResults();

		expect(dedup.toolResultsDropped).toBe(1);
		expect(textOfResult(simulation, "control-1")).toContain("shaken");
		expect(textOfResult(simulation, "plan-1")).toBe(bodyFor(PLAN_ALIAS));
		expect(textOfResult(simulation, "plan-2")).toBe(bodyFor(PLAN_ALIAS));
	});

	it("the shake elide tier takes the control read and not the plan", async () => {
		const simulation = await runTwoRounds(false);

		// No config: `shake` falls back to the manual `/shake` profile, which is the
		// aggressive one an operator reaches and drops every eligible region.
		const shaken = await simulation.session.shake("elide");

		expect(shaken.toolResultsDropped + shaken.blocksDropped).toBeGreaterThan(0);
		expect(textOfResult(simulation, "plan-1")).toBe(bodyFor(PLAN_ALIAS));
		expect(textOfResult(simulation, "plan-2")).toBe(bodyFor(PLAN_ALIAS));
		const controlSurvives = [textOfResult(simulation, "control-1"), textOfResult(simulation, "control-2")].filter(
			text => text === bodyFor(CONTROL_PATH),
		);
		expect(controlSurvives.length).toBeLessThan(2);
	});
});
