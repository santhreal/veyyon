import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { EXIT_FAILURE, EXIT_INTERRUPTED } from "../src/cli/exit-codes";
import { type PrintModeOptions, type PrintModeSession, runPrintMode } from "../src/modes/print-mode";

/**
 * WHY THIS SUITE EXISTS:
 * When a model request in print mode is aborted (e.g. user cancellation / SIGINT),
 * the exit code must be EXIT_INTERRUPTED (130) so that CI systems and wrapper scripts
 * distinguish cancellation from a runtime failure (EXIT_FAILURE = 1).
 *
 * The class: the code is decided by the turn's stop reason, not by the output
 * mode. `--mode json` streamed the error event and exited 0, because the exit
 * branch sat under `mode === "text"`; a script piping JSON read the failure as
 * success. The sweep below runs every output mode print mode accepts through
 * both terminal stop reasons, and a `stop` control proves the branch is not
 * firing on every turn. Not caught: the text a mode prints for the error, and
 * the stdout drain ordering before the exit (stdout is mocked here).
 */

const OUTPUT_MODES: PrintModeOptions["mode"][] = ["text", "json"];

function makeAssistantMessage(stopReason: "stop" | "error" | "aborted", errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "partial text" }],
		api: "anthropic",
		provider: "anthropic",
		model: "claude-3-5-sonnet",
		stopReason,
		errorMessage,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("Print-mode exit codes on error vs aborted stopReason", () => {
	let exitCode: number | undefined;
	let exitCalls = 0;
	beforeEach(() => {
		exitCode = undefined;
		exitCalls = 0;
		vi.spyOn(process, "exit").mockImplementation((code?: number | string | null | undefined) => {
			exitCode = Number(code ?? 0);
			exitCalls++;
			return undefined as never;
		});
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(process.stdout, "write").mockImplementation((_chunk, callback) => {
			if (typeof callback === "function") callback();
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each(OUTPUT_MODES)("exits with EXIT_INTERRUPTED (130) when stopReason is aborted in %s mode", async mode => {
		const session: PrintModeSession = {
			subscribe: () => () => {},
			prompt: async () => true,
			dispose: async () => {},
			displayAssistantContent: content => content,
			obfuscateProviderText: text => text,
			sessionManager: { getHeader: () => null },
			state: {
				messages: [makeAssistantMessage("aborted", "Request aborted by user")],
			},
		};

		await runPrintMode(session, { mode, initialMessage: "test prompt" });
		expect(exitCalls).toBeGreaterThan(0);
		expect(exitCode).toBe(EXIT_INTERRUPTED);
	});

	it.each(OUTPUT_MODES)("exits with EXIT_FAILURE (1) when stopReason is error in %s mode", async mode => {
		const session: PrintModeSession = {
			subscribe: () => () => {},
			prompt: async () => true,
			dispose: async () => {},
			displayAssistantContent: content => content,
			obfuscateProviderText: text => text,
			sessionManager: { getHeader: () => null },
			state: {
				messages: [makeAssistantMessage("error", "API provider error")],
			},
		};

		await runPrintMode(session, { mode, initialMessage: "test prompt" });
		expect(exitCalls).toBeGreaterThan(0);
		expect(exitCode).toBe(EXIT_FAILURE);
	});

	it.each(OUTPUT_MODES)("control: a completed turn does not hard-exit in %s mode", async mode => {
		const session: PrintModeSession = {
			subscribe: () => () => {},
			prompt: async () => true,
			dispose: async () => {},
			displayAssistantContent: content => content,
			obfuscateProviderText: text => text,
			sessionManager: { getHeader: () => null },
			state: {
				messages: [makeAssistantMessage("stop")],
			},
		};

		await runPrintMode(session, { mode, initialMessage: "test prompt" });
		expect(exitCalls).toBe(0);
	});
});
