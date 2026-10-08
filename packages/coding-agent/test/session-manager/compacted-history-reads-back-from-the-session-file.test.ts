/**
 * A session holds the payloads of entries its live context cannot reach on disk, and reads each
 * back from the session file on first use (`ColdEntryPayloads`). That is the history before the
 * newest compaction boundary, other branches, and the record-only kinds (`RECORD_ONLY_ENTRY_TYPES`)
 * wherever they sit: a spawned agent's `session_init` holds its whole joined system prompt for as
 * long as the agent stays live.
 *
 * WHY: a resumed 402 MiB session held 501 MiB of heap, 438 MiB of it in entries before the newest
 * compaction boundary. Moving those payloads out of memory opens a class of defects: a cold entry
 * that reads back different from what a load produces (an externalized payload or a codec-dropped
 * field left unrestored), an in-place update lost across a republish, a byte offset read against a
 * file object that no longer holds the line, a read handle that outlives every entry needing it,
 * and a live-context build that reads the disk.
 *
 * The suite closes that class by sweeping every member of the `SessionEntry` union (the fixture
 * table is typed against the union, so a new entry kind fails the type check until it has a row),
 * every externalization site persistence writes (image block, image data URL, oversized text, tool
 * result codec), and every event that changes the file under a cold entry (this manager's tail
 * republish, another writer's republish, the manager being dropped).
 *
 * The record-only sweep places every entry kind on the live branch and pins, by exact equality,
 * which kinds read the disk there, so a new kind fails until it is classified. A second sweep
 * appends every record-only kind after the session file exists, as a spawned agent does once it has
 * opened its transcript path, and fails for a kind added to `RECORD_ONLY_ENTRY_TYPES` without an
 * appender. An appended line goes cold only once it is read back from the file as written, so
 * another writer's line landing first leaves the entry in memory.
 *
 * The dropped-manager case runs in a fresh process (`fixtures/dropped-session-manager-descriptors.ts`):
 * after the files before this one tier up the cooling code, the runner's heap holds a conservative
 * root to a dropped manager's first cold stub, and no number of collections releases its handle.
 * The heap bound runs in a fresh process too (`fixtures/cold-history-heap.ts`): writing the fixture
 * reads the whole session file back, and a promise rooted outside the heap holds that text across
 * full collections, in this process, for a time that varies from run to run.
 *
 * A resume and every turn after it scan the whole branch for entries picked by a message's small
 * fields: the checkpoint rehydrate, the latest todo snapshot, the pending tool call warning. A cold
 * message entry keeps those fields in memory, so such a scan reads nothing back. The role sweep
 * places a message of every role the `AgentMessage` union declares in the compacted history (the
 * table is typed against the union, so a new role fails the type check until it has a row), reads
 * every small field the fresh load holds, runs those scans, and pins the reads at zero.
 *
 * A turn reads the session's spend only when a goal is charged for it, and the spend of the
 * summarized history lives in the large fields of its assistant turns and `task` results. Read
 * through the accessors, the first tally on a resumed session moved that whole history back into
 * memory: the first turn after resuming a 154 MiB session cost 470 ms of CPU and 103 MiB of peak
 * RSS more than the turns after it. The turn sweep runs a whole turn with no goal and pins the
 * reads at zero, then charges a goal and pins the reads at one per such entry, the totals at those
 * of the same file held in memory, and every summarized entry still on disk afterwards.
 *
 * A branch summary walks every message it sends the provider by property descriptor, and that walk
 * rejects accessors, which is what a cold message's large fields are. The size estimate the summary
 * runs first reads most of them back, so the walk met a cold message only when the history cooled
 * again in between: a publish landing while the credential resolved. The summary sweep cools the
 * history at that await and navigates back across every message role and every entry kind, and
 * pins the request to the one the same file sends when nothing is moved out of memory.
 *
 * A file at the stream threshold (`STREAM_LOAD_THRESHOLD_BYTES`) moves compacted history out of
 * memory while it loads (`LoadCooling`), as each compaction is read, rather than once the whole
 * file is in memory. That opens a second class: an entry moved before the load learns the branch
 * it resumes on, a usage total that misses a moved entry, a blob resolution that reads a moved
 * entry back, an older file whose moved lines read back unmigrated, and a load whose peak still
 * holds the whole history. The read-back sweeps run once per load path (`LOAD_PATHS`), with
 * compacted padding putting the streamed arm past the threshold; the branch sweep resumes on a
 * turn off summarized history; the migration sweep loads an older file; the heap bound samples
 * the heap at every turn of the event loop while a file with a compaction every eight results
 * streams in.
 *
 * NOT CAUGHT: the heap bounds have a 2x and 4x margin, so a regression that keeps a quarter of the
 * cold payloads resident passes. Windows holds no pinned reader, so there every entry stays in
 * memory and the fd assertions are skipped. A branch scan this suite does not run that reads a
 * large field of every compacted message still reads the history back. A descriptor walk other
 * than the branch summary's that is handed a whole session entry or message fails on a cold one.
 * A record-only entry a streamed load leaves in memory is moved once the load returns, so only the
 * load's peak, which no sweep here bounds for that kind, shows it. Every migration today changes
 * only fields a moved entry keeps in memory, so the migration sweep sees the older file load whole
 * through `cold` and not through a wrong value.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { SessionSpend, SessionStats } from "@veyyon/coding-agent/session/agent-session-types";
import { isSuccessfulCheckpointEntry } from "@veyyon/coding-agent/session/rewind-checkpoint";
import { getLatestTodoPhasesSnapshotFromEntries } from "@veyyon/coding-agent/tools/agent/todo";
import { shellDomain } from "@veyyon/coding-agent/tools/shell/manifest";
import { BlobStore, blobsDirForSessionDir } from "@veyyon/kernel/session/blob-store";
import { collectPendingToolCalls } from "@veyyon/kernel/session/exit-diagnostics";
import { registerAgentMessageKinds } from "@veyyon/kernel/session/message-kinds";
import {
	coldFieldsOf,
	MIN_COLD_STRING_LENGTH,
	RECORD_ONLY_ENTRY_TYPES,
} from "@veyyon/kernel/session/session-cold-payloads";
import type { SessionEntry, SessionEntryBase } from "@veyyon/kernel/session/session-entries";
import {
	loadSessionFile,
	resolveBlobRefsInEntries,
	STREAM_LOAD_THRESHOLD_BYTES,
} from "@veyyon/kernel/session/session-loader";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { FileSessionStorage, type PinnedSessionReader } from "@veyyon/kernel/session/session-storage";
import { registerToolResultCodecs } from "@veyyon/kernel/session/tool-result-codecs";
import type { ColdHistoryHeap } from "../fixtures/cold-history-heap";
import type { DroppedDescriptors } from "../fixtures/dropped-session-manager-descriptors";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const run = promisify(execFile);
const DROPPED_FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "dropped-session-manager-descriptors.ts");
const COLD_HEAP_FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "cold-history-heap.ts");

/**
 * A fresh process loads the session modules, opens one session and runs up to fifty full
 * collections, or reads 160 tool results of 128 KiB back.
 */
const SUBPROCESS_TIMEOUT_MS = 30_000;

const PROBE_TOOL = "cold_readback_probe";

// A branch summary converts the shell roles through the kinds the shell manifest declares,
// registered here the way the tool registry registers them.
registerAgentMessageKinds(shellDomain.messageKinds);

/** Drops `details.echo` when it repeats the result's first text block, and rebuilds it on load. */
registerToolResultCodecs([
	{
		toolName: PROBE_TOOL,
		slim(details: unknown, content: ToolResultMessage["content"]): unknown {
			const first = content[0];
			if (typeof details !== "object" || details === null || first?.type !== "text") return details;
			const { echo, ...rest } = details as Record<string, unknown>;
			return echo === first.text ? rest : details;
		},
		restore(details: unknown, content: ToolResultMessage["content"]): void {
			const first = content[0];
			if (typeof details !== "object" || details === null || first?.type !== "text") return;
			const record = details as Record<string, unknown>;
			if (!("echo" in record)) record.echo = first.text;
		},
	},
]);

