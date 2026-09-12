import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { BUILTIN_TOOLS, HIDDEN_TOOLS, type ToolSession } from "../../src/tools";
import { BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES } from "../../src/tools/core/builtin-names";
import { toolRenderers } from "../../src/tools/renderers";

/**
 * WHY: `goal` shipped with no `approval` member. `normalizeDecision` defaults an undeclared tier to
 * `exec`, so the hidden tool prompted in `ask-command` like a shell command and was denied outright
 * in plan mode. Class: any tool a session can construct, from a domain manifest or from the hidden
 * registry, reaching the approval resolver without a declared tier. The sweep below constructs every
 * `BUILTIN_TOOLS` and `HIDDEN_TOOLS` entry and requires a valid tier on each; the key sets are pinned
 * to `BUILTIN_TOOL_NAMES` / `HIDDEN_TOOL_NAMES` so a name declared without a registry row, or a row
 * registered under an undeclared name, fails here rather than at the prompt.
 *
 * Does not catch: a tool the test session cannot construct (a factory returning null for a missing
 * backend), or a custom tool registered by the SDK outside these two registries.
 */

const VALID_APPROVAL_TIERS: Record<string, true> = {
	read: true,
	write: true,
	exec: true,
	execute: true,
	danger: true,
	network: true,
	prompt: true,
	deny: true,
};

const NON_RENDERING_TOOLS: Record<string, true> = {
	checkpoint: true,
	rewind: true,
	memory_edit: true,
	yield: true,
	report_tool_issue: true,
};
function createTestSession(): ToolSession {
	const settings = Settings.isolated();
	settings.set("argot.enabled", true);
	settings.set("memory.backend", "mnemopi");
	settings.set("fetch.enabled", true);

	return {
		cwd: "/workspace",
		hasUI: true,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => "main",
		getArgotSession: () => undefined,
		getMnemopiSessionState: () => undefined,
		getHindsightSessionState: () => undefined,
		getCheckpointState: () => undefined,
		getLastCompletedRewind: () => undefined,
	};
}

describe("Manifest tool contracts", () => {
	const session = createTestSession();
	const allManifestTools = { ...BUILTIN_TOOLS, ...HIDDEN_TOOLS };

	it("registers exactly the declared builtin and hidden tool names", () => {
		expect(Object.keys(BUILTIN_TOOLS).sort()).toEqual([...BUILTIN_TOOL_NAMES].sort());
		expect(Object.keys(HIDDEN_TOOLS).sort()).toEqual([...HIDDEN_TOOL_NAMES].sort());
	});

	for (const [manifestKey, factory] of Object.entries(allManifestTools)) {
		it(`tool \`${manifestKey}\` matches name, description, schema, approval, and renderer`, async () => {
			const tool = await factory(session);
			if (!tool) {
				// Tool conditionally skipped (e.g. absent backend)
				return;
			}

			expect(tool.name).toBe(manifestKey);
			expect(typeof tool.description).toBe("string");
			expect(tool.description.trim().length).toBeGreaterThan(0);
			expect(tool.parameters).toBeDefined();

			// Every constructible tool declares its tier. An undeclared tier is not "no opinion": the
			// resolver defaults it to `exec`, the most restrictive prompt-and-deny path.
			expect(tool.approval).toBeDefined();
			const approvalVal = typeof tool.approval === "function" ? tool.approval({}) : tool.approval;
			expect(typeof approvalVal === "string" && VALID_APPROVAL_TIERS[approvalVal] === true).toBe(true);

			if (!NON_RENDERING_TOOLS[manifestKey]) {
				const hasRenderer = Boolean(tool.view) || Boolean(toolRenderers[manifestKey]);
				expect(hasRenderer).toBe(true);
			}
		});
	}
});
