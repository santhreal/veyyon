import type { AssistantMessage } from "@veyyon/ai";
import { type Component, getSegmenter } from "@veyyon/tui";
import { LRUCache } from "lru-cache/raw";
import type { AssistantMessageComponent } from "../components/assistant-message";

export const STREAMING_REVEAL_FRAME_MS = 1000 / 30;
export const MIN_STEP = 3;
export const CATCHUP_FRAMES = 8;

export type AssistantContentBlock = AssistantMessage["content"][number];
export function messageHasToolCall(message: AssistantMessage): boolean {
	for (let i = 0; i < message.content.length; i++) {
		if (message.content[i]!.type === "toolCall") return true;
	}
	return false;
}
export type DisplayThinkingContentBlock = Extract<AssistantContentBlock, { type: "thinking" }> & {
	rawThinking?: string;
};
export type StreamingRevealComponent = Pick<AssistantMessageComponent, "updateContent"> & Component;
export type GraphemeSlicer = (index: number, text: string, units: number) => string;

export type StreamingRevealControllerOptions = {
	getSmoothStreaming(): boolean;
	getHideThinkingBlock(): boolean;
	getProseOnlyThinking(): boolean;
	requestRender(component: Component): void;
};

export const graphemeCountCache = new LRUCache<string, number>({ max: 128 });

export function countGraphemes(text: string): number {
	if (text.length === 0) return 0;
	const cached = graphemeCountCache.get(text);
	if (cached !== undefined) return cached;
	let count = 0;
	for (const _segment of getSegmenter().segment(text)) {
		count += 1;
	}
	graphemeCountCache.set(text, count);
	return count;
}

export function countGraphemesFrom(text: string, start: number): { count: number; tailStart: number } {
	let count = 0;
	let tailStart = start;
	for (const seg of getSegmenter().segment(start === 0 ? text : text.slice(start))) {
		count += 1;
		tailStart = start + seg.index;
	}
	return { count, tailStart };
}
export function segmentFrom(
	text: string,
	start: number,
	clusters: number,
): { end: number; lastStart: number; count: number } {
	let count = 0;
	let lastStart = start;
	let end = start;
	for (const seg of getSegmenter().segment(start === 0 ? text : text.slice(start))) {
		count += 1;
		lastStart = start + seg.index;
		end = start + seg.index + seg.segment.length;
		if (count >= clusters) break;
	}
	return { end, lastStart, count };
}