/** Pinned readers a manager opened on the session file, and every read through them. */
class ObservedStorage extends FileSessionStorage {
	readonly open = new Set<PinnedSessionReader>();
	reads = 0;

	openPinnedReaderSync(filePath: string): PinnedSessionReader | undefined {
		const inner = super.openPinnedReaderSync(filePath);
		if (inner === undefined) return undefined;
		const open = this.open;
		const reader: PinnedSessionReader = {
			identity: inner.identity,
			read: (offset, length) => {
				this.reads += 1;
				return inner.read(offset, length);
			},
			close: () => {
				open.delete(reader);
				inner.close();
			},
		};
		open.add(reader);
		return reader;
	}

	openIdentities(): string[] {
		return [...this.open].map(reader => reader.identity);
	}
}

/** A store that pins no reader, so a manager over it holds every entry in memory. */
class UnpinnedStorage extends FileSessionStorage {
	openPinnedReaderSync(): PinnedSessionReader | undefined {
		return undefined;
	}
}

const pins = process.platform !== "win32";

function big(tag: string, length = 1500): string {
	let text = `${tag}:`;
	for (let i = 0; text.length < length; i++) text += ` ${tag}-${i}`;
	return text;
}

/** A PNG-shaped base64 payload above the externalization threshold, distinct per `seed`. */
function base64(seed: string, bytes = 3072): string {
	const buffer = Buffer.alloc(bytes);
	for (let i = 0; i < bytes; i++) buffer[i] = (i * 31 + seed.charCodeAt(i % seed.length)) & 0xff;
	return buffer.toString("base64");
}

function assistantTurn(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

/**
 * Each record-only kind appended through the method a running session calls. A kind added to
 * `RECORD_ONLY_ENTRY_TYPES` without a row fails the append sweep.
 */
const APPEND_RECORD_ONLY: Record<string, (manager: SessionManager) => void> = {
	session_init: manager =>
		manager.appendSessionInit({
			systemPrompt: big("appended-system-prompt", 64 * 1024),
			task: big("appended-task"),
			tools: ["read", "yield"],
		}),
	settings_snapshot: manager => manager.appendSettingsSnapshot({ "probe.value": big("appended-setting") }),
	subagent_spawn: manager =>
		manager.appendAgentSpawn({
			agentId: "agent-1",
			agentName: "task",
			task: big("appended-spawn-task"),
			sessionFile: "/repo/.sessions/agent-1.jsonl",
			isolation: "none",
			status: "completed",
			exitCode: 0,
			durationMs: 10,
		}),
};

/** A manager on a transcript path that did not exist, opened the way a spawned agent opens its own. */
async function openChildTranscript(storage: FileSessionStorage): Promise<{
	manager: SessionManager;
	dir: string;
	file: string;
}> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-cold-append-"));
	tempDirs.push(root);
	const dir = path.join(root, "sessions");
	fs.mkdirSync(dir);
	fs.mkdirSync(path.join(root, "blobs"));
	const file = path.join(dir, "child.jsonl");
	const manager = await SessionManager.open(file, dir, storage, { initialCwd: root, suppressBreadcrumb: true });
	// The open writes the file, so everything the agent records next is appended to it.
	expect(fs.existsSync(file)).toBe(true);
	return { manager, dir, file };
}

type EntryOf<K extends SessionEntry["type"]> = Extract<SessionEntry, { type: K }>;
type Fixture = { [K in SessionEntry["type"]]: (base: SessionEntryBase) => EntryOf<K> };

/**
 * One entry of every kind the union declares, each with payloads large enough to be moved out of
 * memory where its shape allows one. Typed against the union: a new entry kind is a missing key.
 */
const EVERY_ENTRY_KIND = {
	message: base => ({
		...base,
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "call-probe",
			toolName: PROBE_TOOL,
			content: [
				{ type: "text", text: big("probe-result") },
				{ type: "image", data: base64("result-image"), mimeType: "image/png" },
			],
			details: { echo: big("probe-result"), summary: big("probe-summary") },
			isError: false,
			timestamp: 3,
		},
	}),
	thinking_level_change: base => ({
		...base,
		type: "thinking_level_change",
		thinkingLevel: "high",
		configured: "auto",
	}),
	model_change: base => ({ ...base, type: "model_change", model: "anthropic/claude-sonnet-4-5", role: "default" }),
	service_tier_change: base => ({ ...base, type: "service_tier_change", serviceTier: null }),
	compaction: base => ({
		...base,
		type: "compaction",
		summary: big("older-compaction"),
		firstKeptEntryId: base.parentId ?? base.id,
		tokensBefore: 10,
		details: { files: [big("older-compaction-file")] },
	}),
	branch_summary: base => ({
		...base,
		type: "branch_summary",
		fromId: base.parentId ?? base.id,
		summary: big("branch-summary"),
		details: { note: big("branch-details") },
	}),
	custom: base => ({
		...base,
		type: "custom",
		customType: "probe",
		data: { note: big("custom-note"), image_url: `data:image/png;base64,${base64("custom-url")}` },
	}),
	custom_message: base => ({
		...base,
		type: "custom_message",
		customType: "probe",
		content: big("custom-message"),
		details: { note: big("custom-message-details") },
		display: true,
	}),
	label: base => ({ ...base, type: "label", targetId: base.parentId ?? base.id, label: "pinned" }),
	title_change: base => ({ ...base, type: "title_change", title: "cold read-back", source: "user" }),
	ttsr_injection: base => ({
		...base,
		type: "ttsr_injection",
		injectedRules: [big("rule-a", 600), big("rule-b", 600)],
	}),
	mcp_tool_selection: base => ({
		...base,
		type: "mcp_tool_selection",
		selectedToolNames: [big("tool-a", 600), big("tool-b", 600)],
	}),
	session_init: base => ({
		...base,
		type: "session_init",
		systemPrompt: big("system-prompt"),
		task: big("task"),
		tools: ["read"],
	}),
	mode_change: base => ({ ...base, type: "mode_change", mode: "plan", data: { planFile: big("plan-file") } }),
	subagent_spawn: base => ({
		...base,
		type: "subagent_spawn",
		agentId: "agent-1",
		agentName: "task",
		task: big("spawn-task"),
		sessionFile: "/repo/.sessions/agent-1.jsonl",
		isolation: "none",
		status: "completed",
		exitCode: 0,
		durationMs: 10,
	}),
	settings_snapshot: base => ({
		...base,
		type: "settings_snapshot",
		kind: "full",
		values: { "probe.value": big("setting") },
	}),
	session_lifecycle: base => ({ ...base, type: "session_lifecycle", state: "running", reason: "created" }),
	session_checkpoint: base => ({ ...base, type: "session_checkpoint", prefixSequence: 0 }),
} satisfies Fixture;

type MessageOf<R extends AgentMessage["role"]> = Extract<AgentMessage, { role: R }>;

/**
 * One message of every role the union declares, each with a payload large enough to be moved out
 * of memory. Typed against the union: a new role is a missing key.
 */
