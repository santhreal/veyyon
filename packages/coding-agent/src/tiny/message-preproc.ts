import { stripAnsi } from "@veyyon/utils";

export const MAX_TINY_MESSAGE_CHARS = 2000;

const MIN_STRIPPED_TITLE_CHARS = 12;
const FENCED_CODE_BLOCK = /```+[\s\S]*?(?:```+|$)/g;
const XML_BLOCK = /<([a-zA-Z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;
const LONG_HEX_RUN = /\b[0-9a-fA-F]{12,}\b/g;
const SHORT_HASH_CHARS = 7;

export function stripXmlBlocks(message: string): string {
	return message.replace(XML_BLOCK, " ");
}

export function shortenHashes(message: string): string {
	return message.replace(LONG_HEX_RUN, match => match.slice(0, SHORT_HASH_CHARS));
}

export function truncateTinyMessage(message: string): string {
	if (message.length <= MAX_TINY_MESSAGE_CHARS) return message;
	let omitted = message.length - MAX_TINY_MESSAGE_CHARS;
	let marker = "";
	let headChars = 0;
	let tailChars = 0;
	for (let pass = 0; pass < 2; pass++) {
		marker = `\n[… ${omitted} chars omitted …]\n`;
		const keptChars = Math.max(0, MAX_TINY_MESSAGE_CHARS - marker.length);
		headChars = Math.ceil((keptChars * 2) / 3);
		tailChars = keptChars - headChars;
		omitted = message.length - headChars - tailChars;
	}
	marker = `\n[… ${omitted} chars omitted …]\n`;
	return `${message.slice(0, headChars)}${marker}${message.slice(-tailChars)}`;
}

export function stripCodeBlocks(message: string): string {
	const cleaned = message
		.replace(FENCED_CODE_BLOCK, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return cleaned.length >= MIN_STRIPPED_TITLE_CHARS ? cleaned : message;
}

export function cleanTinyMessage(message: string): string {
	return stripCodeBlocks(shortenHashes(stripXmlBlocks(stripAnsi(message))));
}

export function preprocessTinyMessage(message: string): string {
	return truncateTinyMessage(cleanTinyMessage(message));
}

const CHAT_CONTEXT_ENVELOPE = /^\s*<chat>[\s\S]*<\/chat>\s*$/;
const CHAT_SCAFFOLD_TAG = /<\/?(?:chat|user|assistant|think)>/g;

export function isPreformattedChatContext(message: string): boolean {
	return CHAT_CONTEXT_ENVELOPE.test(message);
}

export function stripChatScaffolding(message: string): string {
	return message.replace(CHAT_SCAFFOLD_TAG, " ");
}

export function formatTitleUserMessage(message: string): string {
	if (isPreformattedChatContext(message)) return message;
	return `<user>\n${preprocessTinyMessage(message)}\n</user>`;
}

export interface TitleConversationTurn {
	role: "user" | "assistant";
	text?: string;
	thinking?: string;
}

export function formatTitleConversationContext(turns: readonly TitleConversationTurn[]): string {
	const formattedTurns: string[] = [];
	for (const turn of turns) {
		const sections: string[] = [];
		const text = cleanTinyMessage(turn.text ?? "").trim();
		if (text) sections.push(text);
		const thinking = turn.role === "assistant" ? cleanTinyMessage(turn.thinking ?? "").trim() : "";
		if (thinking) sections.push(`<think>\n${thinking}\n</think>`);
		if (sections.length === 0) continue;
		formattedTurns.push(`<${turn.role}>\n${sections.join("\n\n")}\n</${turn.role}>`);
	}
	if (formattedTurns.length === 0) return "";
	return truncateTinyMessage(`<chat>\n${formattedTurns.join("\n\n")}\n</chat>`);
}
