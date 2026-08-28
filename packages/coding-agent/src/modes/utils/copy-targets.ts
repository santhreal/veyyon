import type { AgentMessage } from "@veyyon/agent-core";
import type { ToolCall } from "@veyyon/ai";
import { assistantText as joinAssistantText } from "@veyyon/ai/utils/message-text";
import { formatCount } from "@veyyon/utils";

export interface CodeBlock {
	lang: string;
	code: string;
}

export interface QuoteBlock {
	text: string;
}

export type MessageBlock = ({ kind: "code" } & CodeBlock) | ({ kind: "quote" } & QuoteBlock);

export interface LastCommand {
	kind: "bash" | "eval";
	code: string;
	language: string;
}

export interface CopyTarget {
	id: string;
	label: string;
	hint?: string;
	preview: string;
	language?: string;
	content?: string;
	copyMessage?: string;
	children?: CopyTarget[];
}

export interface CopySource {
	readonly messages: readonly AgentMessage[];
	getLastVisibleHandoffText(): string | undefined;
}

const MAX_MESSAGES = 50;

const OPEN_FENCE_RE = /^```([^\n]*)$/;
const CLOSE_FENCE_RE = /^```/;
const QUOTE_LINE_RE = /^>(.*)$/;

export function extractBlocks(text: string): MessageBlock[] {
	const blocks: MessageBlock[] = [];
	const lines = text.split("\n");
	let quote: string[] | undefined;
	const flushQuote = () => {
		if (quote) {
			blocks.push({ kind: "quote", text: quote.join("\n") });
			quote = undefined;
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const open = OPEN_FENCE_RE.exec(line);
		if (open) {
			let close = -1;
			for (let k = i + 1; k < lines.length; k++) {
				if (CLOSE_FENCE_RE.test(lines[k]!)) {
					close = k;
					break;
				}
			}
			if (close !== -1) {
				flushQuote();
				blocks.push({ kind: "code", lang: open[1].trim(), code: lines.slice(i + 1, close).join("\n") });
				i = close;
				continue;
			}
		}

		const quoted = QUOTE_LINE_RE.exec(line);
		if (quoted) {
			quote ??= [];
			quote.push(quoted[1].startsWith(" ") ? quoted[1].slice(1) : quoted[1]);
		} else {
			flushQuote();
		}
	}
	flushQuote();
	return blocks;
}

export function extractCodeBlocks(text: string): CodeBlock[] {
	return extractBlocks(text)
		.filter((b): b is { kind: "code" } & CodeBlock => b.kind === "code")
		.map(b => ({ lang: b.lang, code: b.code }));
}

export function extractLastCodeBlock(messages: readonly AgentMessage[]): CodeBlock | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		const text = assistantText(msg);
		if (!text) continue;
		const blocks = extractCodeBlocks(text);
		if (blocks.length > 0) return blocks[blocks.length - 1];
	}
	return undefined;
}

export function extractQuoteBlocks(text: string): QuoteBlock[] {
	return extractBlocks(text)
		.filter((b): b is { kind: "quote" } & QuoteBlock => b.kind === "quote")
		.map(b => ({ text: b.text }));
}

function extractEvalCode(args: unknown): { code: string; language: string } | undefined {
	if (!args || typeof args !== "object") return undefined;
	const argsObj = args as { cells?: unknown; code?: unknown };
	const cells = Array.isArray(argsObj.cells)
		? argsObj.cells
		: typeof argsObj.code === "string"
			? [argsObj]
			: undefined;
	if (!cells) return undefined;

	const codeBlocks: string[] = [];
	let language = "python";
	let languageResolved = false;
	for (const cell of cells) {
		if (!cell || typeof cell !== "object") continue;
		const code = (cell as { code?: unknown }).code;
		if (typeof code !== "string" || code.length === 0) continue;
		codeBlocks.push(code);
		if (!languageResolved) {
			const lang = (cell as { language?: unknown }).language;
			language = lang === "js" ? "javascript" : lang === "rb" ? "ruby" : lang === "jl" ? "julia" : "python";
			languageResolved = true;
		}
	}

	return codeBlocks.length > 0 ? { code: codeBlocks.join("\n\n"), language } : undefined;
}

function commandFromToolCall(tc: ToolCall): LastCommand | undefined {
	if (tc.name === "bash" && typeof tc.arguments.command === "string") {
		return { kind: "bash", code: tc.arguments.command, language: "bash" };
	}
	if (tc.name === "eval") {
		const evalResult = extractEvalCode(tc.arguments);
		if (evalResult) return { kind: "eval", code: evalResult.code, language: evalResult.language };
	}
	return undefined;
}

export function extractLastCommand(messages: readonly AgentMessage[]): LastCommand | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const toolCalls = msg.content.filter((c): c is ToolCall => c.type === "toolCall");
		for (let j = toolCalls.length - 1; j >= 0; j--) {
			const command = commandFromToolCall(toolCalls[j]!);
			if (command) return command;
		}
	}
	return undefined;
}

function assistantText(msg: AgentMessage): string | undefined {
	if (msg.role !== "assistant") return undefined;
	return joinAssistantText(msg, "").trim() || undefined;
}