const EVERY_MESSAGE_ROLE = {
	user: () => ({ role: "user", content: [{ type: "text", text: big("role-user") }], timestamp: 1 }),
	developer: () => ({ role: "developer", content: [{ type: "text", text: big("role-developer") }], timestamp: 1 }),
	assistant: () => ({
		...assistantTurn(big("role-assistant"), 1),
		content: [
			{ type: "text", text: big("role-assistant") },
			{ type: "toolCall", id: "call-role", name: "bash", arguments: { command: "ls" } },
		],
		stopReason: "toolUse",
	}),
	toolResult: () => ({
		role: "toolResult",
		toolCallId: "call-role",
		toolName: "bash",
		content: [{ type: "text", text: big("role-tool-result") }],
		details: { note: big("role-tool-details") },
		isError: false,
		timestamp: 1,
	}),
	custom: () => ({
		role: "custom",
		customType: "probe",
		content: big("role-custom"),
		display: true,
		details: { note: big("role-custom-details") },
		timestamp: 1,
	}),
	hookMessage: () => ({
		role: "hookMessage",
		customType: "probe",
		content: big("role-hook"),
		display: true,
		timestamp: 1,
	}),
	branchSummary: () => ({
		role: "branchSummary",
		summary: big("role-branch-summary"),
		fromId: "m00001",
		timestamp: 1,
	}),
	compactionSummary: () => ({
		role: "compactionSummary",
		summary: big("role-compaction-summary"),
		tokensBefore: 1,
		timestamp: 1,
	}),
	fileMention: () => ({
		role: "fileMention",
		files: [{ path: "src/app.ts", content: big("role-file-mention") }],
		timestamp: 1,
	}),
	bashExecution: () => ({
		role: "bashExecution",
		command: "ls",
		output: big("role-bash-output"),
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 1,
	}),
	pythonExecution: () => ({
		role: "pythonExecution",
		code: "print(1)",
		output: big("role-python-output"),
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 1,
	}),
} satisfies { [R in AgentMessage["role"]]: () => MessageOf<R> };

/** One message entry of every role, chained in table order. */
function everyRoleHistory(): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let parent: string | null = null;
	for (const [index, make] of Object.values(EVERY_MESSAGE_ROLE).entries()) {
		const id = `m${String(index + 1).padStart(5, "0")}`;
		entries.push({
			type: "message",
			id,
			parentId: parent,
			timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString(),
			message: make(),
		});
		parent = id;
	}
	return entries;
}

/** The text persistence externalizes: one line past its 500,000-character cap. */
const OVERSIZED_TEXT = big("oversized", 520_000);

/** One padding result's text: below the cap, so persistence writes it inline. */
const PADDING_CHARS = 450_000;

interface LoadPath {
	load: "whole" | "streamed";
	/** Text of compacted tool output {@link writeSession} puts ahead of the history. */
	padding: number;
}

/**
 * The two ways a resume reads a session file: as one string, and as a stream of reads that moves
 * compacted history out of memory as each compaction is read. The streamed arm's padding puts the
 * file past the stream threshold.
 */
const LOAD_PATHS: LoadPath[] = [
	{ load: "whole", padding: 0 },
	{ load: "streamed", padding: STREAM_LOAD_THRESHOLD_BYTES },
];

/** Fails unless a load of `file` reads it the way `arm` names. */
function expectLoadPath(file: string, arm: LoadPath): void {
	expect([arm.load, fs.statSync(file).size >= STREAM_LOAD_THRESHOLD_BYTES]).toEqual([
		arm.load,
		arm.load === "streamed",
	]);
}

/** Compacted tool results ahead of a history, `paddingBytes` of text in all, chained from `base`. */
function paddingResults(paddingBytes: number, base: (parentId: string | null) => SessionEntryBase): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let i = 0; i * PADDING_CHARS < paddingBytes; i++) {
		entries.push({
			...base(entries.at(-1)?.id ?? null),
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: `padding-${i}`,
				toolName: "bash",
				content: [{ type: "text", text: big(`padding-${i}`, PADDING_CHARS) }],
				isError: false,
				timestamp: 0,
			},
		});
	}
	return entries;
}

interface SessionFixture {
	dir: string;
	file: string;
	/** The earliest entry the live context reads. */
	keptId: string;
	/** Summary of the newest compaction, which every context build sends. */
	summary: string;
	/** Ids of entries before the keep boundary, in file order. */
	compacted: string[];
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Bases with ids `<prefix>00001`, `<prefix>00002`, … one second apart, each under the parent it is given. */
function entryBases(prefix: string): (parentId: string | null) => SessionEntryBase {
	let n = 0;
	return parentId => ({
		type: "",
		id: `${prefix}${String(++n).padStart(5, "0")}`,
		parentId,
		timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, n)).toISOString(),
	});
}

/**
 * Write `lines` under a session header named `id`, and publish the file through a manager, so
 * persistence writes it the way a live session does: title slot, externalized blobs, codec-slimmed
 * details.
 */
async function publishLines(id: string, lines: readonly SessionEntry[]): Promise<Pick<SessionFixture, "dir" | "file">> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `veyyon-${id}-`));
	tempDirs.push(root);
	const dir = path.join(root, "sessions");
	fs.mkdirSync(dir);
	fs.mkdirSync(path.join(root, "blobs"));
	const file = path.join(dir, "session.jsonl");
	const header = { type: "session", version: 3, id, timestamp: "2025-01-01T00:00:00.000Z", cwd: root };
	fs.writeFileSync(file, `${[header, ...lines].map(line => JSON.stringify(line)).join("\n")}\n`);
	const seed = await SessionManager.open(file, dir, new FileSessionStorage(), { suppressBreadcrumb: true });
	await seed.rewriteEntries();
	await seed.close();
	return { dir, file };
}

/** The entries whose serialization read the file, in file order, each checked against `expected`. */
function readBackEntries(
	manager: SessionManager,
	storage: ObservedStorage,
	expected: Map<string, string>,
): SessionEntry[] {
	const readBack: SessionEntry[] = [];
	for (const entry of manager.getEntries()) {
		const before = storage.reads;
		expect(JSON.stringify(entry)).toBe(expected.get(entry.id)!);
		if (storage.reads > before) readBack.push(entry);
	}
	return readBack;
}

/**
 * Write `paddingBytes` of compacted tool output, `history` after it, then a kept tail and a
 * compaction over both, and publish the file through {@link publishLines}.
 */
async function writeSession(history: SessionEntry[], paddingBytes = 0): Promise<SessionFixture> {
	let counter = 0;
	const base = (parentId: string | null): SessionEntryBase => ({
		type: "",
		id: `e${String(++counter).padStart(5, "0")}`,
		parentId,
		timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, counter)).toISOString(),
	});
	const lines: SessionEntry[] = paddingResults(paddingBytes, base);
	const push = (entry: SessionEntry): string => {
		lines.push(entry);
		return entry.id;
	};

	const padded = lines.at(-1)?.id ?? null;
	let parent: string | null = padded;
	const compacted: string[] = [];
	for (const entry of history) {
		// History entries name their own parents; the chain continues from the last one, and a
		// history root hangs off the padding.
		lines.push(entry.parentId === null ? { ...entry, parentId: padded } : entry);
		compacted.push(entry.id);
		parent = entry.id;
	}
	// Large enough to move, so a load that moves the entry a compaction keeps reads it back for the context.
	const keptId = push({
		...base(parent),
		type: "message",
		message: { role: "user", content: big("kept prompt"), timestamp: 10 },
	});
	parent = push({ ...base(keptId), type: "message", message: assistantTurn("kept answer", 11) });
	const summary = big("newest-compaction");
	parent = push({ ...base(parent), type: "compaction", summary, firstKeptEntryId: keptId, tokensBefore: 100 });
	parent = push({
		...base(parent),
		type: "message",
		message: { role: "user", content: "after compaction", timestamp: 12 },
	});
	push({ ...base(parent), type: "message", message: assistantTurn("tail answer", 13) });

	return { ...(await publishLines("cold-readback", lines)), keptId, summary, compacted };
}

/** Every entry of the file as a fresh load restores it, keyed by id. */
async function freshLoad(fixture: Pick<SessionFixture, "dir" | "file">): Promise<Map<string, string>> {
	const loaded = await loadSessionFile(fixture.file);
	await resolveBlobRefsInEntries(loaded.entries, new BlobStore(blobsDirForSessionDir(fixture.dir)));
	const byId = new Map<string, string>();
	for (const entry of loaded.entries) {
		if (entry.type !== "session") byId.set(entry.id, JSON.stringify(entry));
	}
	return byId;
}

