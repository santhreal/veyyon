import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { runPrintMode } from "@veyyon/coding-agent/modes/print-mode";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";

function makeAssistantMessage(text: string): AssistantMessage {
	const timestamp = Date.now();
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage,
		timestamp,
	};
}

interface DelayedSession {
	session: AgentSession;
	promptStarted: Promise<void>;
	resolvePrompt: () => void;
}

function createDelayedSession(finalMessage: AssistantMessage): DelayedSession {
	const messages: AssistantMessage[] = [];
	const { promise: promptStarted, resolve: markPromptStarted } = Promise.withResolvers<void>();
	const { promise: promptReleased, resolve: resolvePrompt } = Promise.withResolvers<void>();

	const session = {
		state: { messages },
		sessionManager: {
			getHeader: () => undefined,
		},
		extensionRunner: undefined,
		subscribe: () => () => {},
		prompt: async () => {
			markPromptStarted();
			await promptReleased;
			messages.push(finalMessage);
			return true;
		},
		dispose: async () => {},
		// The display seam (agent-session.ts) resolves obfuscated secret
		// placeholders and argot handles to real values before print-mode writes
		// them. This test drives cwd-independent literal content, so an identity
		// double exercises the print path without the full seam.
		displayAssistantContent: (content: AssistantMessage["content"]) => content,
	} as unknown as AgentSession;

	return { session, promptStarted, resolvePrompt };
}

describe("print mode working indicator", () => {
	let stderrOutput: string[];
	let stdoutOutput: string[];

	beforeEach(() => {
		stderrOutput = [];
		stdoutOutput = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			stderrOutput.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const chunk = args[0];
			if (typeof chunk === "string") stdoutOutput.push(chunk);
			const last = args[args.length - 1];
			if (typeof last === "function") last();
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("writes a text-mode working indicator before the prompt resolves and prints the final answer afterward", async () => {
		const delayed = createDelayedSession(makeAssistantMessage("final answer"));
		const run = runPrintMode(delayed.session, { mode: "text", initialMessage: "hello" });

		await delayed.promptStarted;
		try {
			expect(stderrOutput.join("")).toContain("Working");
			expect(stdoutOutput.join("")).toBe("");
		} finally {
			delayed.resolvePrompt();
			await run;
		}

		expect(stdoutOutput.join("")).toBe("final answer\n");
	});

	it("does not write the text-mode working indicator in JSON mode while the prompt is pending", async () => {
		const delayed = createDelayedSession(makeAssistantMessage("json answer"));
		const run = runPrintMode(delayed.session, { mode: "json", initialMessage: "hello" });

		await delayed.promptStarted;
		try {
			expect(stderrOutput.join("")).toBe("");
		} finally {
			delayed.resolvePrompt();
			await run;
		}
	});

	it("writes the text-mode working indicator once across successive prompts", async () => {
		const delayed = createDelayedSession(makeAssistantMessage("final answer"));
		const run = runPrintMode(delayed.session, {
			mode: "text",
			initialMessage: "hello",
			messages: ["follow-up"],
		});

		await delayed.promptStarted;
		delayed.resolvePrompt();
		await run;

		expect(stderrOutput.join("")).toBe("Working...\n");
	});
});
