import { describe, expect, it } from "bun:test";
import { prompt } from "@veyyon/utils";
import "../../src/config/prompt-templates";
import subagentSystemPromptTemplate from "../../src/prompts/system/subagent-system-prompt.md" with { type: "text" };

/** Render the subagent template with `agent` set (always required) plus overrides. */
function renderSubagent(overrides: Record<string, unknown> = {}): string {
	return prompt.render(subagentSystemPromptTemplate, { agent: "Do the assigned work.", ...overrides });
}

describe("subagent system prompt", () => {
	it("revokes native output labels when caller schema overrides the agent", () => {
		const out = prompt.render(subagentSystemPromptTemplate, {
			agent: 'Use incremental yield with type: ["findings"].',
			outputSchemaOverridesAgent: true,
			outputSchema: {
				properties: {
					issue_key: { type: "string" },
					verdict: { enum: ["clean", "blockers"] },
				},
			},
		});

		expect(out).toContain("Caller schema overrides agent-native output instructions");
		expect(out).toContain("Ignore ROLE-provided output/yield labels");
		expect(out).toContain("omit `type` and terminal-yield the full `result.data` object");
	});
});

/**
 * Gate-parity for the subagent template. Same failure class as the default
 * system prompt: a `{{#if <field>}}` branch dropped by a hand edit renders the
 * field dead with no other test failure. The `ircPeers` gate is the subagent
 * analogue of the delegation-coordination bug that motivated this whole effort
 * (cross-agent coordination silently rendered useless), so it is covered here
 * with the same rigor: toggle asserts a real anchor plus the interpolated value.
 */
describe("subagent system prompt: gate parity", () => {
	it("context gate toggles the CONTEXT section and renders the context body", () => {
		const on = renderSubagent({ context: "SUBAGENT-CONTEXT-BODY" });
		expect(on).toContain("CONTEXT");
		expect(on).toContain("SUBAGENT-CONTEXT-BODY");
		expect(renderSubagent({ context: "" })).not.toContain("SUBAGENT-CONTEXT-BODY");
	});

	it("planReference gate toggles the PLAN section and renders the plan path and body", () => {
		const on = renderSubagent({ planReference: "PLAN-BODY-TEXT", planReferencePath: "/tmp/plan.md" });
		expect(on).toContain("This session is executing an approved plan");
		expect(on).toContain('<plan path="/tmp/plan.md">');
		expect(on).toContain("PLAN-BODY-TEXT");
		expect(renderSubagent({})).not.toContain("This session is executing an approved plan");
	});

	it("worktree gate toggles the Working Tree section and renders the tree path", () => {
		const on = renderSubagent({ worktree: "/repo/.worktrees/sub-1" });
		expect(on).toContain("# Working Tree");
		expect(on).toContain("isolated working tree at `/repo/.worktrees/sub-1`");
		expect(renderSubagent({})).not.toContain("# Working Tree");
	});

	it("ircPeers gate toggles the IRC Peers section and renders self id and roster", () => {
		const on = renderSubagent({ ircPeers: "- agent-b: refactoring auth", ircSelfId: "agent-a" });
		expect(on).toContain("# IRC Peers");
		expect(on).toContain("Your id is `agent-a`");
		expect(on).toContain("- agent-b: refactoring auth");
		expect(renderSubagent({})).not.toContain("# IRC Peers");
	});

	it("outputSchema gate toggles the terminal-yield schema block", () => {
		const on = renderSubagent({ outputSchema: { properties: { ok: { type: "boolean" } } } });
		expect(on).toContain("Your terminal `yield` MUST use exactly this shape");
		expect(renderSubagent({})).not.toContain("Your terminal `yield` MUST use exactly this shape");
	});

	it("outputSchemaOverridesAgent gate toggles the schema-override notice", () => {
		const on = renderSubagent({ outputSchemaOverridesAgent: true });
		expect(on).toContain("Caller schema overrides agent-native output instructions");
		expect(renderSubagent({})).not.toContain("Caller schema overrides agent-native output instructions");
	});

	/**
	 * Completeness guard: every `{{#if <field>}}` gate in the shipped subagent
	 * template must be in the tested set below. A new gate added without a parity
	 * test fails here, so this template cannot silently fall behind either.
	 */
	it("accounts for every gate in the shipped subagent template", () => {
		const tested = new Set([
			"context",
			"planReference",
			"worktree",
			"ircPeers",
			"outputSchema",
			"outputSchemaOverridesAgent",
		]);
		const found = new Set<string>();
		for (const m of subagentSystemPromptTemplate.matchAll(/\{\{#if\s+([A-Za-z_][\w.]*)\}\}/g)) {
			found.add(m[1].replace(/\.length$/, ""));
		}
		expect(found.size).toBeGreaterThanOrEqual(6);
		const untested = [...found].filter(id => !tested.has(id)).sort();
		expect(untested).toEqual([]);
	});
});
