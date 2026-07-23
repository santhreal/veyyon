import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ExtensionUISelectItem } from "@veyyon/coding-agent/extensibility/extensions";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { AskTool } from "@veyyon/coding-agent/tools/ask";
import { ToolAbortError } from "@veyyon/coding-agent/tools/tool-errors";

/**
 * AskTool fail-path contract. Ask is the one tool that must NEVER invent an
 * answer: with no interactive UI it fails closed, and when the user's selection
 * rejects or is cancelled it propagates that, it never fabricates a choice.
 *
 * These lock three things the tool must not silently degrade (Law 10):
 *   - `createIf` returns null when the session has no UI, so ask is never even
 *     offered headlessly.
 *   - `execute` throws `ToolAbortError` when the runtime context has no UI, so a
 *     headless call fails loudly instead of hanging or guessing.
 *   - `execute` propagates a `select()` rejection and a `select()` cancellation
 *     (undefined) as an abort, so a dismissed dialog is never turned into a
 *     silent "ok" the model then acts on.
 * The positive twin proves the exact selected label is returned verbatim.
 */

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/ask-fail-paths",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

/** A runtime context whose only wired capability is `ui.select` + `abort`. */
function createContext(args: {
	hasUI?: boolean;
	ui?: boolean;
	select?: (prompt: string, options: ExtensionUISelectItem[]) => Promise<string | undefined>;
	abort?: () => void;
}): AgentToolContext {
	const base: Record<string, unknown> = {
		hasUI: args.hasUI ?? true,
		abort: args.abort ?? (() => {}),
	};
	if (args.ui !== false) {
		base.ui = {
			editor: () => Promise.resolve(undefined),
			...(args.select ? { select: args.select } : {}),
		};
	}
	return base as unknown as AgentToolContext;
}

const CONFIRM = {
	questions: [
		{
			id: "confirm",
			question: "Continue?",
			options: [{ label: "yes" }, { label: "no" }],
		},
	],
};

beforeAll(async () => {
	await initTheme(false);
});

describe("AskTool fail paths", () => {
	it("createIf returns null when the session has no UI, never offering ask headlessly", () => {
		expect(AskTool.createIf(createSession({ hasUI: false }))).toBeNull();
		expect(AskTool.createIf(createSession({ hasUI: true }))).toBeInstanceOf(AskTool);
	});

	it("throws ToolAbortError (and aborts the turn) when the context has no UI", async () => {
		let aborted = 0;
		const tool = new AskTool(createSession());
		const context = createContext({ hasUI: false, ui: false, abort: () => (aborted += 1) });
		await expect(tool.execute("a1", CONFIRM, undefined, undefined, context)).rejects.toBeInstanceOf(ToolAbortError);
		expect(aborted).toBe(1);
	});

	it("propagates a select() rejection instead of inventing an answer", async () => {
		const tool = new AskTool(createSession());
		const context = createContext({
			select: async () => {
				throw new Error("user-dismissed");
			},
		});
		await expect(tool.execute("a-rej", CONFIRM, undefined, undefined, context)).rejects.toThrow("user-dismissed");
	});

	it("treats a cancelled selection (undefined) as an abort, not a fabricated choice", async () => {
		let aborted = 0;
		const tool = new AskTool(createSession());
		const context = createContext({ select: async () => undefined, abort: () => (aborted += 1) });
		await expect(tool.execute("a-cancel", CONFIRM, undefined, undefined, context)).rejects.toBeInstanceOf(
			ToolAbortError,
		);
		expect(aborted).toBe(1);
	});

	it("returns an isError result (not a hang, not a silent ok) when no questions are given", async () => {
		const tool = new AskTool(createSession());
		const context = createContext({ select: async () => "yes" });
		const result = await tool.execute("a-empty", { questions: [] }, undefined, undefined, context);
		expect(result.isError).toBe(true);
		const text = result.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
			.map(b => b.text)
			.join("\n");
		expect(text).toContain("no questions");
	});

	it("returns the exact selected label verbatim when select resolves", async () => {
		const tool = new AskTool(createSession());
		const context = createContext({ select: async () => "yes" });
		const result = await tool.execute("a-ok", CONFIRM, undefined, undefined, context);
		const text = result.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
			.map(b => b.text)
			.join("\n");
		expect(text).toBe("User selected: yes");
	});
});
