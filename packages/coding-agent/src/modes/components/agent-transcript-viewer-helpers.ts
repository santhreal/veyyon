import * as fs from "node:fs";
import type { AgentTool } from "@veyyon/agent-core";
import type { TUI } from "@veyyon/tui";
import type { KeyId } from "../../config/keybindings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import type { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import type { AgentRegistry } from "../../registry/agent-registry";
import type { SessionMessageEntry } from "../../session/session-entries";
import { replaceTabs, shortenPath, truncateToWidth } from "../../tools/render-utils";
import type { SessionObserverRegistry } from "../session-observer-registry";

export interface AgentTranscriptRemoteRead {
	text: string;
	newSize: number;
	error?: string;
}

export interface AgentTranscriptRemote {
	chat(id: string, text: string): void;
	kill(id: string): void;
	revive(id: string): void;
	readTranscript(id: string, fromByte: number): Promise<AgentTranscriptRemoteRead | null>;
}

export interface AgentTranscriptViewerDeps {
	agentId: string;
	registry: AgentRegistry;
	remote?: AgentTranscriptRemote;
	observers?: SessionObserverRegistry;
	lifecycle?: () => AgentLifecycleManager;
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	expandArgot?: (entries: SessionMessageEntry[]) => SessionMessageEntry[];
	expandKeys: KeyId[];
	hubKeys: KeyId[];
	requestRender: () => void;
	onClose: () => void;
	onHubClose: () => void;
}

export const POLL_MS = 250;

export const SENTINEL_BYTES = 4096;

export function sanitizeErrorLine(text: string, maxWidth: number): string {
	const singleLine = replaceTabs(text)
		.replace(/[\r\n]+/g, " ")
		.replace(/\/[^\s'")\]]+/g, p => shortenPath(p));
	return truncateToWidth(singleLine, Math.max(10, maxWidth));
}

export interface LocalTranscriptSentinel {
	offset: number;
	bytes: Buffer;
}

export interface LocalTranscriptState {
	path: string;
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	offset: number;
	pending: string;
	sentinels: LocalTranscriptSentinel[];
}

export function readFileRangeSync(file: string, offset: number, length: number): Buffer {
	if (length <= 0) return Buffer.alloc(0);
	const fd = fs.openSync(file, "r");
	try {
		const buffer = Buffer.alloc(length);
		const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
		return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
	} finally {
		fs.closeSync(fd);
	}
}

function sentinelOffsets(size: number): number[] {
	if (size <= 0) return [];
	const length = Math.min(SENTINEL_BYTES, size);
	return Array.from(new Set([0, Math.max(0, Math.floor((size - length) / 2)), Math.max(0, size - length)]));
}

export function sentinelsFromBuffer(buffer: Buffer): LocalTranscriptSentinel[] {
	const size = buffer.byteLength;
	const length = Math.min(SENTINEL_BYTES, size);
	return sentinelOffsets(size).map(offset => ({
		offset,
		bytes: Buffer.from(buffer.subarray(offset, offset + length)),
	}));
}

export function sentinelsFromFile(file: string, size: number): LocalTranscriptSentinel[] {
	const length = Math.min(SENTINEL_BYTES, size);
	return sentinelOffsets(size).map(offset => ({ offset, bytes: readFileRangeSync(file, offset, length) }));
}
