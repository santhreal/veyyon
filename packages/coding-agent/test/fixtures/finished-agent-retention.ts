/**
 * What a finished agent keeps alive, measured in the process that runs this file.
 *
 * Spawns one agent through the task tool, parks it, wakes it with a follow-up turn, and holds what
 * outlives both runs in a real session: the options the child session was created with, the parked
 * agent's reviver and live session (both held by the lifecycle manager), each run's result and the
 * last progress snapshot each caller received. Each run streams `MESSAGES` assistant messages of
 * `MESSAGE_CHARS` distinct characters, so a run whose transient state stays reachable shows its
 * whole stream in the heap. Prints, as JSON, the fields of {@link FinishedAgentRetention}.
 *
 * Run in a fresh process: the snapshot reads the whole heap, and a test runner's heap holds whatever
 * the files before it left behind.
 */
import { vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@veyyon/coding-agent/session/factory-options";
import { TaskTool } from "@veyyon/coding-agent/task";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import { runSubagentFollowUpTurn } from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition, AgentProgress, TaskToolDetails } from "@veyyon/coding-agent/task/types";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import "@veyyon/coding-agent/tools/agent/yield";
import type { AgentToolResult } from "@veyyon/agent-core";
import { liveStringBytes } from "../../../utils/test/helpers/live-string-bytes";
import { createMockSession, yieldSuccessEvent } from "../helpers/agent-session";
import { makeToolSession } from "../helpers/tool-session";

export interface FinishedAgentRetention {
	/** Characters the two measured runs streamed, every one distinct. */
	streamedChars: number;
	/** String bytes live after both runs, less the bytes live before the first. */
	retainedBytes: number;
	/** Child sessions created: the spawn and the revive before the follow-up. */
	sessionsCreated: number;
	/** Whether each run's caller callback (the tool call's `onUpdate`, the follow-up's `onProgress`) was collected. */
	callbacksCollected: boolean[];
	/** Whether each run's caller abort signal was collected. */
	signalsCollected: boolean[];
	/** Tail lines the held progress snapshots show. */
	tailLines: number;
	/** The most snapshot bytes a string cell holding one of those lines keeps alive beyond its own characters. */
	tailPinned: number;
}

const MESSAGES = 8;
const MESSAGE_CHARS = 256 * 1024;
const LINE_CHARS = 64;
/** V8-format snapshots cut a string's value at this many characters. */
const VALUE_CAP = 1024;
/** A flat string cell's header, over its one or two bytes per character. */
const STRING_HEADER = 64;

const AGENT: AgentDefinition = {
	name: "task",
	description: "Task agent",
	systemPrompt: "Work.",
	source: "bundled",
};

/** Assistant text no other run shares, so the loader's string pool cannot fold one run into another. */
function streamedText(run: string, message: number, chars: number): string {
	const lines: string[] = [];
	for (let line = 0, size = 0; size < chars; line++) {
		const text = `${run}.${message}.${line} `.padEnd(LINE_CHARS, "x");
		lines.push(text);
		size += text.length + 1;
	}
	return lines.join("\n");
}

/** What the mock session emits on each prompt. */
type Turn = (call: { emit: (event: AgentSessionEvent) => void }) => void;

/** Streams `messages` assistant messages as deltas and finished messages, then yields. */
function streamingTurn(run: string, messages: number, chars: number): Turn {
	return ({ emit }) => {
		for (let message = 0; message < messages; message++) {
			const text = streamedText(run, message, chars);
			const assistant = { role: "assistant", content: [{ type: "text", text }] };
			emit({
				type: "message_update",
				message: assistant,
				assistantMessageEvent: { type: "text_delta", delta: text },
			} as unknown as AgentSessionEvent);
			emit({ type: "message_end", message: assistant } as unknown as AgentSessionEvent);
		}
		emit(yieldSuccessEvent({ ok: run }));
	};
}

const heldOptions: CreateAgentSessionOptions[] = [];
let nextTurn: Turn = streamingTurn("warm", 1, 1024);

vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
// Registers and attaches the child as `createAgentSession` does, and hands it the session manager the
// executor opened, which is what parking flushes.
vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
	heldOptions.push(options);
	const session = createMockSession(call => nextTurn(call), { activeToolNames: ["read", "yield"] });
	Object.assign(session, { sessionManager: options.sessionManager });
	const id = options.agentId;
	if (!id) throw new Error("the executor created a child session with no agent id");
	const sessionFile = options.sessionManager?.getSessionFile() ?? null;
	const registry = AgentRegistry.global();
	if (!registry.get(id)) {
		registry.register({ id, displayName: id, kind: "sub", session: null, sessionFile, status: "running" });
	}
	registry.attachSession(id, session, sessionFile);
	return {
		session,
		extensionsResult: {} as CreateAgentSessionResult["extensionsResult"],
		setToolUIContext: () => {},
		setToolNotifier: () => {},
		eventBus: new EventBus(),
	} satisfies CreateAgentSessionResult;
});