function serialized(manager: SessionManager): Map<string, string> {
	return new Map(manager.getEntries().map(entry => [entry.id, JSON.stringify(entry)]));
}

/** A manager over a copy of the fixture's session directory, holding every entry in memory. */
async function openInMemoryCopy(fixture: Pick<SessionFixture, "dir" | "file">): Promise<SessionManager> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-cold-warm-"));
	tempDirs.push(root);
	fs.cpSync(path.dirname(fixture.dir), root, { recursive: true });
	const dir = path.join(root, path.basename(fixture.dir));
	return SessionManager.open(path.join(dir, path.basename(fixture.file)), dir, new UnpinnedStorage(), {
		suppressBreadcrumb: true,
	});
}

/**
 * One chain holding every entry kind, a side branch off its first entry unless `sideBranch` is
 * false, and the oversized text.
 */
function everyKindHistory(sideBranch = true): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let parent: string | null = null;
	const next = entryBases("h");
	const first = next(null);
	entries.push({ ...first, type: "message", message: { role: "user", content: big("first-prompt"), timestamp: 1 } });
	parent = first.id;
	for (const make of Object.values(EVERY_ENTRY_KIND) as ((base: SessionEntryBase) => SessionEntry)[]) {
		const entry = make(next(parent));
		entries.push(entry);
		parent = entry.id;
	}
	// A branch the active path does not walk.
	if (sideBranch) {
		entries.push({
			...next(first.id),
			type: "message",
			message: { role: "user", content: big("side-branch"), timestamp: 2 },
		});
	}
	const oversized = next(parent);
	entries.push({ ...oversized, type: "message", message: { role: "user", content: OVERSIZED_TEXT, timestamp: 4 } });
	return entries;
}

/** {@link everyRoleHistory} after a root prompt, so navigating back to that prompt leaves every role. */
function everyRoleHistoryAfterAnchor(): SessionEntry[] {
	const roles = everyRoleHistory();
	const anchor: SessionEntry = {
		type: "message",
		id: "m00000",
		parentId: null,
		timestamp: new Date(Date.UTC(2023, 11, 31)).toISOString(),
		message: { role: "user", content: "anchor", timestamp: 0 },
	};
	roles[0] = { ...roles[0]!, parentId: anchor.id };
	return [anchor, ...roles];
}

let authFiles = 0;

/**
 * Navigate from the leaf of `manager`'s session back to `targetId` with a branch summary, through
 * the session `/tree` drives, and return the prompt the summary request sent. Only the provider
 * stream is replaced. `onCredential` runs each time the credential store is asked for the key, the
 * await a summary attempt starts from. Disposing the session closes `manager`.
 */
async function summarizeBranch(
	manager: SessionManager,
	root: string,
	targetId: string,
	onCredential: () => void,
): Promise<string> {
	const authStorage = await AuthStorage.create(path.join(root, `auth-${++authFiles}.db`));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const resolveKey = authStorage.getApiKey.bind(authStorage);
	vi.spyOn(authStorage, "getApiKey").mockImplementation(async (provider, sessionId, options) => {
		onCredential();
		return resolveKey(provider, sessionId, options);
	});
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
	const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		}),
		sessionManager: manager,
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage),
	});
	let prompt: string | undefined;
	vi.spyOn(ai, "streamSimple").mockImplementation((_model, context) => {
		prompt = JSON.stringify(context.messages.map(message => message.content));
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "done", reason: "stop", message: assistantTurn("branch summary", 20) });
			stream.end();
		});
		return stream;
	});
	try {
		const result = await session.navigateTree(targetId, { summarize: true });
		expect(result.cancelled).toBe(false);
		expect(result.summaryEntry?.type).toBe("branch_summary");
	} finally {
		vi.restoreAllMocks();
		await session.dispose();
		authStorage.close();
	}
	if (prompt === undefined) throw new Error("The branch summary sent no request");
	return prompt;
}

/**
 * An `AgentSession` resumed on `manager`, its agent holding the context the manager builds and
 * answering every request with `reply`. `close` disposes the session, which closes `manager`.
 */
async function resumeSession(
	manager: SessionManager,
	root: string,
	reply: AssistantMessage,
): Promise<{ session: AgentSession; close: () => Promise<void> }> {
	const authStorage = await AuthStorage.create(path.join(root, `auth-${++authFiles}.db`));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: { ...bundled, contextWindow: 200_000, maxTokens: 64_000 },
				systemPrompt: ["Test"],
				tools: [],
				messages: manager.buildSessionContext().messages,
			},
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: { ...reply, timestamp: Date.now() } });
					stream.end();
				});
				return stream;
			},
		}),
		sessionManager: manager,
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage),
	});
	return {
		session,
		close: async () => {
			await session.dispose();
			authStorage.close();
		},
	};
}

/** {@link everyRoleHistory} and a `task` result whose details hold the usage of the agents it ran. */
function spendHistory(): SessionEntry[] {
	const entries = everyRoleHistory();
	entries.push({
		type: "message",
		id: "m00099",
		parentId: entries.at(-1)!.id,
		timestamp: new Date(Date.UTC(2024, 0, 2)).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: "call-task",
			toolName: "task",
			content: [{ type: "text", text: big("task-output") }],
			details: {
				note: big("task-details"),
				usage: {
					input: 7,
					output: 3,
					cacheRead: 0,
					cacheWrite: 2,
					totalTokens: 12,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
				},
			},
			isError: false,
			timestamp: 1,
		},
	});
	return entries;
}

/** A reply whose usage a goal is charged `input + output + cacheWrite` = 345 tokens of. */
const RESUMED_REPLY: AssistantMessage = {
	...assistantTurn("resumed answer", 30),
	usage: {
		input: 300,
		output: 40,
		cacheRead: 9,
		cacheWrite: 5,
		totalTokens: 354,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
	},
};

/** The spend of a session's stats, without what names the session or measures its live context. */
function spendOf({ sessionFile: _file, sessionId: _id, contextUsage: _context, ...spend }: SessionStats): SessionSpend {
	return spend;
}

/**
 * The live branch as a session that branched holds it, and as one that never branched does: the
 * whole file in file order, which the manager walks by index instead of by a set of the live entries.
 */
const HISTORY_SHAPES = [
	{ shape: "a side branch", sideBranch: true },
	{ shape: "no branch", sideBranch: false },
];

