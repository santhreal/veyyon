/** Print mode (single-shot): Send prompts, output result, exit. */
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, ImageContent } from "@veyyon/ai";
import { logger, sanitizeText } from "@veyyon/utils";
import { transformProviderPayload } from "../provider-boundary";
import { SECRET_SPEND_NOTICE_SOURCE } from "../secrets/notices";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { isSilentAbort } from "../session/messages";
import { executeAcpBuiltinSlashCommand } from "../slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "../slash-commands/types";
import { flushTelemetryExport } from "../telemetry-export";
import { initializeExtensions } from "./runtime-init";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** If true, include thinking blocks in text output */
	printThoughts?: boolean;
	/**
	 * Headless slash-command runtime supplied by the CLI entrypoint. Optional
	 * only for narrow unit-test sessions that cannot execute builtins.
	 */
	commandRuntime?: Omit<SlashCommandRuntime, "output">;
}

/** Drop the provider-opaque replay payload (e.g. encrypted reasoning items) before printing. */
function stripProviderPayload<T extends AgentMessage>(message: T): T {
	if (!("providerPayload" in message) || message.providerPayload === undefined) return message;
	const { providerPayload: _providerPayload, ...rest } = message;
	return rest as T;
}

/** Named so a failed redaction says which sink refused to emit. */
const JSON_OUTPUT_BOUNDARY = "print mode --mode json output";

/**
 * Shape an event for `--mode json` output.
 *
 * Removes two classes of bloat so transcripts grow linearly with conversation
 * size instead of quadratically (a single long turn used to re-serialize its
 * whole in-progress message on every streamed delta, producing multi-GB logs):
 * - `message_update` snapshots (`message`, `assistantMessageEvent.partial`,
 *   and the `done`/`error` payloads) are dropped; only the incremental delta
 *   is printed. The authoritative message follows in `message_end`.
 * - `providerPayload` is transport-native replay state, opaque and useless
 *   outside this process.
 */
export function printableEvent(event: AgentSessionEvent): unknown {
	switch (event.type) {
		case "message_update": {
			const streamEvent = event.assistantMessageEvent;
			if (streamEvent.type === "done" || streamEvent.type === "error") {
				return {
					type: "message_update",
					assistantMessageEvent: { type: streamEvent.type, reason: streamEvent.reason },
				};
			}
			const { partial: _partial, ...rest } = streamEvent;
			return { type: "message_update", assistantMessageEvent: rest };
		}
		case "message_start":
		case "message_end":
			return { ...event, message: stripProviderPayload(event.message) };
		case "turn_end":
			return {
				...event,
				message: stripProviderPayload(event.message),
				toolResults: event.toolResults.map(stripProviderPayload),
			};
		case "agent_end":
			return { ...event, messages: event.messages.map(stripProviderPayload) };
		default:
			return event;
	}
}

/** The session surface print mode uses. */
export type PrintModeSession =
	| AgentSession
	| (Pick<AgentSession, "subscribe" | "prompt" | "dispose" | "displayAssistantContent" | "obfuscateProviderText"> & {
			state: { messages: readonly AgentMessage[] };
			sessionManager: { getHeader(): unknown };
			extensionRunner?: undefined;
	  });

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(session: PrintModeSession, options: PrintModeOptions): Promise<void> {
	const { mode, messages = [], initialMessage, initialImages, printThoughts, commandRuntime } = options;

	// Redact secrets before writing to JSON stream.
	const writeJsonLine = (payload: unknown): void => {
		const redacted = transformProviderPayload(
			payload,
			text => session.obfuscateProviderText(text),
			JSON_OUTPUT_BOUNDARY,
		);
		process.stdout.write(`${JSON.stringify(redacted)}\n`);
	};

	// Emit session header for JSON mode
	if (mode === "json") {
		const header = session.sessionManager.getHeader();
		if (header) {
			writeJsonLine(header);
		}
	}
	// Set up extensions for print mode (no UI, no command context).
	if (session.extensionRunner !== undefined) {
		await initializeExtensions(session, {
			reportSendError: (action, err) => {
				process.stderr.write(
					`Extension ${action === "extension_send" ? "sendMessage" : "sendUserMessage"} failed: ${err.message}\n`,
				);
			},
			reportRuntimeError: err => {
				process.stderr.write(`Extension error (${err.extensionPath}): ${err.error}\n`);
			},
		});
	}

	// Always subscribe to enable session persistence via _handleAgentEvent
	session.subscribe(event => {
		// In JSON mode, output all events
		if (mode === "json") {
			writeJsonLine(printableEvent(event));
			return;
		}
		// In text mode, emit notices to stderr.
		if (event.type === "notice" && event.source === SECRET_SPEND_NOTICE_SOURCE) {
			process.stderr.write(`${sanitizeText(event.message)}\n`);
		}
	});

	let wroteTextWorkingIndicator = false;
	const writeTextWorkingIndicator = (): void => {
		if (mode !== "text" || wroteTextWorkingIndicator) return;
		process.stderr.write("Working...\n");
		wroteTextWorkingIndicator = true;
	};

	let promptedModel = false;
	const emitCommandOutput = (text: string): void => {
		if (mode === "json") {
			writeJsonLine({ type: "command_output", text });
		} else {
			process.stdout.write(`${sanitizeText(text)}\n`);
		}
	};
	const dispatchPromptOrCommand = async (message: string, images?: ImageContent[]): Promise<void> => {
		let prompt = message;
		if (commandRuntime) {
			const result = await executeAcpBuiltinSlashCommand(message, {
				...commandRuntime,
				output: emitCommandOutput,
			});
			if (result !== false) {
				if ("consumed" in result) return;
				prompt = result.prompt;
			}
		}
		writeTextWorkingIndicator();
		promptedModel = true;
		await session.prompt(prompt, images ? { images } : undefined);
	};

	if (initialMessage !== undefined) {
		await logger.time("print:prompt:initial", () => dispatchPromptOrCommand(initialMessage, initialImages));
	}
	for (const message of messages) {
		await logger.time("print:prompt:next", () => dispatchPromptOrCommand(message));
	}

	// In text mode, output final response
	if (mode === "text" && promptedModel) {
		const state = session.state;
		const lastMessage = state.messages[state.messages.length - 1];

		if (lastMessage?.role === "assistant") {
			const assistantMsg = lastMessage as AssistantMessage;

			// Check for error/aborted — skip silent-abort (plan-mode compaction transition)
			if (
				(assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") &&
				!isSilentAbort(assistantMsg)
			) {
				const errorLine = sanitizeText(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
				// Flush telemetry before hard exit.
				await flushTelemetryExport();
				const flushed = process.stderr.write(`${errorLine}\n`);
				if (flushed) {
					process.exit(1);
				} else {
					process.stderr.once("drain", () => process.exit(1));
				}
			}

			if (
				assistantMsg.errorMessage &&
				assistantMsg.stopReason !== "error" &&
				assistantMsg.stopReason !== "aborted"
			) {
				process.stderr.write(`${sanitizeText(assistantMsg.errorMessage)}\n`);
			}

			// Output text content through session display seam.
			for (const content of session.displayAssistantContent(assistantMsg.content)) {
				if (content.type === "text") {
					process.stdout.write(`${sanitizeText(content.text)}\n`);
				} else if (printThoughts && content.type === "thinking" && content.thinking.trim().length > 0) {
					process.stdout.write(`${sanitizeText(content.thinking)}\n`);
				}
			}
		}
	}

	await new Promise<void>((resolve, reject) => {
		process.stdout.write("", err => {
			if (err) reject(err);
			else resolve();
		});
	});

	await session.dispose();
}
