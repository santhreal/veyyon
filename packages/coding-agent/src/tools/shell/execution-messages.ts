/**
 * The two transcript roles the shell domain records: a `!` command and a `$` Python run.
 *
 * Neither is a provider message. The operator ran something beside the model, the session records
 * what ran and what came out, and the model reads it as a user turn the next time the transcript is
 * sent. The shape, the wording the model reads and the conversion that memoises it are this
 * domain's, declared on its manifest as message kinds so the kernel converts the roles without
 * importing the shell.
 */
import type { Message } from "@veyyon/ai";
import type { AgentMessageKind } from "@veyyon/kernel/registry/message-kind";
import { formatExitCodeNotice } from "../../exec/exit-notice";
import { formatOutputNotice, type OutputMeta } from "../core/output-notice";

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	/**
	 * The signal that killed the command, when it died from one.
	 *
	 * A `!` command is run through the same executor as the agent's bash tool, so
	 * it inherits the same ambiguity: `exitCode` 137 is produced both by an
	 * out-of-memory kill and by a program calling `exit(137)`. Optional because
	 * sessions recorded before this field existed do not have it, and its absence
	 * means "not known", not "not a signal".
	 */
	signal?: number;
	cancelled: boolean;
	truncated: boolean;
	meta?: OutputMeta;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for user-initiated Python executions via the $ command.
 * Shares the same kernel session as eval's Python backend.
 */
export interface PythonExecutionMessage {
	role: "pythonExecution";
	code: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	meta?: OutputMeta;
	timestamp: number;
	/** If true, this message is excluded from LLM context ($$ prefix) */
	excludeFromContext?: boolean;
}

declare module "@veyyon/session" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		pythonExecution: PythonExecutionMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\n${formatExitCodeNotice(msg.exitCode, msg.signal)}`;
	}
	text += formatOutputNotice(msg.meta);
	return text;
}

/**
 * Convert a PythonExecutionMessage to user message text for LLM context.
 */
export function pythonExecutionToText(msg: PythonExecutionMessage): string {
	let text = `Ran Python:\n\`\`\`python\n${msg.code}\n\`\`\`\n`;
	if (msg.output) {
		text += `Output:\n\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(execution cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nExecution failed with code ${msg.exitCode}`;
	}
	text += formatOutputNotice(msg.meta);
	return text;
}

interface CachedBashExecution {
	converted: Message[];
	command: string;
	output?: string;
	cancelled?: boolean;
	exitCode?: number;
	signal?: number;
	meta?: OutputMeta;
}

interface CachedPythonExecution {
	converted: Message[];
	code: string;
	output?: string;
	cancelled?: boolean;
	exitCode?: number | null;
	meta?: OutputMeta;
}

// Keyed by message identity and checked field by field, as the kernel's conversion cache was
// before the roles moved here: a provider context that re-sends an unchanged prefix must get the
// same converted array back, or the prefix is re-transformed and the prompt cache is missed.
const bashExecutionCache = new WeakMap<BashExecutionMessage, CachedBashExecution>();
const pythonExecutionCache = new WeakMap<PythonExecutionMessage, CachedPythonExecution>();

export const bashExecutionKind: AgentMessageKind<BashExecutionMessage> = {
	role: "bashExecution",
	toText: bashExecutionToText,
	toLlm(m) {
		if (m.excludeFromContext) {
			return [];
		}
		const cached = bashExecutionCache.get(m);
		if (
			cached &&
			cached.command === m.command &&
			cached.output === m.output &&
			cached.cancelled === m.cancelled &&
			cached.exitCode === m.exitCode &&
			cached.signal === m.signal &&
			cached.meta === m.meta
		) {
			return cached.converted;
		}
		const converted: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: bashExecutionToText(m) }],
				attribution: "user",
				timestamp: m.timestamp,
			},
		];
		bashExecutionCache.set(m, {
			converted,
			command: m.command,
			output: m.output,
			cancelled: m.cancelled,
			exitCode: m.exitCode,
			signal: m.signal,
			meta: m.meta,
		});
		return converted;
	},
};

export const pythonExecutionKind: AgentMessageKind<PythonExecutionMessage> = {
	role: "pythonExecution",
	toText: pythonExecutionToText,
	toLlm(m) {
		if (m.excludeFromContext) {
			return [];
		}
		const cached = pythonExecutionCache.get(m);
		if (
			cached &&
			cached.code === m.code &&
			cached.output === m.output &&
			cached.cancelled === m.cancelled &&
			cached.exitCode === m.exitCode &&
			cached.meta === m.meta
		) {
			return cached.converted;
		}
		const converted: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: pythonExecutionToText(m) }],
				attribution: "user",
				timestamp: m.timestamp,
			},
		];
		pythonExecutionCache.set(m, {
			converted,
			code: m.code,
			output: m.output,
			cancelled: m.cancelled,
			exitCode: m.exitCode,
			meta: m.meta,
		});
		return converted;
	},
};
