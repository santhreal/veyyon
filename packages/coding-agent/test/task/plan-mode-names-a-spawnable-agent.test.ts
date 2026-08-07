import { describe, expect, it } from "bun:test";
import { prompt } from "@veyyon/utils";
import { planModePrompts } from "../../src/prompts/plan-mode/rows";
import { preferredSubagentName } from "../../src/task/subagent-settings";

/**
 * Plan mode's research step tells the model which agent type to launch, and the
 * contract that matters is not which name it picks: it is that the name it picks
 * is one this session can actually spawn.
 *
 * It used to interpolate a literal, `scout` when scout was enabled and otherwise
 * the hardcoded string `task`. That failed twice over. `task` stopped being a
 * roster name when the agent was renamed to `deep`, so the sentence named
 * something no catalog carried; and a literal cannot track a set the operator
 * configures, so an operator running only `sonic` was told to launch an agent
 * that the enablement check in the spawn path then refused. Plan mode was
 * talking the model straight into a rejection.
 *
 * So these assert membership, not equality. A test pinning the string to `deep`
 * would pass today and rot at the next rename, which is the exact failure being
 * fixed. The sonic-only row is the one that reproduces the bug: it is the
 * configuration where the old fallback named an agent outside the enabled set.
 *
 * `canDelegate` is asserted alongside, because the two have to agree: the prose
 * is emitted exactly when there is a name to put in it, and an empty roster must
 * suppress the sentence rather than interpolate nothing into it.
 */

/** Render the real plan-mode prompt the way the session does, and read back the agent it names. */
function agentPlanModeNames(enabled: readonly string[]): string | undefined {
	const researchAgent = preferredSubagentName(enabled, "scout");
	const rendered = prompt.render(planModePrompts["plan-mode/active"].text, {
		planFilePath: "local://x-plan.md",
		planExists: false,
		canDelegate: researchAgent !== undefined,
		researchAgent,
		askToolName: "ask",
		writeToolName: "write",
		editToolName: "edit",
		isHashlineEditMode: false,
		reentry: false,
		iterative: false,
	});
	return /Launch parallel `([^`]+)` subagents/.exec(rendered)?.[1];
}

describe("plan mode's research step", () => {
	it.each([
		["scout on offer", ["scout", "deep", "sonic"]],
		["sonic only, the configuration the old literal broke", ["sonic"]],
		["one specialist only", ["librarian"]],
		["the shipped default alone", ["deep"]],
	])("names an agent from the enabled set: %s", (_label, enabled) => {
		const named = agentPlanModeNames(enabled);

		expect(named).toBeDefined();
		expect(enabled).toContain(named as string);
	});

	it("prefers scout when scout is enabled, because research is what scout is for", () => {
		expect(agentPlanModeNames(["deep", "scout"])).toBe("scout");
	});

	it("emits no launch instruction at all when nothing is spawnable", () => {
		expect(preferredSubagentName([], "scout")).toBeUndefined();
		expect(agentPlanModeNames([])).toBeUndefined();
	});
});