function pluralLines(text: string): string {
	let count = 0;
	if (text.length > 0) {
		count = 1;
		for (let i = 0; i < text.length; i++) {
			if (text.charCodeAt(i) === 0x0a) count++;
		}
	}
	return formatCount("line", count);
}

function blockHint(block: CodeBlock): string {
	const lines = pluralLines(block.code);
	return block.lang ? `${block.lang} · ${lines}` : lines;
}

function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) return trimmed.replace(/\s+/g, " ");
	}
	return text.trim().replace(/\s+/g, " ");
}

function blockSummaryHint(text: string, codeCount: number, quoteCount: number): string {
	const parts = [pluralLines(text)];
	if (codeCount > 0) parts.push(`${codeCount} code`);
	if (quoteCount > 0) parts.push(`${quoteCount} quote`);
	return parts.join(" · ");
}

function messageTarget(text: string, rank: number): CopyTarget {
	const id = `msg:${rank}`;
	const label = firstLine(text);
	const blocks = extractBlocks(text);
	const messageCopy = rank === 1 ? "Copied last message to clipboard" : "Copied message to clipboard";

	if (blocks.length === 0) {
		return { id, label, hint: pluralLines(text), preview: text, content: text, copyMessage: messageCopy };
	}

	const children: CopyTarget[] = [];
	const codeBlocks: CodeBlock[] = [];
	const quoteBlocks: QuoteBlock[] = [];
	for (const block of blocks) {
		if (block.kind === "code") {
			const j = codeBlocks.length;
			codeBlocks.push(block);
			children.push({
				id: `${id}:code:${j}`,
				label: `Block ${j + 1}`,
				hint: blockHint(block),
				preview: block.code,
				language: block.lang || undefined,
				content: block.code,
				copyMessage: `Copied code block ${j + 1} to clipboard`,
			});
		} else {
			const j = quoteBlocks.length;
			quoteBlocks.push(block);
			children.push({
				id: `${id}:quote:${j}`,
				label: `Quote ${j + 1}`,
				hint: pluralLines(block.text),
				preview: block.text,
				content: block.text,
				copyMessage: `Copied quote block ${j + 1} to clipboard`,
			});
		}
	}

	if (codeBlocks.length > 1) {
		const combined = codeBlocks.map(b => b.code).join("\n\n");
		children.push({
			id: `${id}:all`,
			label: `All ${codeBlocks.length} blocks`,
			hint: pluralLines(combined),
			preview: combined,
			content: combined,
			copyMessage: `Copied ${codeBlocks.length} code blocks to clipboard`,
		});
	}
	if (quoteBlocks.length > 1) {
		const combined = quoteBlocks.map(b => b.text).join("\n\n");
		children.push({
			id: `${id}:all-quotes`,
			label: `All ${quoteBlocks.length} quotes`,
			hint: pluralLines(combined),
			preview: combined,
			content: combined,
			copyMessage: `Copied ${quoteBlocks.length} quote blocks to clipboard`,
		});
	}

	const hint = blockSummaryHint(text, codeBlocks.length, quoteBlocks.length);
	return { id, label, hint, preview: text, content: text, copyMessage: messageCopy, children };
}

function commandTitle(command: LastCommand): string {
	return command.kind === "bash" ? "Bash command" : "Eval code";
}

function commandTarget(command: LastCommand, rank: number): CopyTarget {
	const title = commandTitle(command);
	return {
		id: `cmd:${rank}`,
		label: firstLine(command.code) || title,
		hint: `${command.kind} · ${pluralLines(command.code)}`,
		preview: command.code,
		language: command.language,
		content: command.code,
		copyMessage: `Copied ${command.kind === "bash" ? "bash command" : "eval code"} to clipboard`,
	};
}

export function buildCopyTargets(source: CopySource): CopyTarget[] {
	const targets: CopyTarget[] = [];
	const pendingCommands: LastCommand[] = [];
	let messageRank = 0;
	let commandRank = 0;

	const appendCommands = (commands: readonly LastCommand[]) => {
		for (const command of commands) {
			commandRank += 1;
			targets.push(commandTarget(command, commandRank));
		}
	};

	for (let i = source.messages.length - 1; i >= 0 && messageRank < MAX_MESSAGES; i--) {
		const msg = source.messages[i];
		if (msg.role !== "assistant") continue;

		const toolCalls = msg.content.filter((c): c is ToolCall => c.type === "toolCall");
		const commands: LastCommand[] = [];
		for (let j = toolCalls.length - 1; j >= 0; j--) {
			const command = commandFromToolCall(toolCalls[j]!);
			if (command) commands.push(command);
		}

		const text = assistantText(msg);
		if (!text) {
			for (let ci = 0; ci < commands.length; ci++) pendingCommands.push(commands[ci]!);
			continue;
		}

		messageRank += 1;
		targets.push(messageTarget(text, messageRank));
		appendCommands(pendingCommands);
		appendCommands(commands);
		pendingCommands.length = 0;
	}

	if (messageRank === 0) {
		const handoff = source.getLastVisibleHandoffText();
		if (handoff) {
			targets.unshift({
				id: "handoff",
				label: "Handoff context",
				hint: pluralLines(handoff),
				preview: handoff,
				content: handoff,
				copyMessage: "Copied handoff context to clipboard",
			});
		}
		appendCommands(pendingCommands);
	}

	return targets;
}
