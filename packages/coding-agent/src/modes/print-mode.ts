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

export interface PrintModeOptions {
	mode: "text" | "json";
	messages?: string[];
	initialMessage?: string;
	initialImages?: ImageContent[];
	printThoughts?: boolean;
	commandRuntime?: Omit<SlashCommandRuntime, "output">;
}

function stripProviderPayload<T extends AgentMessage>(message: T): T {
	if (!("providerPayload" in message) || message.providerPayload === undefined) return message;
	const { providerPayload: _providerPayload, ...rest } = message;
	return rest as T;
}

const JSON_OUTPUT_BOUNDARY = "print mode --mode json output";

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

export type PrintModeSession =
	| AgentSession
	| (Pick<AgentSession, "subscribe" | "prompt" | "dispose" | "displayAssistantContent" | "obfuscateProviderText"> & {
			state: { messages: readonly AgentMessage[] };
			sessionManager: { getHeader(): unknown };
			extensionRunner?: undefined;
	  });

export async function runPrintMode(session: PrintModeSession, options: PrintModeOptions): Promise<void> {
	const { mode, messages = [], initialMessage, initialImages, printThoughts, commandRuntime } = options;

	const writeJsonLine = (payload: unknown): void => {
		const redacted = transformProviderPayload(
			payload,
			text => session.obfuscateProviderText(text),
			JSON_OUTPUT_BOUNDARY,
		);
		process.stdout.write(`${JSON.stringify(redacted)}\n`);
	};

	if (mode === "json") {
		const header = session.sessionManager.getHeader();
		if (header) {
			writeJsonLine(header);
		}
	}
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

	session.subscribe(event => {
		if (mode === "json") {
			writeJsonLine(printableEvent(event));
			return;
		}
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

	if (mode === "text" && promptedModel) {
		const state = session.state;
		const lastMessage = state.messages[state.messages.length - 1];

		if (lastMessage?.role === "assistant") {
			const assistantMsg = lastMessage as AssistantMessage;

			if (
				(assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") &&
				!isSilentAbort(assistantMsg)
			) {
				const errorLine = sanitizeText(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
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
