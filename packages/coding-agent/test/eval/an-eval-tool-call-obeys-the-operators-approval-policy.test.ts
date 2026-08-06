/**
 * A tool call made from an eval snippet is subject to the same approval policy
 * as one the model makes through the agent loop.
 *
 * WHY THIS SUITE EXISTS. Approval is enforced in exactly one place,
 * `ExtensionToolWrapper.execute`, and that wrapper reads its entire policy off
 * the `AgentToolContext` its caller hands it. The agent loop resolves that
 * context per call. The eval and browser bridges reach the same registered,
 * approval-wrapped tools directly, and for a while they passed no context at
 * all.
 *
 * An absent context does not read as "unknown, so ask". Every control resolves
 * to its permissive branch at once, because each one is a field that is now
 * missing:
 *
 *  - `settings` gone, so `tools.approval.<tool>: deny` is an empty policy map
 *    and a hard block the operator wrote by hand never fires.
 *  - `planModeActive` gone, so a plan session stops capping mutation.
 *  - `sessionApprovals` gone, so "Deny for session" is forgotten on the next
 *    call through the bridge.
 *  - `sessionManager` gone, so the cwd boundary compares against "".
 *
 * That matters here more than anywhere else: an eval snippet is model-authored
 * text, which is precisely the caller those controls exist to gate. Nothing
 * about the failure is visible, either. The call simply succeeds.
 *
 * Each case below pins one of those fields by observing the wrapper's decision
 * through the real `callSessionTool`, and the last one is the positive control
 * that keeps the others honest.
 */
import { describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolContext } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { callSessionTool } from "@veyyon/coding-agent/eval/js/tool-bridge";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import type { SessionToolApprovals } from "@veyyon/coding-agent/tools/approval-modes";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { type } from "arktype";

/** Text the tool returns when it actually runs, so "did it run" is observable. */
const RAN = "the tool ran";

/**
 * A runner with no handlers and no UI. A prompt it cannot show becomes a throw,
 * which is what a non-interactive eval context really is.
 */
const runner = {
	hasHandlers: () => false,
	hasUI: () => false,
	getUIContext: () => undefined,
	emit: async () => undefined,
	emitToolCall: async () => undefined,
	emitToolResult: async () => undefined,
	createContext: () => ({}),
} as unknown as ExtensionRunner;

/**
 * An exec-tier tool, wrapped exactly as the session registry wraps it. Exec is
 * the tier `auto` runs unasked, so any refusal below comes from the operator's
 * policy rather than from the rung.
 */
function wrappedTool(name = "bash"): AgentTool {
	const tool = {
		name,
		label: name,
		summary: "records that it ran",
		description: "records that it ran",
		parameters: type({}),
		approval: () => ({ tier: "exec" as const }),
		execute: async () => ({ content: [{ type: "text", text: RAN }] }),
	} as unknown as AgentTool;
	return new ExtensionToolWrapper(tool, runner) as unknown as AgentTool;
}

function sessionWithContext(context: AgentToolContext | undefined): ToolSession {
	const tool = wrappedTool();
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		getToolByName: name => (name === tool.name ? tool : undefined),
		getToolContext: () => context,
	};
}

/** The real store shape: two operations over a Map, no iteration, no clear. */
function grants(seed: Record<string, "allow" | "deny">): SessionToolApprovals {
	const map = new Map<string, "allow" | "deny">(Object.entries(seed));
	return {
		get: toolName => map.get(toolName),
		set: (toolName, decision) => {
			map.set(toolName, decision);
		},
	};
}

describe("an eval tool call obeys the operator's approval policy", () => {
	it("refuses a tool the operator denied by hand", async () => {
		const session = sessionWithContext({
			settings: Settings.isolated({ "tools.approval": { bash: "deny" } }),
		} as unknown as AgentToolContext);

		await expect(callSessionTool("bash", { command: "id" }, { session })).rejects.toThrow(
			'Tool "bash" is blocked by user policy.',
		);
	});

	it("still caps mutation while a plan session is active", async () => {
		const session = sessionWithContext({
			settings: Settings.isolated(),
			planModeActive: true,
		} as unknown as AgentToolContext);

		// Plan mode refuses outright rather than prompting, so the message is the
		// plan reason and not the missing-UI advice.
		await expect(callSessionTool("bash", { command: "id" }, { session })).rejects.toThrow(/plan/i);
	});

	it("remembers a 'Deny for session' answer the operator already gave", async () => {
		const session = sessionWithContext({
			settings: Settings.isolated({ "tools.approvalMode": "ask" }),
			sessionApprovals: grants({ bash: "deny" }),
		} as unknown as AgentToolContext);

		await expect(callSessionTool("bash", { command: "id" }, { session })).rejects.toThrow(
			"Tool call denied for this session: bash",
		);
	});

	it("runs the call when nothing denies it, so the gate is not simply closed", async () => {
		const session = sessionWithContext({
			settings: Settings.isolated(),
		} as unknown as AgentToolContext);

		expect(await callSessionTool("bash", { command: "id" }, { session })).toBe(RAN);
	});
});
