import { describe, expect, it } from "bun:test";
import { prompt } from "@veyyon/utils";
import "../../src/config/prompt-templates";
import { PROMPTS } from "@veyyon/coding-agent/prompts/registry";

/** Render the agent template with `agent` set (always required) plus overrides. */
function renderAgent(overrides: Record<string, unknown> = {}): string {
	return prompt.render(PROMPTS["agent/system-prompt"].text, {
		agent: "Do the assigned work.",
		...overrides,
	});
}

describe("agent system prompt", () => {
	it("revokes native output labels when caller schema overrides the agent", () => {
		const out = prompt.render(PROMPTS["agent/system-prompt"].text, {
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
 * Gate parity for the agent template. Same failure class as the default
 * system prompt: a `{{#if <field>}}` branch dropped by a hand edit renders the
 * field dead with no other test failure. The `ircEnabled` gate is the agent
 * analogue of the delegation-coordination bug that motivated this whole effort,
 * so it is covered here with the same rigor.
 */
describe("agent system prompt: gate parity", () => {
	it("context gate toggles the CONTEXT section and renders the context body", () => {
		const on = renderAgent({ context: "AGENT-CONTEXT-BODY" });
		expect(on).toContain("CONTEXT");
		expect(on).toContain("AGENT-CONTEXT-BODY");
		expect(renderAgent({ context: "" })).not.toContain("AGENT-CONTEXT-BODY");
	});

	it("planReference gate toggles the PLAN section and renders the plan path and body", () => {
		const on = renderAgent({ planReference: "PLAN-BODY-TEXT", planReferencePath: "/tmp/plan.md" });
		expect(on).toContain("This session is executing an approved plan");
		expect(on).toContain('<plan path="/tmp/plan.md">');
		expect(on).toContain("PLAN-BODY-TEXT");
		expect(renderAgent({})).not.toContain("This session is executing an approved plan");
	});

	it("worktree gate toggles the Working Tree section and renders the tree path", () => {
		const on = renderAgent({ worktree: "/repo/.worktrees/sub-1" });
		expect(on).toContain("# Working Tree");
		expect(on).toContain("isolated working tree at `/repo/.worktrees/sub-1`");
		expect(renderAgent({})).not.toContain("# Working Tree");
	});

	/** IRC capability remains visible without embedding a launch-specific roster in the cacheable prefix. */
	it("ircEnabled gate renders static discovery instructions without launch identity", () => {
		const on = renderAgent({
			ircEnabled: true,
			ircPeers: "- agent-b: refactoring auth",
			ircSelfId: "agent-a",
		});
		expect(on).toContain("# IRC Coordination");
		expect(on).toContain('call `irc` with `op:"list"`');
		expect(on).not.toContain("agent-a");
		expect(on).not.toContain("agent-b");
		expect(renderAgent({ ircEnabled: false })).not.toContain("# IRC Coordination");
	});
	/** Sibling ids and live status changes must not invalidate the shared agent system-prompt prefix. */
	it("keeps IRC system prompt bytes stable across sibling launch identities", () => {
		const first = renderAgent({
			ircEnabled: true,
			ircPeers: "- sibling-one: running",
			ircSelfId: "worker-one",
		});
		const second = renderAgent({
			ircEnabled: true,
			ircPeers: "- sibling-two: idle",
			ircSelfId: "worker-two",
		});
		expect(first).toBe(second);
	});

	it("outputSchema gate toggles the terminal-yield schema block", () => {
		const on = renderAgent({ outputSchema: { properties: { ok: { type: "boolean" } } } });
		expect(on).toContain("Your terminal `yield` MUST use exactly this shape");
		expect(renderAgent({})).not.toContain("Your terminal `yield` MUST use exactly this shape");
	});

	it("outputSchemaOverridesAgent gate toggles the schema-override notice", () => {
		const on = renderAgent({ outputSchemaOverridesAgent: true });
		expect(on).toContain("Caller schema overrides agent-native output instructions");
		expect(renderAgent({})).not.toContain("Caller schema overrides agent-native output instructions");
	});

	/**
	 * Completeness guard: every `{{#if <field>}}` gate in the shipped agent
	 * template must be in the tested set below. A new gate added without a parity
	 * test fails here, so this template cannot silently fall behind either.
	 */
	it("accounts for every gate in the shipped agent template", () => {
		const tested = new Set([
			"context",
			"planReference",
			"worktree",
			"ircEnabled",
			"outputSchema",
			"outputSchemaOverridesAgent",
		]);
		const found = new Set<string>();
		for (const m of PROMPTS["agent/system-prompt"].text.matchAll(/\{\{#if\s+([A-Za-z_][\w.]*)\}\}/g)) {
			found.add(m[1].replace(/\.length$/, ""));
		}
		expect(found.size).toBeGreaterThanOrEqual(6);
		const untested = [...found].filter(id => !tested.has(id)).sort();
		expect(untested).toEqual([]);
	});
});
