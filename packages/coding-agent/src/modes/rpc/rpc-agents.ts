import * as fs from "node:fs/promises";
import type { FileEntry, SessionMessageEntry } from "@veyyon/kernel/session/session-entries";
import { parseSessionEntries } from "@veyyon/kernel/session/session-loader";
import { isEnoent } from "@veyyon/utils";
import {
	type AgentEventPayload,
	type AgentLifecyclePayload,
	type AgentProgress,
	type AgentProgressPayload,
	TASK_AGENT_EVENT_CHANNEL,
	TASK_AGENT_LIFECYCLE_CHANNEL,
	TASK_AGENT_PROGRESS_CHANNEL,
} from "../../task";
import type { EventBus } from "../../utils/event-bus";
import type {
	RpcAgentEventFrame,
	RpcAgentFrame,
	RpcAgentMessagesResult,
	RpcAgentSnapshot,
	RpcAgentSubscriptionLevel,
} from "./rpc-types";

export interface RpcAgentTranscriptSelector {
	agentId?: string;
	sessionFile?: string;
	fromByte?: number;
}

type RpcAgentOutput = (frame: RpcAgentFrame) => void;

const MAX_RETAINED_TRANSCRIPT_REFERENCES = 256;

function isSessionMessageEntry(entry: FileEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function statusFromLifecycle(status: AgentLifecyclePayload["status"]): AgentProgress["status"] {
	return status === "started" ? "running" : status;
}

function isTerminalLifecycleStatus(status: AgentLifecyclePayload["status"]): boolean {
	return status !== "started";
}

function hasSameOwner(
	payload: Pick<AgentLifecyclePayload | AgentProgressPayload, "parentToolCallId" | "sessionFile">,
	snapshot: RpcAgentSnapshot,
): boolean {
	if (payload.parentToolCallId !== undefined && snapshot.parentToolCallId !== undefined) {
		return payload.parentToolCallId === snapshot.parentToolCallId;
	}
	if (payload.sessionFile !== undefined && snapshot.sessionFile !== undefined) {
		return payload.sessionFile === snapshot.sessionFile;
	}
	return true;
}

function addPruned(set: Set<string>, value: string, maxSize: number): void {
	set.delete(value);
	set.add(value);
	while (set.size > maxSize) {
		const oldest = set.keys().next();
		if (oldest.done) break;
		set.delete(oldest.value);
	}
}

export async function readRpcAgentTranscript(sessionFile: string, fromByte = 0): Promise<RpcAgentMessagesResult> {
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

export class RpcAgentRegistry {
	#agents = new Map<string, RpcAgentSnapshot>();
	#transcriptSessionFilesByAgentId = new Map<string, string>();
	#staleAgentIds = new Set<string>();
	#unsubscribers: Array<() => void> = [];
	#output: RpcAgentOutput;
	#subscriptionLevel: RpcAgentSubscriptionLevel = "off";

	constructor(eventBus: EventBus, output: RpcAgentOutput) {
		this.#output = output;
		this.#unsubscribers.push(
			eventBus.on(TASK_AGENT_LIFECYCLE_CHANNEL, data => {
				this.handleLifecycle(data as AgentLifecyclePayload);
			}),
			eventBus.on(TASK_AGENT_PROGRESS_CHANNEL, data => {
				this.handleProgress(data as AgentProgressPayload);
			}),
			eventBus.on(TASK_AGENT_EVENT_CHANNEL, data => {
				this.handleEvent(data as AgentEventPayload);
			}),
		);
	}

	dispose(): void {
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		this.#unsubscribers = [];
		this.#agents.clear();
		this.#transcriptSessionFilesByAgentId.clear();
		this.#staleAgentIds.clear();
	}

	clear(): void {
		for (const agentId of this.#agents.keys()) {
			addPruned(this.#staleAgentIds, agentId, MAX_RETAINED_TRANSCRIPT_REFERENCES);
		}
		for (const agentId of this.#transcriptSessionFilesByAgentId.keys()) {
			addPruned(this.#staleAgentIds, agentId, MAX_RETAINED_TRANSCRIPT_REFERENCES);
		}
		this.#agents.clear();
		this.#transcriptSessionFilesByAgentId.clear();
	}

	setSubscriptionLevel(level: RpcAgentSubscriptionLevel): void {
		this.#subscriptionLevel = level;
	}

	getSubscriptionLevel(): RpcAgentSubscriptionLevel {
		return this.#subscriptionLevel;
	}

	getAgents(): RpcAgentSnapshot[] {
		return Array.from(this.#agents.values()).sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
	}

	#rememberTranscriptSession(agentId: string, sessionFile: string | undefined): void {
		if (!sessionFile) return;
		this.#transcriptSessionFilesByAgentId.delete(agentId);
		this.#transcriptSessionFilesByAgentId.set(agentId, sessionFile);
		while (this.#transcriptSessionFilesByAgentId.size > MAX_RETAINED_TRANSCRIPT_REFERENCES) {
			const oldest = this.#transcriptSessionFilesByAgentId.keys().next();
			if (oldest.done) break;
			this.#transcriptSessionFilesByAgentId.delete(oldest.value);
		}
	}

	#hasTranscriptSessionFile(sessionFile: string): boolean {
		for (const snapshot of this.#agents.values()) {
			if (snapshot.sessionFile === sessionFile) return true;
		}
		for (const transcriptSessionFile of this.#transcriptSessionFilesByAgentId.values()) {
			if (transcriptSessionFile === sessionFile) return true;
		}
		return false;
	}

	handleLifecycle(payload: AgentLifecyclePayload): void {
		const existing = this.#agents.get(payload.id);
		if (existing && !hasSameOwner(payload, existing)) return;
		if (!existing && payload.status !== "started") return;
		if (payload.status === "started") {
			this.#staleAgentIds.delete(payload.id);
		}
		const sessionFile = payload.sessionFile ?? existing?.sessionFile;
		const snapshot: RpcAgentSnapshot = {
			id: payload.id,
			index: payload.index,
			agent: payload.agent,
			agentSource: payload.agentSource,
			description: payload.description ?? existing?.description,
			status: statusFromLifecycle(payload.status),
			task: existing?.task,
			assignment: existing?.assignment,
			sessionFile,
			parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
			lastUpdate: Date.now(),
			progress: existing?.progress,
		};
		this.#rememberTranscriptSession(payload.id, sessionFile);
		if (isTerminalLifecycleStatus(payload.status)) {
			this.#agents.delete(payload.id);
		} else {
			this.#agents.set(payload.id, snapshot);
		}
		if (this.#subscriptionLevel !== "off") {
			this.#output({ type: "subagent_lifecycle", payload });
		}
	}

	handleProgress(payload: AgentProgressPayload): void {
		const progress = payload.progress;
		if (this.#staleAgentIds.has(progress.id)) return;
		const existing = this.#agents.get(progress.id);
		if (!existing) return;
		if (!hasSameOwner(payload, existing)) return;
		const sessionFile = payload.sessionFile ?? existing?.sessionFile;
		this.#rememberTranscriptSession(progress.id, sessionFile);
		this.#agents.set(progress.id, {
			id: progress.id,
			index: payload.index,
			agent: payload.agent,
			agentSource: payload.agentSource,
			description: progress.description ?? existing?.description,
			status: progress.status,
			task: payload.task,
			assignment: payload.assignment,
			sessionFile,
			lastUpdate: Date.now(),
			parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
			progress,
		});
		if (this.#subscriptionLevel !== "off") {
			this.#output({ type: "subagent_progress", payload });
		}
	}

	handleEvent(payload: AgentEventPayload): void {
		if (this.#staleAgentIds.has(payload.id)) return;
		if (this.#subscriptionLevel !== "events") return;
		this.#output({ type: "subagent_event", payload } satisfies RpcAgentEventFrame);
	}

	resolveSessionFile(selector: RpcAgentTranscriptSelector): string {
		if (selector.agentId) {
			const snapshot = this.#agents.get(selector.agentId);
			const sessionFile = snapshot?.sessionFile ?? this.#transcriptSessionFilesByAgentId.get(selector.agentId);
			if (!sessionFile) {
				throw new Error(`Unknown agent or session file unavailable: ${selector.agentId}`);
			}
			return sessionFile;
		}

		if (selector.sessionFile) {
			if (this.#hasTranscriptSessionFile(selector.sessionFile)) return selector.sessionFile;
			throw new Error("Unknown agent session file");
		}

		throw new Error("get_subagent_messages requires agentId or sessionFile");
	}
}
