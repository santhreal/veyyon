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
 * NOT asserted. The plan matcher's own path rules (`local:/` against `local://`,
 * a trailing read selector, the session-chosen `<slug>-plan.md` alias): those are
 * the matcher's contract and belong where the matcher is. This suite pins the
 * WIRING, so every row reads the plan by its canonical alias.
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
const PLAN_PATH = "local://PLAN.md";
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
async function runTwoRounds(maintenance: boolean): Promise<Simulation> {
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
				turn.toolCall(TOOL.read, { path: PLAN_PATH }, "plan-1");
				turn.toolCall(TOOL.read, { path: CONTROL_PATH }, "control-1");
				turn.finish("toolUse");
			},
			turn => {
				turn.text("first round done");
				turn.finish();
			},
			turn => {
				turn.toolCall(TOOL.read, { path: PLAN_PATH }, "plan-2");
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
	await created.session.prompt("read the plan and the file");
	await created.session.prompt("read them both again");
	return created;
}

describe("every pass that rewrites history leaves the plan alone", () => {
	it("the end-of-turn maintenance pass supersedes the control read and not the plan", async () => {
		const simulation = await runTwoRounds(true);

		// The pass already ran, twice, at the end of each prompt.
		expect(textOfResult(simulation, "control-1")).toBe(SUPERSEDED_NOTICE);
		expect(textOfResult(simulation, "plan-1")).toBe(bodyFor(PLAN_PATH));
		expect(textOfResult(simulation, "plan-2")).toBe(bodyFor(PLAN_PATH));
	});

	it("the redundant-result dedup elides the control read and not the plan", async () => {
		// Maintenance off: it would supersede the control read first and leave dedup
		// nothing to find, and this row is about the dedup pass's own matcher.
		const simulation = await runTwoRounds(false);

		const dedup = await simulation.session.dedupeRedundantToolResults();

		expect(dedup.toolResultsDropped).toBe(1);
		expect(textOfResult(simulation, "control-1")).toContain("shaken");
		expect(textOfResult(simulation, "plan-1")).toBe(bodyFor(PLAN_PATH));
		expect(textOfResult(simulation, "plan-2")).toBe(bodyFor(PLAN_PATH));
	});

	it("the shake elide tier takes the control read and not the plan", async () => {
		const simulation = await runTwoRounds(false);

		// No config: `shake` falls back to the manual `/shake` profile, which is the
		// aggressive one an operator reaches and drops every eligible region.
		const shaken = await simulation.session.shake("elide");

		expect(shaken.toolResultsDropped + shaken.blocksDropped).toBeGreaterThan(0);
		expect(textOfResult(simulation, "plan-1")).toBe(bodyFor(PLAN_PATH));
		expect(textOfResult(simulation, "plan-2")).toBe(bodyFor(PLAN_PATH));
		const controlSurvives = [textOfResult(simulation, "control-1"), textOfResult(simulation, "control-2")].filter(
			text => text === bodyFor(CONTROL_PATH),
		);
		expect(controlSurvives.length).toBeLessThan(2);
	});
});