describe.skipIf(!pins)("compacted history reads back from the session file", () => {
	it.each(LOAD_PATHS.flatMap(arm => HISTORY_SHAPES.map(shape => ({ ...arm, ...shape }))))(
		"reads back every entry kind as a fresh load of the file, and never reads the disk for the live context ($load, $shape)",
		async arm => {
			const fixture = await writeSession(everyKindHistory(arm.sideBranch), arm.padding);
			expectLoadPath(fixture.file, arm);
			// Persistence moved every payload kind out of the line, so each restore path is exercised.
			const text = fs.readFileSync(fixture.file, "utf8");
			expect(text).not.toContain(OVERSIZED_TEXT.slice(0, 4096));
			expect(text).not.toContain(base64("result-image").slice(0, 512));
			expect(text).not.toContain(base64("custom-url").slice(0, 512));
			expect(text).not.toContain('"echo"');

			const expected = await freshLoad(fixture);
			const storage = new ObservedStorage();
			const manager = await SessionManager.open(fixture.file, fixture.dir, storage, { suppressBreadcrumb: true });

			expect(storage.openIdentities()).toEqual([storage.statSync(fixture.file).identity!]);
			const context = manager.buildSessionContext();
			const contextText = JSON.stringify(context.messages);
			expect(contextText).toContain(fixture.summary);
			expect(contextText).toContain("kept prompt");
			expect(contextText).toContain("tail answer");
			expect(contextText).not.toContain("first-prompt");
			// Every settings-bearing entry sits in the compacted history and still reaches the context.
			expect(context.thinkingLevel).toBe("high");
			expect(context.configuredThinkingLevel).toBe("auto");
			expect(context.models).toEqual({ default: "anthropic/claude-sonnet-4-5" });
			expect(context.injectedTtsrRules).toEqual([big("rule-a", 600), big("rule-b", 600)]);
			expect(context.selectedMCPToolNames).toEqual([big("tool-a", 600), big("tool-b", 600)]);
			expect(context.hasPersistedMCPToolSelection).toBe(true);
			expect(context.mode).toBe("plan");
			expect(context.modeData).toEqual({ planFile: big("plan-file") });
			expect(storage.reads).toBe(0);

			expect(serialized(manager)).toEqual(expected);
			expect(storage.reads).toBeGreaterThan(0);
			// The last cold entry read back releases the handle.
			expect(storage.open.size).toBe(0);
			await manager.close();
		},
	);

	it.each(LOAD_PATHS)(
		"keeps an in-place update of a cold entry across a tail republish, and moves the rest onto the new file ($load)",
		async arm => {
			const fixture = await writeSession(everyKindHistory(), arm.padding);
			expectLoadPath(fixture.file, arm);
			const storage = new ObservedStorage();
			const manager = await SessionManager.open(fixture.file, fixture.dir, storage, { suppressBreadcrumb: true });
			const original = storage.statSync(fixture.file).identity!;

			const entries = manager.getEntries();
			const custom = entries.find(entry => entry.type === "custom");
			const summary = entries.find(entry => entry.type === "branch_summary");
			if (custom?.type !== "custom" || summary?.type !== "branch_summary") {
				throw new Error("fixture lost its custom entry or branch summary");
			}
			expect(storage.reads).toBe(0);

			// Two write paths: a nested mutation through the getter, and an assignment through the setter
			// to an entry nothing has read.
			(custom.data as Record<string, unknown>).note = "edited in place";
			summary.summary = "replaced summary";
			await manager.rewriteEntries([custom, summary]);

			const republished = storage.statSync(fixture.file).identity!;
			expect(republished).not.toBe(original);
			// The replaced object is released: every cold entry now reads from the new one.
			expect(storage.openIdentities()).toEqual([republished]);

			const expected = await freshLoad(fixture);
			expect(JSON.parse(expected.get(custom.id)!).data.note).toBe("edited in place");
			expect(JSON.parse(expected.get(summary.id)!).summary).toBe("replaced summary");
			expect(serialized(manager)).toEqual(expected);
			expect(storage.open.size).toBe(0);
			await manager.close();
		},
	);

	it("moves the history a live compaction summarized out of memory once the compaction is recorded", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-cold-live-"));
		tempDirs.push(root);
		const dir = path.join(root, "sessions");
		fs.mkdirSync(dir);
		fs.mkdirSync(path.join(root, "blobs"));
		const storage = new ObservedStorage();
		const manager = SessionManager.create(root, dir, storage);

		let keptId = "";
		for (let turn = 0; turn < 40; turn++) {
			const id = manager.appendMessage({ role: "user", content: big(`live-prompt-${turn}`, 4096), timestamp: turn });
			if (turn === 35) keptId = id;
			manager.appendMessage(assistantTurn(`live-answer-${turn}`, turn));
		}
		const summary = big("live-summary");
		manager.appendCompaction(summary, undefined, keptId, 1000);
		expect(storage.open.size).toBe(0);

		manager.coolCompactedHistory();
		expect(storage.open.size).toBe(1);
		const context = JSON.stringify(manager.buildSessionContext().messages);
		expect(context).toContain(summary);
		expect(context).toContain("live-prompt-35:");
		expect(context).not.toContain("live-prompt-34:");
		expect(storage.reads).toBe(0);

		await manager.flush();
		const file = manager.getSessionFile();
		if (file === undefined) throw new Error("the session wrote no file");
		expect(serialized(manager)).toEqual(await freshLoad({ dir, file }));
		expect(storage.reads).toBe(35);
		expect(storage.open.size).toBe(0);
		await manager.close();
	});

	it.each(LOAD_PATHS)(
		"reads the bytes it resumed from after another writer republishes the path ($load)",
		async arm => {
			const fixture = await writeSession(everyKindHistory(), arm.padding);
			expectLoadPath(fixture.file, arm);
			const expected = await freshLoad(fixture);
			const storage = new ObservedStorage();
			const manager = await SessionManager.open(fixture.file, fixture.dir, storage, { suppressBreadcrumb: true });

			// Another process replaces the file with one whose bytes sit at different offsets.
			const replacement = `${fixture.file}.other`;
			fs.writeFileSync(replacement, `${"\n".repeat(4096)}${fs.readFileSync(fixture.file, "utf8")}`);
			fs.renameSync(replacement, fixture.file);

			for (const [id, line] of expected) {
				const entry = manager.getEntry(id);
				expect(entry && JSON.stringify(entry)).toBe(line);
			}
			expect(storage.open.size).toBe(0);
		},
	);

	it.each(LOAD_PATHS)(
		"builds the context of a resumed branch that leaves the newest compaction behind ($load)",
		async arm => {
			const fixture = await writeSession(everyRoleHistory(), arm.padding);
			expectLoadPath(fixture.file, arm);
			// A turn off an entry the newest compaction summarized, as a navigation back before it writes
			// one, is the last line of the file: the branch the session resumes on.
			fs.appendFileSync(
				fixture.file,
				`${JSON.stringify({
					type: "message",
					id: "fork-1",
					parentId: fixture.compacted[3],
					timestamp: "2025-02-01T00:00:00.000Z",
					message: { role: "user", content: "forked prompt", timestamp: 20 },
				})}\n`,
			);
			const warm = await openInMemoryCopy(fixture);
			const expected = JSON.stringify(warm.buildSessionContext().messages);
			expect(expected).toContain("forked prompt");
			expect(expected).toContain("role-user:");
			expect(expected).not.toContain(fixture.summary);

			const storage = new ObservedStorage();
			const manager = await SessionManager.open(fixture.file, fixture.dir, storage, { suppressBreadcrumb: true });
			expect(JSON.stringify(manager.buildSessionContext().messages)).toBe(expected);
			expect(manager.getUsageStatistics()).toEqual(warm.getUsageStatistics());
			expect(serialized(manager)).toEqual(serialized(warm));
			expect(storage.open.size).toBe(0);
			await manager.close();
			await warm.close();
		},
	);

	it.each(LOAD_PATHS)("loads a file an older version wrote into memory before it migrates it ($load)", async arm => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-cold-migrate-"));
		tempDirs.push(root);
		const dir = path.join(root, "sessions");
		fs.mkdirSync(dir);
		fs.mkdirSync(path.join(root, "blobs"));
		const file = path.join(dir, "session.jsonl");
		let n = 0;
		const next = (parentId: string | null): SessionEntryBase => ({
			type: "",
			id: `v${String(++n).padStart(5, "0")}`,
			parentId,
			timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, n)).toISOString(),
		});
		const lines = paddingResults(arm.padding, next);
		const hook: SessionEntry = {
			...next(lines.at(-1)?.id ?? null),
			type: "message",
			message: { ...EVERY_MESSAGE_ROLE.hookMessage() },
		};
		const kept: SessionEntry = { ...next(hook.id), type: "message", message: assistantTurn("kept answer", 2) };
		const compaction: SessionEntry = {
			...next(kept.id),
			type: "compaction",
			summary: big("v2-compaction"),
			firstKeptEntryId: kept.id,
			tokensBefore: 10,
		};
		lines.push(hook, kept, compaction);
		const header = {
			type: "session",
			version: 2,
			id: "cold-migrate",
			timestamp: "2024-01-01T00:00:00.000Z",
			cwd: root,
		};
		fs.writeFileSync(file, `${[header, ...lines].map(line => JSON.stringify(line)).join("\n")}\n`);
		expectLoadPath(file, arm);

		// A moved entry reads its line back as the older version wrote it, so the load moves nothing.
		const loaded = await loadSessionFile(file, new ObservedStorage(), { coolCompactedHistory: true });
		expect(loaded.cold).toBeUndefined();

		const warm = await openInMemoryCopy({ dir, file });
		const storage = new ObservedStorage();
		const manager = await SessionManager.open(file, dir, storage, { suppressBreadcrumb: true });
		const migrated = manager.getEntry(hook.id);
		expect(migrated?.type === "message" && migrated.message.role).toBe("custom");
		expect(serialized(manager)).toEqual(serialized(warm));
		expect(manager.getUsageStatistics()).toEqual(warm.getUsageStatistics());
		expect(storage.open.size).toBe(0);
		await manager.close();
		await warm.close();
	});

	it(
		"releases the pinned descriptor when a manager holding cold entries is dropped",
		async () => {
			if (process.platform !== "linux") return;
			const fixture = await writeSession(everyKindHistory());
			const { env, cleanup } = hermeticSpawnEnv();
			let dropped: DroppedDescriptors;
			try {
				const { stdout, stderr } = await run(process.execPath, [DROPPED_FIXTURE, fixture.file, fixture.dir], {
					env,
					timeout: SUBPROCESS_TIMEOUT_MS - 5_000,
					killSignal: "SIGKILL",
				});
				expect(stderr).toBe("");
				dropped = JSON.parse(stdout) as DroppedDescriptors;
			} finally {
				cleanup();
			}
			expect(dropped.entries).toBeGreaterThan(fixture.compacted.length);
			expect(dropped.whileOpen).toBe(1);
			expect(dropped.afterDrop).toBe(0);
		},
		SUBPROCESS_TIMEOUT_MS,
	);

	it(
		"holds a compacted history's payloads out of the heap while the file streams in, and until they are read",
		async () => {
			const RESULTS = 160;
			const RESULT_CHARS = 128 * 1024;
			const COMPACT_EVERY = 8;
			const payloadBytes = RESULTS * RESULT_CHARS;
			const history: SessionEntry[] = [];
			let parent: string | null = null;
			for (let i = 0; i < RESULTS; i++) {
				const id = `r${String(i).padStart(5, "0")}`;
				const timestamp = new Date(Date.UTC(2024, 0, 1, 0, 0, i)).toISOString();
				history.push({
					type: "message",
					id,
					parentId: parent,
					timestamp,
					message: {
						role: "toolResult",
						toolCallId: `call-${i}`,
						toolName: "bash",
						content: [{ type: "text", text: big(`result-${i}`, RESULT_CHARS) }],
						isError: false,
						timestamp: i,
					},
				});
				parent = id;
				// A long session compacts every few turns, each compaction keeping the result before it.
				if (i % COMPACT_EVERY === COMPACT_EVERY - 1) {
					const compactionId = `c${String(i).padStart(5, "0")}`;
					history.push({
						type: "compaction",
						id: compactionId,
						parentId: parent,
						timestamp,
						summary: big(`compaction-${i}`),
						firstKeptEntryId: id,
						tokensBefore: 100,
					});
					parent = compactionId;
				}
			}
			const fixture = await writeSession(history);
			history.length = 0;
			expect(fs.statSync(fixture.file).size).toBeGreaterThanOrEqual(STREAM_LOAD_THRESHOLD_BYTES);

			const { env, cleanup } = hermeticSpawnEnv();
			let heap: ColdHistoryHeap;
			try {
				const { stdout, stderr } = await run(process.execPath, [COLD_HEAP_FIXTURE, fixture.file, fixture.dir], {
					env,
					timeout: SUBPROCESS_TIMEOUT_MS - 5_000,
					killSignal: "SIGKILL",
				});
				expect(stderr).toBe("");
				heap = JSON.parse(stdout) as ColdHistoryHeap;
			} finally {
				cleanup();
			}
			// No `model_change` on this branch: the settings walk names the default model from the newest
			// assistant turn, which the live tail holds.
			expect(heap.context).toContain(fixture.summary);
			expect(heap.readsAfterContext).toBe(0);
			// Reading the payloads back brings them into the heap, which proves the measurement sees them.
			// A role is a small field and stays in memory; the walk reads each result's content back.
			expect(heap.results).toBe(RESULTS);
			expect(heap.cold).toBeLessThan(payloadBytes / 4);
			expect(heap.warm).toBeGreaterThan(payloadBytes);
			// The open yields a turn of the event loop after each read of the file, so the samples span
			// the load. It holds the results read since the last compaction, not the history before it.
			expect(heap.loadSamples).toBeGreaterThanOrEqual(10);
			expect(heap.loadPeak).toBeLessThan(payloadBytes / 2);
		},
		SUBPROCESS_TIMEOUT_MS,
	);

	it.each(LOAD_PATHS)(
		"picks compacted message entries by their small fields without reading the session file back ($load)",
		async arm => {
			const fixture = await writeSession(everyRoleHistory(), arm.padding);
			expectLoadPath(fixture.file, arm);
			const expected = await freshLoad(fixture);
			const storage = new ObservedStorage();
			const manager = await SessionManager.open(fixture.file, fixture.dir, storage, { suppressBreadcrumb: true });
			const compacted = fixture.compacted.map(id => {
				const entry = manager.getEntry(id);
				if (entry?.type !== "message") throw new Error(`fixture lost message entry ${id}`);
				return entry;
			});

			// Every small field a fresh load holds, read off every role.
			const roles: string[] = [];
			for (const entry of compacted) {
				const loaded = (JSON.parse(expected.get(entry.id)!) as { message: Record<string, unknown> }).message;
				const message = entry.message as unknown as Record<string, unknown>;
				for (const [key, value] of Object.entries(loaded)) {
					if (typeof value === "object" && value !== null) continue;
					if (typeof value === "string" && value.length >= MIN_COLD_STRING_LENGTH) continue;
					expect([entry.message.role, key, message[key]]).toEqual([entry.message.role, key, value]);
				}
				roles.push(entry.message.role);
			}
			expect(roles.sort()).toEqual(Object.keys(EVERY_MESSAGE_ROLE).sort());

			// The scans a resume runs over the whole branch.
			const branch = manager.getBranch();
			expect(collectPendingToolCalls(branch)).toEqual([]);
			expect(branch.filter(isSuccessfulCheckpointEntry)).toEqual([]);
			expect(getLatestTodoPhasesSnapshotFromEntries(manager.getEntries())).toEqual({ found: false, phases: [] });
			expect(storage.reads).toBe(0);
			// The totals count every compacted assistant turn, without reading one back.
			const warm = await openInMemoryCopy(fixture);
			expect(manager.getUsageStatistics()).toEqual(warm.getUsageStatistics());
			await warm.close();
			expect(storage.reads).toBe(0);

			// A large field reads its entry's line back once, into the message object the entry already held.
			for (const entry of compacted) {
				const message = entry.message;
				const before = storage.reads;
				JSON.stringify(message);
				expect([entry.message.role, storage.reads - before]).toEqual([entry.message.role, 1]);
				expect(entry.message).toBe(message);
			}
			expect(serialized(manager)).toEqual(expected);
			expect(storage.open.size).toBe(0);
			await manager.close();
		},
	);

	it.each(LOAD_PATHS)(
		"runs a turn on a resumed session without reading the summarized history back ($load)",
		async arm => {
			const fixture = await writeSession(spendHistory(), arm.padding);
			expectLoadPath(fixture.file, arm);
			const storage = new ObservedStorage();
			const manager = await SessionManager.open(fixture.file, fixture.dir, storage, { suppressBreadcrumb: true });
			const compacted = fixture.compacted.map(id => manager.getEntry(id)!);
			const inMemory = () => compacted.filter(entry => coldFieldsOf(entry) === undefined).map(entry => entry.id);
			expect(inMemory()).toEqual([]);

			const { session, close } = await resumeSession(manager, path.dirname(fixture.dir), RESUMED_REPLY);
			try {
				await session.prompt("after the resume");
				await session.agent.waitForIdle();
				const leaf = manager.getLeafEntry();
				expect(leaf?.type === "message" && leaf.message.role === "assistant" && leaf.message.content).toEqual(
					RESUMED_REPLY.content,
				);
				expect(storage.reads).toBe(0);
				expect(inMemory()).toEqual([]);
			} finally {
				await close();
			}
		},
	);

	it.each(LOAD_PATHS)(
		"charges a goal the spend of the summarized history and leaves that history on disk ($load)",
		async arm => {
			const fixture = await writeSession(spendHistory(), arm.padding);
			expectLoadPath(fixture.file, arm);
			const root = path.dirname(fixture.dir);
			const storage = new ObservedStorage();
			const manager = await SessionManager.open(fixture.file, fixture.dir, storage, { suppressBreadcrumb: true });
			const compacted = fixture.compacted.map(id => manager.getEntry(id)!);
			const inMemory = () => compacted.filter(entry => coldFieldsOf(entry) === undefined).map(entry => entry.id);
			// The summarized entries whose spend sits in their large fields.
			const spending = compacted.filter(
				entry =>
					entry.type === "message" &&
					(entry.message.role === "assistant" ||
						(entry.message.role === "toolResult" && entry.message.toolName === "task")),
			);
			expect(spending.map(entry => entry.id)).toEqual(["m00003", "m00099"]);

			const reference = await resumeSession(await openInMemoryCopy(fixture), root, RESUMED_REPLY);
			const cold = await resumeSession(manager, root, RESUMED_REPLY);
			try {
				const expected = spendOf(reference.session.getSessionStats());
				// The summarized `task` result is the only cache write the file records.
				expect(expected.tokens.cacheWrite).toBe(2);
				expect(spendOf(cold.session.getSessionStats())).toEqual(expected);
				expect(storage.reads).toBe(spending.length);
				expect(inMemory()).toEqual([]);

				await cold.session.goalRuntime.createGoal({ objective: "Finish the resumed work" });
				await cold.session.prompt("after the resume");
				await cold.session.agent.waitForIdle();
				expect(cold.session.getGoalModeState()?.goal).toMatchObject({ tokensUsed: 345, turnsCompleted: 1 });
				// The tally of the summarized history is kept; the turn reads none of it again.
				expect(storage.reads).toBe(spending.length);
				expect(inMemory()).toEqual([]);
			} finally {
				await cold.close();
				await reference.close();
			}
		},
	);

	it("reads a cold message entry back before its message is replaced", async () => {
		const fixture = await writeSession(everyRoleHistory());
		const storage = new ObservedStorage();
		const manager = await SessionManager.open(fixture.file, fixture.dir, storage, { suppressBreadcrumb: true });
		const [replaced, ...rest] = fixture.compacted.map(id => manager.getEntry(id));
		if (replaced?.type !== "message") throw new Error("fixture lost its first message entry");

		const replacement: AgentMessage = { role: "user", content: "replaced", timestamp: 2 };
		replaced.message = replacement;
		expect(storage.reads).toBe(1);
		expect(replaced.message).toBe(replacement);
		expect(JSON.stringify(replaced)).toContain('"content":"replaced"');
		expect(storage.reads).toBe(1);

		// The handle closes with the last cold entry, which it would not if the replaced one kept its stub.
		for (const entry of rest) JSON.stringify(entry);
		expect(storage.reads).toBe(fixture.compacted.length);
		expect(storage.open.size).toBe(0);
		await manager.close();
	});

	it("holds record-only entries on disk on the live branch, and only them", async () => {
		// The compaction keeps itself, so every entry after it is on the live branch.
		const next = entryBases("l");
		const kinds = Object.entries(EVERY_ENTRY_KIND) as [string, (base: SessionEntryBase) => SessionEntry][];
		const lines: SessionEntry[] = [EVERY_ENTRY_KIND.compaction(next(null))];
		for (const [kind, make] of kinds) {
			if (kind !== "compaction") lines.push(make(next(lines.at(-1)!.id)));
		}
		lines.push({ ...next(lines.at(-1)!.id), type: "message", message: assistantTurn("live answer", 20) });
		const { dir, file } = await publishLines("cold-record", lines);

		const expected = await freshLoad({ dir, file });
		const storage = new ObservedStorage();
		const manager = await SessionManager.open(file, dir, storage, { suppressBreadcrumb: true });
		expect(JSON.stringify(manager.buildSessionContext().messages)).toContain("live answer");
		expect(storage.reads).toBe(0);

		const readBack = readBackEntries(manager, storage, expected).map(entry => entry.type);
		expect(readBack.sort()).toEqual(["session_init", "settings_snapshot", "subagent_spawn"]);
		expect(storage.open.size).toBe(0);
		await manager.close();
	});

	it("keeps the live entries in memory when the branch's lines are out of file order", async () => {
		const next = entryBases("o");
		const first = next(null);
		const second = next(first.id);
		const kept = next(second.id);
		const after = next(kept.id);
		const compaction = next(after.id);
		// Every entry is on the branch, and the kept prompt's line comes before its parent's: the
		// file order puts the kept prompt where the branch has the history before it.
		const lines: SessionEntry[] = [
			{ ...first, type: "message", message: { role: "user", content: big("first-prompt"), timestamp: 1 } },
			{ ...kept, type: "message", message: { role: "user", content: big("kept prompt"), timestamp: 3 } },
			{ ...second, type: "message", message: assistantTurn(big("first-answer"), 2) },
			{ ...after, type: "message", message: assistantTurn("kept answer", 4) },
			{ ...compaction, type: "compaction", summary: big("summary"), firstKeptEntryId: kept.id, tokensBefore: 100 },
		];
		const { dir, file } = await publishLines("cold-order", lines);

		const expected = await freshLoad({ dir, file });
		const storage = new ObservedStorage();
		const manager = await SessionManager.open(file, dir, storage, { suppressBreadcrumb: true });
		expect(manager.getBranch().map(entry => entry.id)).toEqual([
			first.id,
			second.id,
			kept.id,
			after.id,
			compaction.id,
		]);
		const contextText = JSON.stringify(manager.buildSessionContext().messages);
		expect(contextText).toContain("kept prompt");
		expect(contextText).not.toContain("first-prompt");
		expect(storage.reads).toBe(0);

		// The history before the kept prompt was moved, and only it; each reads back as a fresh load has it.
		expect(readBackEntries(manager, storage, expected).map(entry => entry.id)).toEqual([first.id, second.id]);
		expect(storage.open.size).toBe(0);
		await manager.close();
	});

	it("moves another branch out of memory when nothing is compacted", async () => {
		const next = entryBases("b");
		const root = next(null);
		const side = next(root.id);
		const answer = next(root.id);
		const prompt = next(answer.id);
		// The side branch's line sits between the live entries, and the file's last line is the leaf.
		const { dir, file } = await publishLines("cold-branch", [
			{ ...root, type: "message", message: { role: "user", content: big("root prompt"), timestamp: 1 } },
			{ ...side, type: "message", message: { role: "user", content: big("side-branch"), timestamp: 2 } },
			{ ...answer, type: "message", message: assistantTurn(big("root answer"), 3) },
			{ ...prompt, type: "message", message: { role: "user", content: big("live prompt"), timestamp: 4 } },
		]);

		const expected = await freshLoad({ dir, file });
		const storage = new ObservedStorage();
		const manager = await SessionManager.open(file, dir, storage, { suppressBreadcrumb: true });
		const contextText = JSON.stringify(manager.buildSessionContext().messages);
		for (const text of ["root prompt", "root answer", "live prompt"]) expect(contextText).toContain(text);
		expect(contextText).not.toContain("side-branch");
		expect(storage.reads).toBe(0);

		expect(readBackEntries(manager, storage, expected).map(entry => entry.id)).toEqual([side.id]);
		expect(storage.open.size).toBe(0);
		await manager.close();
	});

	it("moves the entries past the leaf out of memory once the leaf moves back and the file is republished", async () => {
		const next = entryBases("r");
		const lines: SessionEntry[] = [];
		for (const [i, tag] of ["first prompt", "first answer", "second prompt", "second answer"].entries()) {
			const base = next(lines.at(-1)?.id ?? null);
			lines.push(
				i % 2 === 0
					? { ...base, type: "message", message: { role: "user", content: big(tag), timestamp: i } }
					: { ...base, type: "message", message: assistantTurn(big(tag), i) },
			);
		}
		const { dir, file } = await publishLines("cold-leaf", lines);

		const storage = new ObservedStorage();
		const manager = await SessionManager.open(file, dir, storage, { suppressBreadcrumb: true });
		// The active branch is a prefix of the file in file order.
		manager.branch(lines[1]!.id);
		await manager.rewriteEntries();
		const contextText = JSON.stringify(manager.buildSessionContext().messages);
		for (const text of ["first prompt", "first answer"]) expect(contextText).toContain(text);
		expect(contextText).not.toContain("second prompt");
		expect(storage.reads).toBe(0);

		const expected = await freshLoad({ dir, file });
		expect(readBackEntries(manager, storage, expected).map(entry => entry.id)).toEqual([lines[2]!.id, lines[3]!.id]);
		expect(storage.open.size).toBe(0);
		await manager.close();
	});

	it("moves a new session's session_init out of memory once the session file is written", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-cold-init-"));
		tempDirs.push(root);
		const dir = path.join(root, "sessions");
		fs.mkdirSync(dir);
		fs.mkdirSync(path.join(root, "blobs"));
		const storage = new ObservedStorage();
		const manager = SessionManager.create(root, dir, storage);
		const systemPrompt = big("spawned-system-prompt", 64 * 1024);
		manager.appendSessionInit({ systemPrompt, task: big("spawned-task"), tools: ["read", "yield"] });
		manager.appendSettingsSnapshot({ "probe.value": big("setting") });
		manager.appendMessage({ role: "user", content: "spawned prompt", timestamp: 1 });
		manager.appendMessage(assistantTurn("spawned answer", 2));
		await manager.flush();

		expect(storage.open.size).toBe(1);
		expect(JSON.stringify(manager.buildSessionContext().messages)).toContain("spawned answer");
		expect(storage.reads).toBe(0);
		const init = manager.getEntries().find(entry => entry.type === "session_init");
		if (init?.type !== "session_init") throw new Error("the session recorded no session_init");
		expect(init.systemPrompt).toBe(systemPrompt);
		expect(storage.reads).toBe(1);

		const file = manager.getSessionFile();
		if (file === undefined) throw new Error("the session wrote no file");
		expect(serialized(manager)).toEqual(await freshLoad({ dir, file }));
		expect(storage.open.size).toBe(0);
		await manager.close();
	});

	it("moves every record-only entry appended after the session file exists out of memory, and only them", async () => {
		const storage = new ObservedStorage();
		const { manager, dir, file } = await openChildTranscript(storage);
		expect(Object.keys(APPEND_RECORD_ONLY).sort()).toEqual([...RECORD_ONLY_ENTRY_TYPES].sort());
		for (const append of Object.values(APPEND_RECORD_ONLY)) append(manager);
		// As large as any of them, and on the live branch: every turn sends it.
		manager.appendMessage({ role: "user", content: big("live-prompt", 64 * 1024), timestamp: 1 });
		manager.appendMessage(assistantTurn("live answer", 2));
		await manager.flush();

		const appended = storage.reads;
		expect(JSON.stringify(manager.buildSessionContext().messages)).toContain("live answer");
		expect(storage.reads).toBe(appended);
		const expected = await freshLoad({ dir, file });
		const readBack: string[] = [];
		for (const entry of manager.getEntries()) {
			const before = storage.reads;
			expect(JSON.stringify(entry)).toBe(expected.get(entry.id)!);
			if (storage.reads > before) readBack.push(entry.type);
		}
		expect(readBack.sort()).toEqual([...RECORD_ONLY_ENTRY_TYPES].sort());
		expect(storage.open.size).toBe(0);
		await manager.close();
	});

	it("keeps an appended record-only entry in memory when another writer's line landed before it", async () => {
		const storage = new ObservedStorage();
		const { manager, file } = await openChildTranscript(storage);
		// Another process appending to the same file object moves where this manager's next line lands.
		fs.appendFileSync(
			file,
			`${JSON.stringify({ type: "label", id: "foreign-1", parentId: null, timestamp: "2025-01-01T00:00:00.000Z", targetId: "foreign-0", label: big("foreign") })}\n`,
		);
		const systemPrompt = big("appended-system-prompt", 64 * 1024);
		manager.appendSessionInit({ systemPrompt, task: big("appended-task"), tools: ["read"] });

		const init = manager.getEntries().find(entry => entry.type === "session_init");
		if (init?.type !== "session_init") throw new Error("the session recorded no session_init");
		const before = storage.reads;
		expect(init.systemPrompt).toBe(systemPrompt);
		expect(storage.reads).toBe(before);
		// The handle opened to compare the line closes, since nothing reads through it.
		expect(storage.open.size).toBe(0);
		await manager.close();
	});

	it("opens no handle for an appended record-only entry too small to move", async () => {
		const storage = new ObservedStorage();
		const { manager } = await openChildTranscript(storage);
		manager.appendAgentSpawn({
			agentId: "agent-2",
			agentName: "task",
			task: "short task",
			sessionFile: "/repo/.sessions/agent-2.jsonl",
			isolation: "none",
			status: "completed",
			exitCode: 0,
			durationMs: 1,
		});
		expect(storage.open.size).toBe(0);
		expect(storage.reads).toBe(0);
		await manager.close();
	});

	it.each([
		{ history: "every message role", make: everyRoleHistoryAfterAnchor, target: "m00000", oldest: "role-user-0" },
		{ history: "every entry kind", make: everyKindHistory, target: "h00001", oldest: "probe-result-0" },
	])(
		"summarizes a branch across compacted history of $history as across the same history in memory",
		async ({ make, target, oldest }) => {
			const fixture = await writeSession(make());
			const root = path.dirname(fixture.dir);
			const warmRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-cold-summary-"));
			tempDirs.push(warmRoot);
			fs.cpSync(root, warmRoot, { recursive: true });
			const warmDir = path.join(warmRoot, "sessions");
			const warm = await SessionManager.open(path.join(warmDir, "session.jsonl"), warmDir, new UnpinnedStorage(), {
				suppressBreadcrumb: true,
			});
			const expected = await summarizeBranch(warm, warmRoot, target, () => warm.coolCompactedHistory());
			// The walk reached the oldest entry the navigation leaves, so every cold entry is in the request.
			expect(expected).toContain(oldest);

			// The size estimate a summary runs first reads most of the history back. A publish that lands
			// while the credential resolves cools it again, so the attempt walks cold entries.
			const storage = new ObservedStorage();
			const cold = await SessionManager.open(fixture.file, fixture.dir, storage, { suppressBreadcrumb: true });
			expect(storage.openIdentities()).toEqual([storage.statSync(fixture.file).identity!]);
			let readsWhenCooled: number | undefined;
			const prompt = await summarizeBranch(cold, root, target, () => {
				cold.coolCompactedHistory();
				readsWhenCooled = storage.reads;
			});
			expect(prompt).toBe(expected);
			expect(readsWhenCooled).toBeGreaterThan(0);
			expect(storage.reads).toBeGreaterThan(readsWhenCooled!);
		},
	);
});
