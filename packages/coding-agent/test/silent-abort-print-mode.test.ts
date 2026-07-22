/**
 * Regression: print-mode must not write SILENT_ABORT_MARKER to stderr.
 *
 * Codex review flagged that `print-mode.ts` renders `errorMessage` verbatim
 * when stopReason is "aborted", which would surface the sentinel to stderr
 * (and exit with code 1). This test verifies the guard skips silent-abort.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import * as AIError from "@veyyon/ai/error";
import { type PrintModeSession, runPrintMode } from "@veyyon/coding-agent/modes/print-mode";
import { SILENT_ABORT_MARKER } from "@veyyon/coding-agent/session/messages";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "draft" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...overrides,
	};
}

/**
 * Minimal session for the print-mode text output path.
 *
 * Typed as {@link PrintModeSession} with no `as unknown as AgentSession` cast.
 * That cast is what let this file rot: print mode grew a call to
 * `displayAssistantContent`, the cast hid that the stub had no such method, and
 * all four tests below died with `session.displayAssistantContent is not a
 * function` at runtime. Without the cast, the same omission is a build error in
 * the same change that introduces it.
 */
function createMockSession(messages: AssistantMessage[]): PrintModeSession {
	return {
		state: { messages },
		sessionManager: {
			getHeader: () => undefined,
		},
		extensionRunner: undefined,
		subscribe: () => () => {},
		// Returns true: the real `prompt` reports whether the turn was accepted, and
		// the cast used to let this stub return void. Print mode ignores the value
		// today, but a stub that lies about the signature is how the next drift
		// goes unnoticed.
		prompt: async () => true,
		dispose: async () => {},
		// Print mode routes stored content through the session's display seam to
		// expand secret placeholders and argot handles. The real expansion is
		// covered by print-mode-argot-display.test.ts; here it is identity so the
		// tests observe exactly the content they supplied.
		displayAssistantContent: content => content,
	};
}

describe("Print-mode silent-abort regression", () => {
	let exitSpy: Mock<typeof process.exit>;
	let stderrOutput: string[];
	let stdoutOutput: string[];

	beforeEach(() => {
		stderrOutput = [];
		stdoutOutput = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			stderrOutput.push(String(chunk));
			return true;
		});
		exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const chunk = args[0];
			if (typeof chunk === "string") stdoutOutput.push(chunk);
			// Invoke callback if present (runPrintMode flushes stdout before returning)
			const last = args[args.length - 1];
			if (typeof last === "function") last();
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not write silent-abort marker to stderr or exit non-zero", async () => {
		const silentAbortMsg = makeAssistantMessage({
			stopReason: "aborted",
			errorMessage: SILENT_ABORT_MARKER,
			content: [],
		});

		const session = createMockSession([silentAbortMsg]);
		await runPrintMode(session, { mode: "text" });

		// The silent-abort marker MUST NOT appear in stderr
		const stderrText = stderrOutput.join("");
		expect(stderrText).not.toContain(SILENT_ABORT_MARKER);
		// process.exit MUST NOT have been called (clean termination)
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("does not write bit-classified silent aborts to stderr or exit non-zero", async () => {
		const silentAbortMsg = makeAssistantMessage({
			stopReason: "aborted",
			errorId: AIError.create(AIError.Flag.SilentAbort),
			errorMessage: undefined,
			content: [],
		});

		const session = createMockSession([silentAbortMsg]);
		await runPrintMode(session, { mode: "text" });

		expect(stderrOutput.join("")).toBe("");
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("writes real error messages to stderr and exits non-zero", async () => {
		const errorMsg = makeAssistantMessage({
			stopReason: "error",
			errorMessage: "Rate limit exceeded",
			content: [],
		});

		const session = createMockSession([errorMsg]);
		await runPrintMode(session, { mode: "text" });

		// A real error SHOULD be written to stderr
		const stderrText = stderrOutput.join("");
		expect(stderrText).toContain("Rate limit exceeded");
		// process.exit(1) SHOULD have been called
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("prints thinking blocks only when printThoughts is enabled", async () => {
		const message = makeAssistantMessage({
			content: [
				{ type: "thinking", thinking: "inspect hidden branch" },
				{ type: "text", text: "final answer" },
			],
		});

		await runPrintMode(createMockSession([message]), { mode: "text" });
		expect(stdoutOutput.join("")).toBe("final answer\n");

		stdoutOutput = [];
		await runPrintMode(createMockSession([message]), { mode: "text", printThoughts: true });
		expect(stdoutOutput.join("")).toBe("inspect hidden branch\nfinal answer\n");
	});
});