const tool = await TaskTool.create(
	makeToolSession({
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "agent.isolation.mode": "none" }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		modelRegistry: {
			authStorage: undefined,
			refresh: async () => {},
			getAvailable: () => [],
			getApiKey: async () => null,
		} as never,
	}),
);

interface HeldRun {
	id: string;
	result: unknown;
	progress: AgentProgress | undefined;
	callback: WeakRef<object>;
	signal: WeakRef<AbortSignal>;
}

/** One spawn through the task tool. Everything the call scope creates is unreachable once it returns, unless a survivor holds it. */
async function spawn(name: string): Promise<HeldRun> {
	const controller = new AbortController();
	let last: AgentToolResult<TaskToolDetails> | undefined;
	const onUpdate = (update: AgentToolResult<TaskToolDetails>) => {
		last = update;
	};
	const result = await tool.execute(
		`call-${name}`,
		{ agent: "task", name, task: "Work." },
		controller.signal,
		onUpdate,
	);
	const id = result.details?.results[0]?.id;
	if (!id) throw new Error(`the ${name} spawn returned no agent: ${JSON.stringify(result.content)}`);
	return {
		id,
		result,
		progress: last?.details?.progress?.[0],
		callback: new WeakRef(onUpdate),
		signal: new WeakRef(controller.signal),
	};
}

/** One follow-up turn to a parked agent, which revives it first. */
async function followUp(id: string): Promise<HeldRun> {
	const controller = new AbortController();
	let last: AgentProgress | undefined;
	const onProgress = (progress: AgentProgress) => {
		last = progress;
	};
	const result = await runSubagentFollowUpTurn({
		id,
		agent: AGENT,
		message: "Continue.",
		signal: controller.signal,
		onProgress,
	});
	return { id, result, progress: last, callback: new WeakRef(onProgress), signal: new WeakRef(controller.signal) };
}

const lifecycle = AgentLifecycleManager.global();
const warm = await spawn("Warm");
await lifecycle.park(warm.id);
await followUp(warm.id);
await lifecycle.release(warm.id);
heldOptions.length = 0;

const before = await liveStringBytes();
nextTurn = streamingTurn("spawn", MESSAGES, MESSAGE_CHARS);
const spawned = await spawn("Measured");
await lifecycle.park(spawned.id);
nextTurn = streamingTurn("follow", MESSAGES, MESSAGE_CHARS);
const followed = await followUp(spawned.id);
nextTurn = streamingTurn("idle", 1, 1024);
const after = await liveStringBytes();

const held = [spawned, followed];
const lines = held.flatMap(run => run.progress?.recentOutput ?? []);
Bun.gc(true);
const snapshot = JSON.parse(Bun.generateHeapSnapshot("v8")) as {
	snapshot: { meta: { node_fields: string[]; node_types: [string[]] } };
	nodes: number[];
	strings: string[];
};
const fields = snapshot.snapshot.meta.node_fields;
const TYPE = fields.indexOf("type");
const NAME = fields.indexOf("name");
const SIZE = fields.indexOf("self_size");
const stringType = snapshot.snapshot.meta.node_types[0].indexOf("string");
const measured = new Set(lines.filter(line => line.length < VALUE_CAP));
let tailPinned = 0;
for (let at = 0; at < snapshot.nodes.length; at += fields.length) {
	if (snapshot.nodes[at + TYPE] !== stringType) continue;
	const value = snapshot.strings[snapshot.nodes[at + NAME]!]!;
	if (!measured.has(value)) continue;
	tailPinned = Math.max(tailPinned, snapshot.nodes[at + SIZE]! - (value.length * 2 + STRING_HEADER));
}

const report: FinishedAgentRetention = {
	streamedChars: 2 * MESSAGES * streamedText("spawn", 0, MESSAGE_CHARS).length,
	retainedBytes: after - before,
	sessionsCreated: heldOptions.length,
	callbacksCollected: held.map(run => run.callback.deref() === undefined),
	signalsCollected: held.map(run => run.signal.deref() === undefined),
	tailLines: measured.size,
	tailPinned,
};
process.stdout.write(JSON.stringify(report), () => process.exit(0));
