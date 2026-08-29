import * as fs from "node:fs/promises";
import { isEnoent } from "@veyyon/utils";
import type { FileEntry, SessionMessageEntry } from "../../session/session-entries";
import { parseSessionEntries } from "../../session/session-loader";
import type { AgentProgress, SubagentLifecyclePayload, SubagentProgressPayload } from "../../task";
import type { RpcSubagentFrame, RpcSubagentMessagesResult, RpcSubagentSnapshot } from "./rpc-types";

export interface RpcSubagentTranscriptSelector {
	subagentId?: string;
	sessionFile?: string;
	fromByte?: number;
}

export type RpcSubagentOutput = (frame: RpcSubagentFrame) => void;

export const MAX_RETAINED_TRANSCRIPT_REFERENCES = 256;

export function isSessionMessageEntry(entry: FileEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

export function statusFromLifecycle(status: SubagentLifecyclePayload["status"]): AgentProgress["status"] {
	return status === "started" ? "running" : status;
}

export function isTerminalLifecycleStatus(status: SubagentLifecyclePayload["status"]): boolean {
	return status !== "started";
}

export function hasSameOwner(
	payload: Pick<SubagentLifecyclePayload | SubagentProgressPayload, "parentToolCallId" | "sessionFile">,
	snapshot: RpcSubagentSnapshot,
): boolean {
	if (payload.parentToolCallId !== undefined && snapshot.parentToolCallId !== undefined) {
		return payload.parentToolCallId === snapshot.parentToolCallId;
	}
	if (payload.sessionFile !== undefined && snapshot.sessionFile !== undefined) {
		return payload.sessionFile === snapshot.sessionFile;
	}
	return true;
}

export function addPruned(set: Set<string>, value: string, maxSize: number): void {
	set.delete(value);
	set.add(value);
	while (set.size > maxSize) {
		const oldest = set.keys().next();
		if (oldest.done) break;
		set.delete(oldest.value);
	}
}

export async function readRpcSubagentTranscript(sessionFile: string, fromByte = 0): Promise<RpcSubagentMessagesResult> {
	let startByte = Number.isFinite(fromByte) ? Math.max(0, Math.trunc(fromByte)) : 0;
	const file = Bun.file(sessionFile);
	let size: number;
	try {
		({ size } = await fs.stat(sessionFile));
	} catch (err) {
		if (!isEnoent(err)) throw err;
		return {
			sessionFile,
			fromByte: startByte,
			nextByte: startByte,
			reset: false,
			entries: [],
			messages: [],
		};
	}
	let reset = false;
	if (startByte > size) {
		startByte = 0;
		reset = true;
	}

	const text = startByte >= size ? "" : await file.slice(startByte).text();
	const lastNewline = text.lastIndexOf("\n");
	const completeText = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : "";
	const entries = completeText.length > 0 ? parseSessionEntries(completeText) : [];
	const nextByte = startByte + Buffer.byteLength(completeText, "utf8");

	return {
		sessionFile,
		fromByte: startByte,
		nextByte,
		reset,
		entries,
		messages: entries.filter(isSessionMessageEntry).map(entry => entry.message),
	};
}
