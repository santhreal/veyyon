/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `veyyon -p "prompt"` - text output
 * - `veyyon --mode json "prompt"` - JSON event stream
 */
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

/**
 * The session surface print mode actually uses.
 *
 * Spelled out so a caller can pass something narrower than a full
 * {@link AgentSession} and still be type checked. The tests used to build a
 * stub and force it through with `as unknown as AgentSession`, which switched
 * the check off entirely: when print mode grew a call to
 * `displayAssistantContent`, the stub kept compiling without it and every test
 * in the file failed at runtime instead of at build time. A `Pick` cannot go
 * stale that way, because adding a member here is what fails the stub.
 *
 * The second arm carries `extensionRunner?: undefined` on purpose. Extension
 * setup needs the whole session, so the narrow form is only accepted when it
 * has no extensions to set up, and the check below narrows to the full session
 * before that call. That is the real contract, written down rather than cast
 * away.
 */
export type PrintModeSession =
	| AgentSession
	| (Pick<AgentSession, "subscribe" | "prompt" | "dispose" | "displayAssistantContent" | "obfuscateProviderText"> & {
			// Only the two members print mode reads, not the whole state object and
			// the whole SessionManager class. A caller that has just these can drive
			// print mode, and that is worth being able to say.
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

	// Every byte `--mode json` writes to stdout goes through here, and there is
	// exactly one of these so a later event type cannot be added past it.
	//
	// JSON mode is consumed by CI, wrappers, and anything piping stdout into a file,
	// so it is held to the PROVIDER standard rather than the display standard: the
	// placeholder, never the credential. The events this mode subscribes to are built
	// for a human at a terminal. `tool_execution_start` carries the arguments a tool was
	// actually handed, which are expanded by definition, and `displayAssistantContent`
	// restores placeholders in the text it is given. Restoration there is NOT a blanket
	// "the operator sees their own value", and this comment used to say it was: it is
	// governed by the display policy keyed on `SecretEntry.origin`, which withholds vault,
	// environment, and plain file secrets and restores only a `secrets.yml` regex match,
	// whose value is local text a rule recognised rather than a stored credential.
	// None of that helps this sink, because a stream somebody archives is not a screen.
	// Before this, a spend
	// under `--mode json` wrote the expanded credential to stdout in four places
	// (`tool_execution_start.args`, `message_start`/`message_end`, and the `agent_end`
	// message repeat) while the session file, the audit log, and the provider request
	// for the same turn were all clean.
	//
	// `transformProviderPayload` is the walker the outbound provider seam already uses,
	// so this is that seam applied to one more sink rather than a second scrubber that
	// can drift from it — and it fails closed: a transform that throws takes the write
	// with it instead of emitting unredacted bytes.
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
	// Set up extensions for print mode (no UI, no command context). The guard is
	// what narrows the session type; `initializeExtensions` returns immediately
	// on a session with no runner anyway, so this is the same behavior.
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
		// Text mode's stdout is the final answer and nothing else, because a caller pipes it
		// somewhere. A spend therefore goes to stderr, where `Working...` and error lines already
		// live. Without this, headless `-p` under yolo was the one surface left where a stored
		// credential could reach a live command with no signal at all: the approval boundary is
		// skipped in yolo by design, and text mode prints no events.
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

	// Initial and additional messages share one command gate. A consumed
	// builtin never reaches the model; a residual prompt keeps initial images.
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
				// Flush before this hard exit — it bypasses the awaited postmortem.quit()
				// in main(), and the postmortem `exit` handler can't await, so the error
				// spans would otherwise stay buffered in the batch processor and drop.
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

			// Output text content. The stored message keeps obfuscated secret
			// placeholders and cheap argot handles; route it through the session's
			// display seam so headless output shows real values, never a `#HASH#`
			// token or a bare `§handle`.
			for (const content of session.displayAssistantContent(assistantMsg.content)) {
				if (content.type === "text") {
					process.stdout.write(`${sanitizeText(content.text)}\n`);
				} else if (printThoughts && content.type === "thinking" && content.thinking.trim().length > 0) {
					process.stdout.write(`${sanitizeText(content.thinking)}\n`);
				}
			}
		}
	}

	// Ensure stdout is fully flushed before returning
	// This prevents race conditions where the process exits before all output is written
	await new Promise<void>((resolve, reject) => {
		process.stdout.write("", err => {
			if (err) reject(err);
			else resolve();
		});
	});

	await session.dispose();
}
