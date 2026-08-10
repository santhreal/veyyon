import * as fs from "node:fs";
import * as path from "node:path";
import type { ImageContent, Message, MessageAttribution, ServiceTierByFamily, TextContent, Usage } from "@veyyon/ai";
import { allowsSessionTelemetry, type InstrumentationLevel } from "@veyyon/ai/instrumentation";
import {
	directoryExists,
	errorMessage,
	getBlobsDir,
	getProjectDir,
	getSessionsDir,
	isEnoent,
	logger,
	stringifyJson,
	toError,
} from "@veyyon/utils";
import { pathStateSync } from "@veyyon/utils/fs-optional";
import { sessionFileName, sessionFileStem } from "@veyyon/utils/session-file";
import { ArtifactManager } from "./artifacts";
import { type BlobPutOptions, type BlobPutResult, BlobStore } from "./blob-store";
import {
	type BashExecutionMessage,
	type CustomMessage,
	type FileMentionMessage,
	type HookMessage,
	normalizeCustomMessagePayload,
	type PythonExecutionMessage,
	sanitizeRehydratedOpenAIResponsesAssistantMessage,
	stripInternalDetailsFields,
} from "./messages";
import type { OperatorNotices } from "./operator-notices";
import { type BuildSessionContextOptions, buildSessionContext, type SessionContext } from "./session-context";
import {
	type BranchSummaryEntry,
	type CompactionEntry,
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type CustomMessageEntry,
	type FileEntry,
	type LabelEntry,
	type MCPToolSelectionEntry,
	type ModeChangeEntry,
	type ModelChangeEntry,
	type NewSessionOptions,
	SESSION_TITLE_SLOT_ENTRY_TYPE,
	type ServiceTierChangeEntry,
	type SessionCheckpoint,
	type SessionCheckpointEntry,
	type SessionEntry,
	type SessionHeader,
	type SessionInitEntry,
	type SessionLifecycleEntry,
	type SessionLifecycleReason,
	type SessionLifecycleState,
	type SessionMessageEntry,
	type SessionTitleSource,
	type SessionTreeNode,
	type SettingsSnapshotEntry,
	type SubagentSpawnEntry,
	type SubagentSpawnRecord,
	type ThinkingLevelChangeEntry,
	TITLE_CHANGE_ENTRY_TYPE,
	type TitleChangeEntry,
	type TtsrInjectionEntry,
	type UsageStatistics,
} from "./session-entries";
import { findMostRecentSession, listAllSessions, listSessions, type SessionInfo } from "./session-listing";
import { loadEntriesFromFile, readTitleSlotFromFile, resolveBlobRefsInEntries } from "./session-loader";
import { generateId, migrateToCurrentVersion } from "./session-migrations";
import {
	computeDefaultSessionDir,
	readTerminalBreadcrumbEntry,
	resolveManagedSessionRoot,
	writeTerminalBreadcrumb,
} from "./session-paths";
import { prepareEntryForPersistence } from "./session-persistence";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorage,
	type SessionStorageStat,
	type SessionStorageWriter,
} from "./session-storage";
import { type SessionTitleUpdate, serializeTitleSlot } from "./session-title-slot";

const DRAFT_ONLY_SESSION_MARKER = ".draft-only-session";

function mintSessionId(): string {
	return Bun.randomUUIDv7();
}

function nowIso(): string {
	return new Date().toISOString();
}

function fileSafeTimestamp(iso: string): string {
	return iso.replace(/[:.]/g, "-");
}

function artifactsDirectoryFor(sessionFile: string | undefined): string | null {
	return sessionFile ? sessionFileStem(sessionFile) : null;
}

/**
 * Resolve a breadcrumb's recorded session file to its interactive root. Subagent
 * (and other artifact) sessions live inside a parent session's artifacts dir —
 * `<parent>.jsonl` strips its suffix to `<parent>/`, and a child writes
 * `<parent>/<agentId>.jsonl`. A breadcrumb that points at such a child — a
 * pre-fix poisoned crumb left by a subagent that opened in the parent's TTY, or
 * any nested artifact — must resolve back up to the top-level session so
 * `--continue` resumes the real conversation instead of a subagent transcript.
 */
function resolveBreadcrumbToInteractiveRoot(sessionFile: string): string {
	let current = path.resolve(sessionFile);
	// Walk up while the containing dir is itself a session's artifacts dir
	// (`<dir>.jsonl` exists). Capped to defend against pathological layouts.
	for (let depth = 0; depth < 8; depth++) {
		const parentSessionFile = sessionFileName(path.dirname(current));
		// `!== "present"` stops the climb on absent AND on unreachable. This is a resolution walk
		// where a miss is the expected answer at nearly every step, so the state is not reported,
		// but the direction still matters: climbing into a parent transcript this process cannot
		// read would hand `--continue` a session it cannot load, and stopping one level down hands
		// it a real one.
		if (pathStateSync(parentSessionFile) !== "present") return current;
		current = parentSessionFile;
	}
	return current;
}

function emptyUsageStatistics(): UsageStatistics {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		orchestrationInput: 0,
		orchestrationOutput: 0,
		orchestrationCacheRead: 0,
		premiumRequests: 0,
		cost: 0,
	};
}

function taskUsageFrom(details: unknown): Usage | undefined {
	if (details === null || typeof details !== "object") return undefined;
	const maybeUsage = (details as Record<string, unknown>).usage;
	return maybeUsage !== null && typeof maybeUsage === "object" ? (maybeUsage as Usage) : undefined;
}

function entryUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "assistant") return message.usage;
	if (message.role === "toolResult" && message.toolName === "task") return taskUsageFrom(message.details);
	return undefined;
}

function addUsage(target: UsageStatistics, usage: Usage | undefined): void {
	if (!usage) return;
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	target.orchestrationInput += usage.orchestration?.input ?? 0;
	target.orchestrationOutput += usage.orchestration?.output ?? 0;
	target.orchestrationCacheRead += usage.orchestration?.cacheRead ?? 0;
	target.premiumRequests += usage.premiumRequests ?? 0;
	target.cost += usage.cost.total;
}

function isAssistantEntry(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "assistant";
}

function isDraftOnlyMetadataEntry(entry: SessionEntry): boolean {
	// Startup-recorded selector state and additive lifecycle telemetry do not
	// survive as user intent once the draft is cleared. `mode_change` covers
	// the `plan.defaultOnStartup` path (interactive-mode.ts enters plan mode
	// before draft restoration) and `/plan` toggles that leave the session
	// otherwise empty. Entries carrying real conversation state, such as
	// messages, compactions, branch summaries, custom/custom_message,
	// session_init, labels, and title/tool selection, always keep the file
	// resumable.
	switch (entry.type) {
		case "model_change":
		case "thinking_level_change":
		case "service_tier_change":
		case "mode_change":
		case "session_lifecycle":
			return true;
		default:
			return false;
	}
}

function isSessionIncarnationTelemetry(entry: SessionEntry): boolean {
	return entry.type === "session_lifecycle" || entry.type === "session_checkpoint";
}

function orderedByTimestamp(a: SessionTreeNode, b: SessionTreeNode): number {
	return new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime();
}

/**
 * Maintains the derived views over a session's entry list: id lookup, the
 * parent→children adjacency, the resolved label map, the active leaf, and the
 * running usage totals. Kept in lockstep with the manager's `#entries` so reads
 * stay O(1)/O(children) instead of rescanning the whole journal.
 */
class SessionEntryIndex {
	#entriesById = new Map<string, SessionEntry>();
	#children = new Map<string | null, SessionEntry[]>();
	#labels = new Map<string, string>();
	#leaf: string | null = null;
	#usage = emptyUsageStatistics();

	clear(): void {
		this.#entriesById.clear();
		this.#children.clear();
		this.#labels.clear();
		this.#leaf = null;
		this.#usage = emptyUsageStatistics();
	}

	rebuild(entries: readonly SessionEntry[]): void {
		this.clear();
		for (const entry of entries) this.insert(entry);
	}

	insert(entry: SessionEntry): void {
		this.#entriesById.set(entry.id, entry);
		this.#leaf = entry.id;

		const bucket = this.#children.get(entry.parentId);
		if (bucket) bucket.push(entry);
		else this.#children.set(entry.parentId, [entry]);

		if (entry.type === "label") {
			if (entry.label) this.#labels.set(entry.targetId, entry.label);
			else this.#labels.delete(entry.targetId);
		}

		addUsage(this.#usage, entryUsage(entry));
	}

	has(id: string): boolean {
		return this.#entriesById.has(id);
	}

	get(id: string): SessionEntry | undefined {
		return this.#entriesById.get(id);
	}

	/**
	 * The live id→entry map. Read-only for callers (lookups + `generateId`
	 * collision checks); never mutate it directly — go through `insert`/`rebuild`.
	 */
	entriesById(): Map<string, SessionEntry> {
		return this.#entriesById;
	}

	leafId(): string | null {
		return this.#leaf;
	}

	leafEntry(): SessionEntry | undefined {
		return this.#leaf ? this.#entriesById.get(this.#leaf) : undefined;
	}

	setLeaf(id: string | null): void {
		this.#leaf = id;
	}

	childrenOf(parentId: string): SessionEntry[] {
		return [...(this.#children.get(parentId) ?? [])];
	}

	labelFor(id: string): string | undefined {
		return this.#labels.get(id);
	}

	labelsInEffect(): IterableIterator<[string, string]> {
		return this.#labels.entries();
	}

	usageSnapshot(): UsageStatistics {
		return { ...this.#usage };
	}

	pathTo(id: string | null | undefined = this.#leaf): SessionEntry[] {
		const branch: SessionEntry[] = [];
		const seen = new Set<string>();
		let cursor = id ? this.#entriesById.get(id) : undefined;

		while (cursor && !seen.has(cursor.id)) {
			seen.add(cursor.id);
			branch.push(cursor);
			cursor = cursor.parentId ? this.#entriesById.get(cursor.parentId) : undefined;
		}
		branch.reverse();
		return branch;
	}

	tree(entries: readonly SessionEntry[]): SessionTreeNode[] {
		const nodes = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		for (const entry of entries) {
			nodes.set(entry.id, { entry, children: [], label: this.#labels.get(entry.id) });
		}

		for (const entry of entries) {
			const node = nodes.get(entry.id)!;
			const parentId = entry.parentId;
			if (parentId === null || parentId === entry.id) {
				roots.push(node);
				continue;
			}

			const parent = nodes.get(parentId);
			if (parent) parent.children.push(node);
			else roots.push(node);
		}

		const stack = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort(orderedByTimestamp);
			stack.push(...node.children);
		}

		return roots;
	}
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getSessionName"
	| "getArtifactsDir"
	| "getArtifactManager"
	| "allocateArtifactPath"
	| "saveArtifact"
	| "getArtifactPath"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "getHeader"
	| "getEntries"
	| "getLifecycleState"
	| "getEntriesThroughCheckpoint"
	| "getTree"
	| "getUsageStatistics"
	| "putBlob"
	| "putBlobSync"
>;

export interface SessionManagerNoticeOptions {
	/** Operator-visible channel for non-fatal session-load data loss. */
	operatorNotices?: OperatorNotices;
	/** Canonical granularity controlling additive session telemetry. */
	instrumentation?: InstrumentationLevel;
}

interface SessionManagerStateSnapshot {
	cwd: string;
	sessionDir: string;
	sessionId: string;
	sessionName: string | undefined;
	titleSource: SessionTitleSource | undefined;
	sessionFile: string | undefined;
	titleUpdatedAt: string;
	hasTitleSlot: boolean;
	onDisk: boolean;
	needsRewrite: boolean;
	draftOnlySessionCleanupArmed: boolean;
	nextSequence: number;
	lifecycleStarted: boolean;
	lifecycleEnded: boolean;
	header: SessionHeader;
	entries: SessionEntry[];
}

interface DiskQueueOptions {
	ignorePriorError?: boolean;
	ignoreEpoch?: boolean;
	epoch?: number;
}

function assertSessionSequence(sequence: unknown): asserts sequence is number {
	if (!Number.isSafeInteger(sequence) || (sequence as number) < 0 || (sequence as number) >= Number.MAX_SAFE_INTEGER) {
		throw new Error(
			`Session sequence must be a non-negative safe integer below ${Number.MAX_SAFE_INTEGER}; repair or remove the invalid telemetry entry before resuming`,
		);
	}
}

function nextSessionSequence(entries: readonly SessionEntry[]): number {
	let highest = entries.length;
	for (const entry of entries) {
		if (entry.sequence === undefined) continue;
		assertSessionSequence(entry.sequence);
		if (entry.sequence > highest) highest = entry.sequence;
	}
	assertSessionSequence(highest);
	return highest + 1;
}

/**
 * Stores and navigates an append-only conversation journal.
 *
 * A session is a JSONL file: one header line followed by entries. Entries form a
 * tree by `(id, parentId)`, and the mutable leaf pointer selects which path is
 * active for future appends and for LLM context construction.
 *
 * Durability is software-crash safe but not power-loss safe: appends are handed
 * to the OS synchronously in-body (so an entry survives an OOM/SIGKILL the
 * instant `appendMessage` returns) but never `fsync`'d. Full-file rewrites go
 * through the storage layer's atomic temp-write+rename so a crash mid-rewrite
 * cannot truncate the prior good file.
 */
export class SessionManager {
	#cwd: string;
	#sessionDir: string;
	readonly #persist: boolean;
	readonly #storage: SessionStorage;
	readonly #blobs: BlobStore;
	#operatorNotices: OperatorNotices | undefined;

	#sessionId = "";
	/**
	 * Notified whenever the session id changes, which is every `/new`, `/resume`,
	 * fork, and branch. Per-session machinery registered against an id at
	 * construction (the CPU budget group) is orphaned by that change otherwise:
	 * it keeps enforcing under a name nothing resolves any more, and the
	 * conversation the operator is now in has no limiter at all.
	 */
	readonly #sessionIdListeners = new Set<(sessionId: string) => void>();
	#sessionName: string | undefined;
	#titleSource: SessionTitleSource | undefined;
	#sessionFile: string | undefined;
	#header!: SessionHeader;
	#titleUpdatedAt = "";
	#hasTitleSlot = true;
	#entries: SessionEntry[] = [];
	#index = new SessionEntryIndex();
	#instrumentation: InstrumentationLevel | undefined;
	#nextSequence = 1;
	#lifecycleStarted = false;
	#lifecycleEnded = false;

	/** File reflects all current entries; appends can go incrementally. */
	#fileIsCurrent = false;
	/** In-memory entries diverged from disk (load-migration/sanitize) → next persist must full-rewrite. */
	#rewriteRequired = false;
	/** Lazy gate crossed (ensureOnDisk / loaded file): every entry must persist from now on. */
	#forceFileCreation = false;
	/**
	 * Armed only when this manager observed a draft sidecar lifecycle that
	 * materialized an otherwise metadata-only session file. Explicit
	 * ensureOnDisk() callers (ACP session/new, handoff) must survive close().
	 */
	#draftOnlySessionCleanupArmed = false;

	/**
	 * Collab replication tap: invoked for every appended entry with the
	 * in-memory (pre-blob-externalization) entry, so inline images survive.
	 */
	onEntryAppended?: (entry: SessionEntry) => void;

	#turnBudgetTotal: number | null = null;
	#turnBudgetHard = false;
	#turnOutputBaseline = 0;
	#turnEvalOutput = 0;

	/** The single open append writer; the manager only ever writes one file at a time. */
	#writer: SessionStorageWriter | undefined;
	/** Serializes async disk work (flush/close/atomic rewrite). Appends are synchronous and bypass it. */
	#diskTail: Promise<void> = Promise.resolve();
	#diskFailure: Error | undefined;
	#diskFailureLogged = false;
	/** Bumped on every sync rewrite / chain reset so stale queued tasks become no-ops. */
	#diskEpoch = 0;
	/**
	 * Epoch of the in-flight atomic rewrite, or `null` when no rewrite is running.
	 * The fence in {@link #appendToSessionFile} only applies while this matches
	 * `#diskEpoch`: once a synchronous rewrite (`flushSync` → `#rewriteSynchronously`)
	 * bumps the epoch, the pending atomic publish is guaranteed to abandon via
	 * its `commitGuard`, and appends can safely take the hot path against the
	 * freshly-published file.
	 */
	#atomicRewriteFenceEpoch: number | null = null;
	/** Set by synchronous appends that land while an atomic replacement is active. */
	#atomicRewriteDirty = false;

	/**
	 * Every entry id this manager has ever held for the CURRENT session file:
	 * what it loaded, plus everything it appended since.
	 *
	 * A full-file publish writes only the entries this manager holds, so a line
	 * some OTHER process appended after we read the file is deleted by our next
	 * rewrite. Two terminals on one session (`--continue` twice, or `/resume` on
	 * a session another instance still has open) is enough: the second process
	 * compacts, drops images, or dedupes, and the first process's turns are gone
	 * from disk and from every later reader. Nothing surfaces it, because the
	 * process that lost the work is not the process that wrote the file.
	 *
	 * So a line is foreign only when its id was never ours. An entry we loaded and
	 * then deliberately dropped (incarnation telemetry, a branch compacted to its
	 * path) stays in this set, which is what stops the merge below from
	 * resurrecting it.
	 */
	#idsEverSeen = new Set<string>();
	/**
	 * Raw lines of the current file that belong to another writer, in file order,
	 * carried through every full-file publish so a rewrite cannot delete them.
	 * Refreshed from disk before each atomic publish.
	 */
	#foreignLines: string[] = [];
	/** One warning per file: a foreign writer stays foreign for the whole session. */
	#reportedForeignWriter = false;
	/**
	 * What this manager believes is at {@link #sessionFile}: the object the path
	 * named when it last published (`identity`, where the backend reports one) and
	 * how many bytes it has written to it. `null` means it has published nothing
	 * yet and cannot tell.
	 *
	 * An append goes through a writer HANDLE, and a full-file publish by anyone is
	 * a temp write plus a rename, so a second window's publish leaves this
	 * window's handle pointing at an unlinked inode. Appends through it then
	 * report success, are visible to nothing, and disappear when the last handle
	 * closes. Comparing this against a `statSync` is what makes that detectable
	 * without reading the file: a different inode means someone republished the
	 * path, whether or not the body they wrote is the same length as ours.
	 */
	#publishedFileState: { size: number; identity?: string } | null = null;

	#artifactManager: ArtifactManager | null = null;
	#artifactManagerSessionFile: string | null = null;
	#adoptedArtifactManager: ArtifactManager | null = null;
	#inMemoryArtifacts: Map<string, string> | null = null;
	#inMemoryArtifactCounter = 0;

	#suppressBreadcrumb = false;
	#sessionNameChangedCallbacks = new Set<() => void>();
	#cwdChangedCallbacks = new Set<(previous: string, next: string) => void>();

	/**
	 * True when the caller passed an explicit `sessionDir` rather than letting one
	 * be derived. {@link moveTo} honours a pinned directory instead of relocating
	 * storage on a cwd change.
	 *
	 * This is recorded rather than inferred. `moveTo` used to guess at the same
	 * question by checking whether the directory's basename was the encoded form
	 * of the cwd, which cannot tell "the caller pinned this path" apart from "this
	 * session was opened from a file that happens to live somewhere arbitrary".
	 * The two want opposite things, and the guess silently gave the first one the
	 * second one's answer: a pinned directory was abandoned for the global
	 * sessions root.
	 */
	#sessionDirPinned: boolean;

	private constructor(
		cwd: string,
		sessionDir: string,
		persist: boolean,
		storage: SessionStorage,
		sessionDirPinned = false,
		operatorNotices?: OperatorNotices,
		instrumentation?: InstrumentationLevel,
	) {
		// The session cwd is the single authority every tool resolves against, so it
		// must be absolute from the start; a relative seed would make later
		// `path.resolve(this.#cwd, target)` fall back to the OS process dir.
		this.#cwd = path.resolve(cwd);
		this.#sessionDir = sessionDir;
		this.#sessionDirPinned = sessionDirPinned;
		this.#persist = persist;
		this.#storage = storage;
		this.#operatorNotices = operatorNotices;
		this.#instrumentation = instrumentation;
		this.#blobs = new BlobStore(getBlobsDir());

		if (persist && sessionDir) this.#storage.ensureDirSync(sessionDir);
	}

	#rememberBreadcrumb(cwd: string, sessionFile: string): void {
		if (!this.#suppressBreadcrumb) writeTerminalBreadcrumb(cwd, sessionFile);
	}

	#clearDiskError(): void {
		this.#diskFailure = undefined;
		this.#diskFailureLogged = false;
	}

	/**
	 * Give a latched persistence fault one attempt to heal, and say whether there
	 * was one to heal.
	 *
	 * A failed write latches `#diskFailure`, and every later persist refused on the
	 * strength of that latch: the next append threw the OLD error at a caller doing
	 * nothing wrong, the disk chain refused to run the work, and `close()` rethrew
	 * instead of publishing. A fault is a moment, not a property of the session. A
	 * disk that fills and is emptied, a network mount that blips, a directory whose
	 * permissions are fixed while the session is open: after any of those the
	 * conversation is still whole in memory and cannot reach the file again, so
	 * every turn from the fault onwards is lost with a healthy disk underneath it.
	 *
	 * The attempt needs no schedule and no backoff, because a full-file publish is
	 * self-sufficient: it writes every entry this manager holds, so ONE successful
	 * rewrite makes the file whole again however many appends were refused before
	 * it. It costs one serialization of the transcript, entries arrive at the pace
	 * of a conversation, and a fault that is still there simply latches again.
	 */
	#retryPersistenceAfterFailure(): boolean {
		if (!this.#diskFailure) return false;
		// Unlatch, but leave `#diskFailureLogged` alone. A broken disk retries on every
		// entry, and clearing the reported flag here would put one notice on screen per
		// entry for a fault the operator already knows about. Only a successful publish
		// clears it (`#clearDiskError`), which is what makes the NEXT fault speak.
		this.#diskFailure = undefined;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = true;
		return true;
	}

	#noteDiskFailure(errorLike: unknown): Error {
		const error = toError(errorLike);
		if (!this.#diskFailure) this.#diskFailure = error;

		if (!this.#diskFailureLogged) {
			this.#diskFailureLogged = true;
			logger.error("Session persistence error.", {
				sessionFile: this.#sessionFile,
				error: error.message,
				stack: error.stack,
			});
			// The log alone reaches nobody: the default transports are file-only and a
			// TUI cannot use the console. The conversation continuing on screen while
			// nothing of it is being saved is exactly the state an operator has to be
			// told about, so it goes to the channel a surface renders. Once per fault:
			// `#clearDiskError` resets this, so a fresh fault after a recovery speaks
			// again and a fault that stays put does not repeat itself every entry.
			this.#operatorNotices?.error(
				"session",
				`could not write this conversation to ${this.#sessionFile ?? "its transcript"} (${error.message}). It is still complete in this window and the whole file is rewritten on the next attempt.`,
			);
		}

		return this.#diskFailure;
	}

	#scheduleDiskWork(work: () => Promise<void>, options: DiskQueueOptions = {}): Promise<void> {
		const epoch = options.epoch ?? this.#diskEpoch;
		// The PREVIOUS disk write's failure was already delivered to its own caller and latched in
		// `#diskFailure`, which the work below rethrows for anyone who has not opted out. Chaining onto the
		// caught copy is what keeps one bad write from rejecting every later one.
		const scheduled = this.#diskTail
			.catch(() => undefined)
			.then(async () => {
				if (!options.ignoreEpoch && epoch !== this.#diskEpoch) return;
				if (this.#diskFailure && !options.ignorePriorError) throw this.#diskFailure;
				await work();
			});

		const reported = scheduled.catch(err => {
			throw this.#noteDiskFailure(err);
		});
		// `reported` is returned and carries the failure (and `#noteDiskFailure` records it); the tail only
		// orders the next write.
		this.#diskTail = reported.catch(() => undefined);
		return reported;
	}

	async #drainAndCloseWriter(): Promise<void> {
		try {
			await this.#scheduleDiskWork(
				async () => {
					await this.#closeWriterHandle();
				},
				{ ignorePriorError: true, ignoreEpoch: true },
			);
		} finally {
			this.#writer = undefined;
			this.#diskTail = Promise.resolve();
		}
	}

	#closeWriterEventually(): void {
		const writer = this.#writer;
		this.#writer = undefined;
		// Nobody awaits this close, so a failure here used to vanish -- and this writer holds the session's
		// JSONL: a close that fails can mean buffered entries never reached disk. Reported so a truncated
		// session file has an explanation.
		if (writer) {
			void writer.close().catch((error: unknown) => {
				logger.warn("session writer close failed; buffered entries may be lost", {
					error: errorMessage(error),
				});
			});
		}
	}

	async #closeWriterHandle(): Promise<void> {
		const writer = this.#writer;
		if (!writer) return;
		this.#writer = undefined;
		await writer.close();
	}

	#appendWriter(): SessionStorageWriter {
		if (!this.#sessionFile) throw new Error("Cannot open a session writer before a session file exists");

		if (this.#writer?.isOpen()) return this.#writer;

		this.#writer = this.#storage.openWriter(this.#sessionFile, {
			flags: "a",
			onError: err => this.#noteDiskFailure(err),
		});
		return this.#writer;
	}

	#lineFor(entry: FileEntry): string {
		return `${stringifyJson(prepareEntryForPersistence(entry, this.#blobs)) ?? "null"}\n`;
	}

	#titleSlotLine(): string {
		return serializeTitleSlot({
			title: this.#sessionName,
			source: this.#titleSource,
			updatedAt: this.#titleUpdatedAt || this.#header.timestamp,
		});
	}

	/**
	 * The whole file as this manager would publish it: the title slot, the header,
	 * our entries, and finally any line another writer appended (see
	 * {@link #idsEverSeen}). The foreign tail goes last because its entries hang
	 * off ids we already emitted, so parents still precede children.
	 */
	#fileBody(): string {
		let body = this.#titleSlotLine();
		body += this.#lineFor(this.#header);
		for (const entry of this.#entries) body += this.#lineFor(entry);
		for (const line of this.#foreignLines) body += line.endsWith("\n") ? line : `${line}\n`;
		return body;
	}

	/** Remember an id as ours, so a line carrying it is never treated as foreign. */
	#noteIdSeen(id: string | undefined): void {
		if (id) this.#idsEverSeen.add(id);
	}

	/**
	 * Start foreign tracking over for the file this manager now owns: another
	 * file's foreign tail is not ours to publish, and everything we hold at this
	 * moment is ours in the new file.
	 *
	 * The reseed is what keeps a fork or a branch from duplicating its own
	 * history: those paths carry the source entries into a fresh file, and an id
	 * that is not marked ours reads back as foreign on the next publish.
	 */
	#forgetForeignWriter(): void {
		this.#idsEverSeen.clear();
		this.#foreignLines = [];
		this.#reportedForeignWriter = false;
		// A different file: how many bytes are at the new path is not known until we
		// publish it.
		this.#publishedFileState = null;
		this.#noteIdSeen(this.#header.id);
		for (const entry of this.#entries) this.#noteIdSeen(entry.id);
	}

	/**
	 * Re-read the session file and record any line this manager never wrote, so
	 * the publish that follows carries it instead of deleting it.
	 *
	 * A read failure leaves the previous knowledge in place rather than blocking
	 * the publish: losing the elision a rewrite was asked for is worse than
	 * carrying a slightly stale foreign tail, and an unreadable file is reported
	 * by the read paths already.
	 */
	async #refreshForeignLines(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		if (!(await this.#storage.exists(this.#sessionFile))) return;
		let text: string;
		try {
			text = await this.#storage.readText(this.#sessionFile);
		} catch {
			return;
		}
		this.#adoptForeignLines(text);
	}

	/**
	 * The same refresh for the synchronous publish, which is the one that runs on
	 * the way out (`flushSync`, exit) and as the fallback when an append finds the
	 * file not current.
	 *
	 * The loss is at its worst here precisely because the process is leaving: no
	 * later atomic publish will carry back a line this one deletes. A backend that
	 * can read without yielding says so by implementing `readTextSync`; one that
	 * cannot leaves the previous knowledge in place, which is all this path could
	 * ever do.
	 */
	#refreshForeignLinesSync(): void {
		if (!this.#persist || !this.#sessionFile) return;
		let text: string | undefined;
		try {
			text = this.#storage.readTextSync?.(this.#sessionFile);
		} catch {
			return;
		}
		if (text === undefined) return;
		this.#adoptForeignLines(text);
	}

	/**
	 * Record which of a file's lines were never ours, and tell the operator once
	 * that something else is writing the file.
	 */
	#adoptForeignLines(text: string): void {
		const foreign: string[] = [];
		for (const raw of text.split("\n")) {
			if (!raw.trim()) continue;
			let parsed: { type?: unknown; id?: unknown } | undefined;
			try {
				parsed = JSON.parse(raw) as { type?: unknown; id?: unknown };
			} catch {
				continue;
			}
			// The title slot is a fixed-width line this manager rewrites every time,
			// and a header belongs to whoever owns the file's identity.
			if (parsed.type === SESSION_TITLE_SLOT_ENTRY_TYPE || parsed.type === "session") continue;
			const id = typeof parsed.id === "string" ? parsed.id : undefined;
			if (!id || this.#idsEverSeen.has(id)) continue;
			foreign.push(raw);
		}
		this.#foreignLines = foreign;
		if (foreign.length > 0 && !this.#reportedForeignWriter) {
			this.#reportedForeignWriter = true;
			const message = `Another veyyon session is writing ${this.#sessionFile}; its entries are being kept alongside this session's. Close one of them, or run /fork to give this session its own transcript.`;
			logger.warn("session file has a second writer", {
				sessionFile: this.#sessionFile,
				foreignLines: foreign.length,
			});
			this.#operatorNotices?.warn("session", message);
		}
	}

	#historyContainsAssistantMessage(): boolean {
		return this.#entries.some(isAssistantEntry);
	}

	#shouldHaveSessionFile(): boolean {
		return this.#forceFileCreation || this.#fileIsCurrent || this.#historyContainsAssistantMessage();
	}

	/**
	 * Synchronously rewrite the whole file (header + entries) and keep no open
	 * writer; the next append re-opens one. `writeTextSync` returns with the
	 * bytes in the kernel page cache, so the file is software-crash durable.
	 *
	 * This path runs on exit and on the `flushSync` fallback, so it re-reads the
	 * file first through {@link #refreshForeignLinesSync}: a second writer's tail
	 * deleted here is deleted for good, since the process is on its way out and no
	 * later atomic publish will carry it back. A backend that cannot read without
	 * yielding carries only the foreign lines the last atomic publish learned
	 * about, which is all a synchronous path can do there.
	 */
	#rewriteSynchronously(): void {
		if (!this.#persist || !this.#sessionFile || !this.#shouldHaveSessionFile()) return;

		try {
			this.#refreshForeignLinesSync();
			const body = this.#fileBody();
			this.#diskEpoch++;
			this.#diskTail = Promise.resolve();
			this.#closeWriterEventually();
			this.#storage.writeTextSync(this.#sessionFile, body);
			this.#notePublishedFile(Buffer.byteLength(body, "utf-8"));
			// The file matches memory again, so the fault episode is over and a later one
			// is a new thing to report.
			this.#clearDiskError();
			this.#fileIsCurrent = true;
			this.#rewriteRequired = false;
			this.#hasTitleSlot = true;
		} catch (err) {
			this.#noteDiskFailure(err);
		}
	}

	/**
	 * Rewrite the whole file atomically (temp-write + rename, EPERM-safe) on the
	 * disk chain. The body is serialized after the writer is closed. The fence
	 * is enabled BEFORE `#closeWriterHandle()` and stays active until the last
	 * atomic publish returns, so a sync append landing in the close-yield window
	 * cannot open a fresh writer that the pending replacement would then detach
	 * from the current JSONL path. A `commitGuard` also prevents a superseding
	 * synchronous rewrite from being overwritten by the stale body serialized
	 * before it ran.
	 */
	async #rewriteAtomically(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;

		const startEpoch = this.#diskEpoch;
		await this.#scheduleDiskWork(
			async () => {
				if (await this.#runFencedAtomicRewrite(startEpoch)) {
					// Same as the synchronous publish: the episode ends when the file is whole.
					this.#clearDiskError();
					this.#fileIsCurrent = true;
					this.#rewriteRequired = false;
					this.#hasTitleSlot = true;
				}
			},
			{ epoch: startEpoch },
		);
	}

	/**
	 * Shared fenced atomic-rewrite loop used by `#rewriteAtomically` and the
	 * `#persistTitleChangeEntry` fallback. Holds `#atomicRewriteActive` across
	 * the writer close and the full-file replace, and loops on
	 * `#atomicRewriteDirty` so any fenced append that lands during the rewrite
	 * is captured before the task resolves. Returns `false` when the disk epoch
	 * moved (a superseding synchronous rewrite has taken over) so callers skip
	 * their post-publish state updates.
	 */
	async #runFencedAtomicRewrite(epoch: number): Promise<boolean> {
		this.#atomicRewriteFenceEpoch = epoch;
		try {
			do {
				this.#atomicRewriteDirty = false;
				await this.#closeWriterHandle();
				const sessionFile = this.#sessionFile;
				if (!sessionFile) return false;
				if (this.#diskEpoch !== epoch) return false;
				// Read the file back first: a second manager holding the same path
				// appends lines this manager has never seen, and a full-file body
				// that omits them deletes them (see #refreshForeignLines).
				await this.#refreshForeignLines();
				if (this.#diskEpoch !== epoch) return false;
				const body = this.#fileBody();
				await this.#storage.writeTextAtomic(sessionFile, body, {
					commitGuard: () => this.#diskEpoch === epoch,
				});
				if (this.#diskEpoch !== epoch) return false;
				this.#notePublishedFile(Buffer.byteLength(body, "utf-8"));
			} while (this.#atomicRewriteDirty);
			return true;
		} finally {
			// Only relinquish the fence if we still own it. A superseding
			// synchronous rewrite (`flushSync` → `#rewriteSynchronously`) may
			// have reset `#diskTail`, scheduled a fresh atomic task at the new
			// epoch, and that task may have taken ownership of the fence while
			// this stale rewrite was still awaiting storage. Clearing it here
			// unconditionally would strand appends during the newer publish.
			if (this.#atomicRewriteFenceEpoch === epoch) this.#atomicRewriteFenceEpoch = null;
		}
	}

	#appendToSessionFile(entry: SessionEntry): void {
		if (!this.#persist || !this.#sessionFile) return;
		// A latched fault does not refuse this entry: it makes the entry the reason to
		// try the file again. The retry marks the file divergent, so the branch below
		// publishes the whole transcript rather than appending one line to a file that
		// is missing everything since the fault.
		this.#retryPersistenceAfterFailure();

		// Lazy gate: a brand-new session is not written until it has an assistant
		// message (or someone forced creation), so sessions that never produce
		// output never create a file.
		if (!this.#shouldHaveSessionFile()) {
			this.#fileIsCurrent = false;
			return;
		}

		// Atomic replacement window: the old path may be moved aside underneath
		// any newly-opened append handle (Windows EPERM fallback). Do not open a
		// writer here; the active rewrite loops and serializes a fresh full body.
		// A superseding synchronous rewrite bumps `#diskEpoch`, at which point
		// the pending atomic publish is guaranteed to abandon via its
		// `commitGuard`, so appends can (and must) take the hot path so they
		// don't strand in memory while `close()` returns without a rewrite.
		if (this.#atomicRewriteFenceEpoch !== null && this.#atomicRewriteFenceEpoch === this.#diskEpoch) {
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
			this.#atomicRewriteDirty = true;
			return;
		}
		// Cold/divergent: not on disk yet, or in-memory entries diverged from the
		// file → rewrite the whole file synchronously and keep going.
		if (!this.#fileIsCurrent || this.#rewriteRequired) {
			this.#rewriteSynchronously();
			return;
		}

		// Another window may have replaced the file since the writer was opened, in
		// which case the handle addresses an inode nothing can reach any more. The
		// merge that carries both histories needs to READ the file, which this
		// synchronous path cannot do, so hand the entry to the atomic rewrite: it
		// refreshes the foreign lines and republishes everything, including this
		// entry. Durability moves to the disk chain (`flush()`) for this one entry,
		// which is the cost of not writing it into a file that no longer exists.
		if (this.#fileReplacedUnderWriter()) {
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
			// Take the fence NOW, at the epoch the rewrite below will run under, so an
			// append landing before that task starts is absorbed by its loop
			// (`#atomicRewriteDirty`) instead of falling to the synchronous rewrite,
			// which cannot read and would publish a body missing the other window's
			// lines: the loss this whole path exists to prevent.
			this.#atomicRewriteDirty = true;
			this.#atomicRewriteFenceEpoch = this.#diskEpoch;
			void this.#rewriteAtomically();
			return;
		}

		// Hot path: append synchronously so the entry is durable the instant this
		// returns (file/memory writers perform the write in-body). Never routed
		// through the async disk chain — durability must hold without a flush().
		// A mid-close writer leaves `#writer` undefined, so `#appendWriter` simply
		// opens a fresh append handle and the entry still lands.
		const line = this.#lineFor(entry);
		try {
			void this.#appendWriter()
				.append(line)
				.catch(err => this.#noteDiskFailure(err));
			if (this.#publishedFileState !== null) this.#publishedFileState.size += Buffer.byteLength(line, "utf-8");
		} catch (err) {
			this.#noteDiskFailure(err);
		}
	}

	/**
	 * True when the bytes at the session path are not the bytes this manager
	 * wrote, which means someone else published a whole file over it (or removed
	 * it) and the append handle no longer addresses it.
	 *
	 * Identity is the real test where the backend reports one: a full-file publish
	 * renames a temp file over the path, so the inode changes even when the body
	 * is byte-identical to ours, which is the ordinary case (the other window
	 * republished the same history it loaded from us). Size is the fallback for a
	 * backend that addresses by path and therefore cannot strand a handle at all;
	 * there it only catches another writer's growth, and reading as replaced
	 * costs one merging rewrite.
	 */
	#fileReplacedUnderWriter(): boolean {
		const expected = this.#publishedFileState;
		if (expected === null || !this.#sessionFile) return false;
		let current: SessionStorageStat;
		try {
			current = this.#storage.statSync(this.#sessionFile);
		} catch {
			// Gone, or unreadable: whatever the handle points at, it is not the file
			// at this path.
			return true;
		}
		if (expected.identity !== undefined && current.identity !== undefined) {
			return current.identity !== expected.identity;
		}
		return current.size !== expected.size;
	}

	/** Record what we just published, so the next append can tell it is still there. */
	#notePublishedFile(bodyByteLength: number): void {
		if (!this.#sessionFile) return;
		let identity: string | undefined;
		try {
			identity = this.#storage.statSync(this.#sessionFile).identity;
		} catch {
			identity = undefined;
		}
		this.#publishedFileState = { size: bodyByteLength, identity };
	}

	async #persistTitleChangeEntry(entry: TitleChangeEntry, update: SessionTitleUpdate): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		this.#retryPersistenceAfterFailure();

		if (!this.#shouldHaveSessionFile()) {
			this.#fileIsCurrent = false;
			return;
		}

		// `!== "present"` keeps the answer this had and stops it being silent. Both other states
		// take the same branch on purpose: a title change is written by patching a fixed-width slot
		// in place, which needs the file to be readable, so "gone" and "there but unreachable" are
		// equally reasons to rewrite the whole thing instead. The rewrite then fails with the real
		// errno if the path is genuinely unusable. What changes is that the unreachable case is
		// REPORTED once through the storage fault channel rather than looking like an absent file.
		//
		// The replacement probe belongs here for the same reason it belongs on the append hot path:
		// this path appends the entry through the writer handle, which another window's publish
		// leaves addressing an unlinked inode. The slot patch addresses the PATH and lands on the
		// new file, so without the probe the title changes and the entry recording it disappears.
		if (
			!this.#fileIsCurrent ||
			this.#rewriteRequired ||
			!this.#hasTitleSlot ||
			this.#fileReplacedUnderWriter() ||
			this.#storage.existsStateSync(this.#sessionFile) !== "present"
		) {
			await this.#rewriteAtomically();
			return;
		}

		const epoch = this.#diskEpoch;
		const line = this.#lineFor(entry);
		await this.#scheduleDiskWork(
			async () => {
				const sessionFile = this.#sessionFile;
				if (!sessionFile) return;
				try {
					await this.#appendWriter().append(line);
					if (this.#publishedFileState !== null) this.#publishedFileState.size += Buffer.byteLength(line, "utf-8");
					await this.#storage.updateSessionTitle(sessionFile, update);
					if (this.#diskEpoch === epoch) this.#fileIsCurrent = true;
				} catch {
					if (!(await this.#runFencedAtomicRewrite(epoch))) return;
					this.#clearDiskError();
					this.#fileIsCurrent = true;
					this.#rewriteRequired = false;
					this.#hasTitleSlot = true;
				}
			},
			{ epoch },
		);
	}

	#notifyEntryAppended(entry: SessionEntry): void {
		const callback = this.onEntryAppended;
		if (callback) {
			try {
				callback(entry);
			} catch (err) {
				logger.warn("collab entry hook failed", { error: String(err) });
			}
		}
	}

	#resetToNewSession(options?: NewSessionOptions, forcedSessionFile?: string): string | undefined {
		this.#diskTail = Promise.resolve();
		this.#clearDiskError();
		this.#setSessionId(mintSessionId());
		this.#sessionName = undefined;
		this.#titleSource = undefined;
		this.#titleUpdatedAt = "";
		this.#hasTitleSlot = true;

		const timestamp = nowIso();
		this.#header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.#sessionId,
			timestamp,
			cwd: this.#cwd,
			parentSession: options?.parentSession,
			providerPromptCacheKey: options?.providerPromptCacheKey,
		};
		this.#titleUpdatedAt = timestamp;

		this.#entries = [];
		this.#index.clear();
		this.#forgetForeignWriter();
		this.#nextSequence = 1;
		this.#lifecycleStarted = false;
		this.#lifecycleEnded = false;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = false;
		this.#forceFileCreation = false;
		this.#draftOnlySessionCleanupArmed = false;
		this.#turnBudgetTotal = null;
		this.#turnBudgetHard = false;
		this.#turnOutputBaseline = 0;
		this.#turnEvalOutput = 0;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = null;
		this.#inMemoryArtifacts = null;
		this.#inMemoryArtifactCounter = 0;

		if (this.#persist) {
			this.#sessionFile =
				forcedSessionFile ??
				path.join(this.#sessionDir, sessionFileName(`${fileSafeTimestamp(timestamp)}_${this.#sessionId}`));
			this.#rememberBreadcrumb(this.#cwd, this.#sessionFile);
		} else {
			this.#sessionFile = undefined;
		}

		return this.#sessionFile;
	}

	#applyEntries(header: SessionHeader, entries: SessionEntry[]): void {
		this.#header = header;
		this.#entries = entries;
		this.#setSessionId(header.id);
		this.#sessionName = header.title;
		this.#titleSource = header.titleSource;
		this.#titleUpdatedAt = header.timestamp;
		this.#index.rebuild(entries);
		this.#nextSequence = nextSessionSequence(entries);
		this.#lifecycleStarted = false;
		this.#lifecycleEnded = false;
		// Every loaded id is ours from here on, including one a later rewrite drops
		// on purpose: that is what keeps the foreign-line merge from resurrecting it.
		for (const entry of entries) this.#noteIdSeen(entry.id);
		this.#noteIdSeen(header.id);
	}

	#allocateSequence(): number {
		assertSessionSequence(this.#nextSequence);
		return this.#nextSequence++;
	}

	#freshEntryFields(): { id: string; parentId: string | null; timestamp: string; sequence?: number } {
		const sequence = allowsSessionTelemetry(this.#instrumentation, "lifecycle")
			? this.#allocateSequence()
			: undefined;
		return {
			id: generateId(this.#index),
			parentId: this.#index.leafId(),
			timestamp: nowIso(),
			sequence,
		};
	}

	#recordEntry(entry: SessionEntry): void {
		if (allowsSessionTelemetry(this.#instrumentation, "lifecycle")) {
			if (entry.sequence === undefined) {
				entry.sequence = this.#allocateSequence();
			} else {
				assertSessionSequence(entry.sequence);
				this.#nextSequence = Math.max(this.#nextSequence, entry.sequence + 1);
			}
		}
		this.#noteIdSeen(entry.id);
		this.#entries.push(entry);
		this.#index.insert(entry);
		this.#appendToSessionFile(entry);
		this.#notifyEntryAppended(entry);
	}

	#startLifecycle(reason: Extract<SessionLifecycleReason, "created" | "resumed">): void {
		const instrumentationLevel = this.#instrumentation;
		if (
			!allowsSessionTelemetry(instrumentationLevel, "lifecycle") ||
			instrumentationLevel === undefined ||
			instrumentationLevel === "off" ||
			this.#lifecycleStarted
		)
			return;
		const entry: SessionLifecycleEntry = {
			type: "session_lifecycle",
			...this.#freshEntryFields(),
			state: "running",
			reason,
			instrumentationLevel,
		};
		this.#recordEntry(entry);
		this.#lifecycleStarted = true;
		this.#lifecycleEnded = false;
	}

	#endLifecycle(
		reason: Extract<
			SessionLifecycleReason,
			"closed" | "new_session" | "session_switched" | "instrumentation_disabled" | "instrumentation_changed"
		>,
	): void {
		if (
			!allowsSessionTelemetry(this.#instrumentation, "lifecycle") ||
			!this.#lifecycleStarted ||
			this.#lifecycleEnded
		)
			return;
		const entry: SessionLifecycleEntry = {
			type: "session_lifecycle",
			...this.#freshEntryFields(),
			state: "ended",
			reason,
		};
		this.#recordEntry(entry);
		this.#lifecycleEnded = true;
	}

	#draftPath(): string | null {
		const artifactsDir = this.getArtifactsDir();
		return artifactsDir ? path.join(artifactsDir, "draft.txt") : null;
	}

	#draftOnlySessionMarkerPath(): string | null {
		const artifactsDir = this.getArtifactsDir();
		return artifactsDir ? path.join(artifactsDir, DRAFT_ONLY_SESSION_MARKER) : null;
	}

	// `=== "present"` because a `true` here ARMS the cleanup that deletes the session on close.
	// Only a marker this manager can actually see may do that, so an unreachable artifacts
	// directory answers `false` and the session is kept, which is the same direction
	// `#dropIfEmptyAndNoDraft` takes for the draft itself: not knowing means keep. The state
	// probe reports the unreachable case instead of letting it read as "no marker was written".
	#hasDraftOnlySessionMarker(): boolean {
		const markerPath = this.#draftOnlySessionMarkerPath();
		return markerPath !== null && this.#storage.existsStateSync(markerPath) === "present";
	}

	async #writeDraftOnlySessionMarker(): Promise<void> {
		const markerPath = this.#draftOnlySessionMarkerPath();
		if (!markerPath) return;
		await this.#storage.writeText(markerPath, "");
	}

	async #clearDraftOnlySessionMarker(): Promise<void> {
		const markerPath = this.#draftOnlySessionMarkerPath();
		if (!markerPath) return;
		try {
			await this.#storage.unlink(markerPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}

	#artifactManagerForSession(): ArtifactManager | null {
		if (this.#adoptedArtifactManager) return this.#adoptedArtifactManager;

		const sessionFile = this.#sessionFile;
		if (!sessionFile) {
			this.#artifactManager = null;
			this.#artifactManagerSessionFile = null;
			return null;
		}

		if (this.#artifactManager && this.#artifactManagerSessionFile === sessionFile) return this.#artifactManager;

		this.#artifactManager = new ArtifactManager(sessionFileStem(sessionFile));
		this.#artifactManagerSessionFile = sessionFile;
		return this.#artifactManager;
	}

	#notifySessionNameListeners(): void {
		for (const callback of [...this.#sessionNameChangedCallbacks]) {
			try {
				callback();
			} catch (err) {
				logger.warn("SessionManager: session name change hook failed", { error: String(err) });
			}
		}
	}

	#notifyCwdListeners(previous: string, next: string): void {
		for (const callback of [...this.#cwdChangedCallbacks]) {
			try {
				callback(previous, next);
			} catch (err) {
				logger.warn("SessionManager: cwd change hook failed", { error: String(err) });
			}
		}
	}

	static #cleanTitle(raw: string): string {
		return raw
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			.replace(/ +/g, " ")
			.trim();
	}

	/** Puts a binary blob into the blob store and returns the blob reference. */
	async putBlob(data: Buffer, options?: BlobPutOptions): Promise<BlobPutResult> {
		return this.#blobs.put(data, options);
	}

	/** Synchronous variant of {@link putBlob} for rebuild-only render paths. */
	putBlobSync(data: Buffer, options?: BlobPutOptions): BlobPutResult {
		return this.#blobs.putSync(data, options);
	}

	captureState(): SessionManagerStateSnapshot {
		return {
			cwd: this.#cwd,
			sessionDir: this.#sessionDir,
			sessionId: this.#sessionId,
			sessionName: this.#sessionName,
			titleSource: this.#titleSource,
			titleUpdatedAt: this.#titleUpdatedAt,
			hasTitleSlot: this.#hasTitleSlot,
			sessionFile: this.#sessionFile,
			onDisk: this.#fileIsCurrent,
			needsRewrite: this.#rewriteRequired,
			draftOnlySessionCleanupArmed: this.#draftOnlySessionCleanupArmed,
			nextSequence: this.#nextSequence,
			lifecycleStarted: this.#lifecycleStarted,
			lifecycleEnded: this.#lifecycleEnded,
			// Snapshot header + entries by reference: switch/reload replaces the
			// active header/array wholesale, so rollback needs no deep clone.
			header: this.#header,
			entries: [...this.#entries],
		};
	}

	restoreState(snapshot: SessionManagerStateSnapshot): void {
		this.#closeWriterEventually();
		this.#diskTail = Promise.resolve();
		this.#clearDiskError();

		// Resolved like every other write to this field. A snapshot normally round-trips a value that
		// was already absolute, but it is plain data a caller can build, and this is the one assignment
		// here that takes a cwd from outside the class.
		this.#cwd = path.resolve(snapshot.cwd);
		this.#sessionDir = snapshot.sessionDir;
		this.#sessionFile = snapshot.sessionFile;
		this.#fileIsCurrent = snapshot.onDisk;
		this.#rewriteRequired = snapshot.needsRewrite;
		this.#forceFileCreation = snapshot.onDisk;
		this.#draftOnlySessionCleanupArmed = snapshot.draftOnlySessionCleanupArmed;
		this.#applyEntries(snapshot.header, [...snapshot.entries]);
		this.#forgetForeignWriter();
		this.#nextSequence = snapshot.nextSequence;
		this.#lifecycleStarted = snapshot.lifecycleStarted;
		this.#lifecycleEnded = snapshot.lifecycleEnded;
		this.#sessionName = snapshot.sessionName;
		this.#titleSource = snapshot.titleSource;
		this.#titleUpdatedAt = snapshot.titleUpdatedAt;
		this.#hasTitleSlot = snapshot.hasTitleSlot;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = null;

		if (this.#sessionFile) this.#rememberBreadcrumb(this.#cwd, this.#sessionFile);
	}

	/** Switch to a different session file (resume / branch). */
	async setSessionFile(sessionFile: string): Promise<void> {
		const resolvedSessionFile = path.resolve(sessionFile);
		const titleSlot = await readTitleSlotFromFile(resolvedSessionFile, this.#storage);
		const fileEntries = await loadEntriesFromFile(resolvedSessionFile, this.#storage, {
			operatorNotices: this.#operatorNotices,
		});
		let migrated = false;
		let header: SessionHeader | undefined;
		let adoptedCwd: string | undefined;
		if (fileEntries.length > 0) {
			migrated = migrateToCurrentVersion(fileEntries);
			await resolveBlobRefsInEntries(fileEntries, this.#blobs);
			// loadEntriesFromFile guarantees entries[0] is a valid session header.
			header = fileEntries[0] as SessionHeader;
			const headerCwd = header.cwd ? path.resolve(header.cwd) : undefined;
			if (headerCwd && headerCwd !== path.resolve(this.#cwd) && (await directoryExists(headerCwd))) {
				adoptedCwd = headerCwd;
			}
		}

		// Everything above is read-only preparation. Commit the identity switch
		// only after the target has loaded and validated successfully, so a failed
		// switch cannot append a terminal lifecycle record to the current file.
		this.#endLifecycle("session_switched");
		await this.#drainAndCloseWriter();
		this.#clearDiskError();
		this.#draftOnlySessionCleanupArmed = false;
		this.#sessionFile = resolvedSessionFile;
		this.#rememberBreadcrumb(this.#cwd, resolvedSessionFile);

		if (!header) {
			// Explicit but empty/missing path (e.g. --session flag): start fresh but
			// keep the requested path and materialize the header immediately.
			this.#resetToNewSession(undefined, resolvedSessionFile);
			this.#startLifecycle("created");
			this.#forceFileCreation = true;
			await this.#rewriteAtomically();
			this.#fileIsCurrent = true;
			return;
		}

		// Adopt the loaded session's working directory only when it still exists.
		if (adoptedCwd) {
			this.#cwd = adoptedCwd;
			this.#sessionDir = path.dirname(resolvedSessionFile);
			this.#sessionDirPinned = false;
			this.#rememberBreadcrumb(this.#cwd, resolvedSessionFile);
		}

		this.#applyEntries(header, fileEntries.slice(1) as SessionEntry[]);
		this.#forgetForeignWriter();
		this.#titleUpdatedAt = titleSlot?.updatedAt ?? header.timestamp;
		this.#hasTitleSlot = titleSlot !== undefined;
		this.#fileIsCurrent = true;
		this.#rewriteRequired = migrated;
		this.#forceFileCreation = true;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;

		if (this.sanitizeLoadedOpenAIResponsesReplayMetadata()) this.#rewriteRequired = true;
		this.#startLifecycle("resumed");
	}

	/** Start a new session. Drains and closes any existing writer first. */
	async newSession(options?: NewSessionOptions): Promise<string | undefined> {
		this.#endLifecycle("new_session");
		await this.#drainAndCloseWriter();
		const sessionFile = this.#resetToNewSession(options);
		this.#startLifecycle("created");
		return sessionFile;
	}

	/** Delete a session file and its artifact directory. ENOENT is treated as success. */
	async dropSession(sessionPath: string): Promise<void> {
		await this.#drainAndCloseWriter();
		try {
			await this.#storage.deleteSessionWithArtifacts(sessionPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}

	/**
	 * Fork the current conversation into a new file with fresh lifecycle metadata.
	 * @returns the old and new session file paths, or undefined when not persisting.
	 */
	async fork(): Promise<{ oldSessionFile: string; newSessionFile: string } | undefined> {
		if (!this.#persist || !this.#sessionFile) return undefined;

		const oldSessionFile = this.#sessionFile;
		const parentSessionId = this.#sessionId;
		this.#endLifecycle("session_switched");
		await this.#drainAndCloseWriter();
		this.#clearDiskError();
		this.#entries = this.#entries.filter(entry => !isSessionIncarnationTelemetry(entry));
		this.#index.rebuild(this.#entries);

		const timestamp = nowIso();
		this.#setSessionId(mintSessionId());
		this.#sessionFile = path.join(
			this.#sessionDir,
			sessionFileName(`${fileSafeTimestamp(timestamp)}_${this.#sessionId}`),
		);
		this.#header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.#sessionId,
			title: this.#header.title ?? this.#sessionName,
			titleSource: this.#header.titleSource ?? this.#titleSource,
			timestamp,
			cwd: this.#cwd,
			parentSession: parentSessionId,
			providerPromptCacheKey: this.#header.providerPromptCacheKey ?? parentSessionId,
		};
		this.#sessionName = this.#header.title;
		this.#titleSource = this.#header.titleSource;
		this.#titleUpdatedAt = timestamp;
		this.#hasTitleSlot = true;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = false;
		this.#forceFileCreation = true;
		this.#draftOnlySessionCleanupArmed = false;
		this.#nextSequence = nextSessionSequence(this.#entries);
		this.#lifecycleStarted = false;
		this.#lifecycleEnded = false;
		this.#startLifecycle("created");
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#rememberBreadcrumb(this.#cwd, this.#sessionFile);

		// A new file, so another writer's tail on the old one is not ours to carry,
		// and the history we brought along is.
		this.#forgetForeignWriter();
		await this.#rewriteAtomically();
		return { oldSessionFile, newSessionFile: this.#sessionFile };
	}

	/**
	 * Move the session to a new working directory: relocate the session file and
	 * artifacts on disk, update internal references, and rewrite the header cwd.
	 */
	async moveTo(newCwd: string, targetSessionDir?: string): Promise<void> {
		// Same single-authority rule as setCwd: a relative target resolves against
		// the session cwd, not `process.cwd()`. (targetSessionDir is a storage path,
		// independent of the session cwd, so it keeps the plain process-relative
		// resolve.)
		const resolvedCwd = path.resolve(this.#cwd, newCwd);
		const resolvedTargetDir = targetSessionDir ? path.resolve(targetSessionDir) : undefined;
		if (
			resolvedCwd === path.resolve(this.#cwd) &&
			(!resolvedTargetDir || resolvedTargetDir === path.resolve(this.#sessionDir))
		) {
			return;
		}

		// Where the session's files live after the move, in three cases.
		//
		// An explicit `targetSessionDir` always wins.
		//
		// Otherwise a PINNED directory stays put. The caller passed an explicit
		// `sessionDir` saying where this session's files go, and changing directory
		// does not revoke that. This case used to fall through to
		// `computeDefaultSessionDir(resolvedCwd, storage)` and redirect to the
		// GLOBAL sessions root, so a caller that had deliberately pinned session
		// storage silently had its data land somewhere else, with nothing logged.
		//
		// Everything else is derived storage, and follows the cwd. A MANAGED dir
		// (basename is the encoded cwd, so it sits inside a sessions root) is
		// re-derived under the SAME root, which keeps a session beside its siblings
		// and is what the `--resume` re-root flow depends on. A session opened from
		// an arbitrary file path re-roots into the default dir for the new cwd,
		// which is what makes `--resume` able to adopt a session whose project
		// directory was moved or renamed.
		const managedRoot = resolveManagedSessionRoot(this.#sessionDir, this.#cwd);
		const nextSessionDir =
			resolvedTargetDir ??
			(this.#sessionDirPinned
				? this.#sessionDir
				: managedRoot
					? computeDefaultSessionDir(resolvedCwd, this.#storage, managedRoot)
					: computeDefaultSessionDir(resolvedCwd, this.#storage));

		let sessionFileExisted = false;
		const previousCwd = this.#cwd;
		const previousSessionDir = this.#sessionDir;
		const previousSessionFile = this.#sessionFile;
		const previousHeaderCwd = this.#header.cwd;
		const previousArtifactManager = this.#artifactManager;
		const previousArtifactManagerSessionFile = this.#artifactManagerSessionFile;
		const previousForceFileCreation = this.#forceFileCreation;
		const previousFileIsCurrent = this.#fileIsCurrent;
		const previousRewriteRequired = this.#rewriteRequired;
		const previousDiskFailure = this.#diskFailure;
		const previousDiskFailureLogged = this.#diskFailureLogged;
		let oldSessionFile: string | undefined;
		let newSessionFile: string | undefined;
		let storageMoved = false;

		try {
			if (this.#persist && this.#sessionFile) {
				this.#storage.ensureDirSync(nextSessionDir);
				await this.#drainAndCloseWriter();
				this.#clearDiskError();

				oldSessionFile = this.#sessionFile;
				newSessionFile = path.join(nextSessionDir, path.basename(oldSessionFile));
				sessionFileExisted = this.#storage.existsStateSync(oldSessionFile) !== "absent";
				if (oldSessionFile !== newSessionFile) {
					await this.#storage.moveSessionWithArtifacts(oldSessionFile, newSessionFile);
					storageMoved = true;
				}
				this.#sessionFile = newSessionFile;
				this.#artifactManager = null;
				this.#artifactManagerSessionFile = null;
			}

			this.#cwd = resolvedCwd;
			this.#sessionDir = nextSessionDir;
			this.#header.cwd = resolvedCwd;

			// The relocation is not committed until the header naming the new cwd
			// has been published. If that final rewrite fails, the catch below
			// restores both backend paths and every in-memory authority.
			const hasAssistant = this.#historyContainsAssistantMessage();
			if (this.#persist && this.#sessionFile && (sessionFileExisted || hasAssistant)) {
				this.#forceFileCreation = true;
				await this.#rewriteAtomically();
			}
		} catch (error) {
			let rollbackError: Error | undefined;
			if (storageMoved && oldSessionFile && newSessionFile) {
				try {
					await this.#storage.moveSessionWithArtifacts(newSessionFile, oldSessionFile);
				} catch (failure) {
					rollbackError = toError(failure);
				}
			}

			this.#cwd = previousCwd;
			this.#sessionDir = previousSessionDir;
			this.#sessionFile = previousSessionFile;
			this.#header.cwd = previousHeaderCwd;
			this.#artifactManager = previousArtifactManager;
			this.#artifactManagerSessionFile = previousArtifactManagerSessionFile;
			this.#forceFileCreation = previousForceFileCreation;
			this.#fileIsCurrent = previousFileIsCurrent;
			this.#rewriteRequired = previousRewriteRequired;
			this.#diskFailure = previousDiskFailure;
			this.#diskFailureLogged = previousDiskFailureLogged;
			this.#diskTail = Promise.resolve();

			if (rollbackError) {
				throw new AggregateError([toError(error), rollbackError], "Session move and rollback failed");
			}
			throw error;
		}

		if (this.#sessionFile) this.#rememberBreadcrumb(resolvedCwd, this.#sessionFile);
	}

	/**
	 * Force the session onto disk even with no assistant message yet (ACP
	 * session/new must create a discoverable file immediately).
	 */
	async ensureOnDisk(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		this.#forceFileCreation = true;
		if (this.#fileIsCurrent && !this.#rewriteRequired) return;
		await this.#rewriteAtomically();
	}

	/** Flush pending writes. Call before switching sessions or on shutdown. */
	async flush(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		// A flush is a request to make the file match memory, so a latched fault takes
		// its attempt here instead of being rethrown at a caller who asked for the
		// opposite of a refusal.
		if (this.#retryPersistenceAfterFailure()) await this.#rewriteAtomically();
		await this.#scheduleDiskWork(async () => {
			if (this.#writer?.isOpen()) await this.#writer.flush();
		});
		// Drain any fire-and-forget backing writes (e.g. `writeTextSync` queued
		// on IndexedSessionStorage during `flushSync`) so callers relying on
		// flush() see the write durably visible to readers.
		await this.#storage.drain();
		if (this.#diskFailure) throw this.#diskFailure;
	}

	/**
	 * Synchronously makes the current append-only session durable. Avoid rewriting
	 * an already-current file: large restored sessions can contain GiB of compacted
	 * history, and Ctrl+C must not rebuild the whole JSONL string just to flush.
	 */
	flushSync(): void {
		if (!this.#persist || !this.#sessionFile) return;
		// The exit path, and the last chance the transcript gets. A latched fault takes
		// its attempt here because there is no later publish to carry the entries: the
		// divergent-file branch below writes the whole transcript, and the throw at the
		// end reports the fault only if that attempt failed as well.
		this.#retryPersistenceAfterFailure();
		if (this.#fileIsCurrent && !this.#rewriteRequired) {
			const writerError = this.#writer?.getError();
			if (writerError) throw writerError;
			return;
		}
		this.#rewriteSynchronously();
		if (this.#diskFailure) throw this.#diskFailure;
	}

	/**
	 * True when the session file holds a line this manager never wrote.
	 *
	 * The question every full-file operation has to ask before it destroys what is
	 * there, and a delete is the widest of those. It re-reads, so the answer is
	 * about the bytes on disk now rather than about the last publish, and the
	 * re-read is what tells the operator once that a second session is writing this
	 * file.
	 */
	async holdsForeignEntries(): Promise<boolean> {
		await this.#refreshForeignLines();
		return this.#foreignLines.length > 0;
	}

	/**
	 * Drop only session files that this manager saw materialized for a draft and
	 * that still contain no durable conversation or extension state. Explicit
	 * ensureOnDisk() records (ACP session/new, handoff) stay resumable.
	 */
	async #dropIfEmptyAndNoDraft(): Promise<void> {
		if (!this.#draftOnlySessionCleanupArmed) return;
		const sessionFile = this.#sessionFile;
		// `!== "present"` disarms on both absent and unreachable. Falling through is the branch that
		// DELETES, so the only state allowed to reach it is one where this manager can see the file
		// it is about to remove. An unreachable session file used to read as absent here too, which
		// happened to disarm as well; the difference now is that it is reported rather than guessed
		// right by accident.
		if (!sessionFile || this.#storage.existsStateSync(sessionFile) !== "present") {
			this.#draftOnlySessionCleanupArmed = false;
			return;
		}
		// A DRAFT MEANS KEEP THE SESSION, AND SO DOES NOT KNOWING. The draft lives in the session's
		// ARTIFACTS directory, which is a different directory from the session file, so it can be
		// unreachable while the session file beside it reads fine. With the boolean probe an unreachable
		// artifacts directory answered "no draft" and fell through to `deleteSessionWithArtifacts`, which
		// deletes the session AND the draft in it: the operator loses unsent text because a mount was
		// briefly unavailable. This is the case `pathExistsOrThrow` exists for, and the safe direction here
		// is to keep the session rather than to throw out of a close path.
		const draftPath = this.#draftPath();
		if (draftPath && this.#storage.existsStateSync(draftPath) !== "absent") return;
		if (!this.#entries.every(isDraftOnlyMetadataEntry)) {
			await this.#clearDraftOnlySessionMarker();
			this.#draftOnlySessionCleanupArmed = false;
			return;
		}
		// A DELETE IS THE WIDEST FULL-FILE OPERATION, so it asks the same question a
		// publish asks: is any line in this file not ours? A draft-only session's file
		// is the newest one in its directory, which makes it exactly the file another
		// window resumes, and this manager's own entries being draft-only says nothing
		// about the turns that window appended to it. Dropping the session then
		// deletes a real conversation, from a process that never held it and cannot
		// report the loss.
		if (await this.holdsForeignEntries()) {
			await this.#clearDraftOnlySessionMarker();
			this.#draftOnlySessionCleanupArmed = false;
			return;
		}
		try {
			await this.#storage.deleteSessionWithArtifacts(sessionFile);
			this.#fileIsCurrent = false;
			this.#forceFileCreation = false;
			this.#hasTitleSlot = false;
			this.#draftOnlySessionCleanupArmed = false;
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to drop empty session on close", { sessionFile, error: String(err) });
			}
		}
	}

	/** Flush, then close the append writer. */
	async close(): Promise<void> {
		this.#endLifecycle("closed");
		if (!this.#persist) return;
		// A fault latched earlier in the session leaves entries that reached memory and
		// never reached the file, and this is the last call that can carry them. The
		// publish is conditional on there having BEEN a fault so a session that closes
		// cleanly writes exactly what it wrote before.
		if (this.#retryPersistenceAfterFailure()) await this.#rewriteAtomically();
		await this.#scheduleDiskWork(async () => {
			const hadWriter = this.#writer !== undefined;
			await this.#closeWriterHandle();
			// `=== "present"` because `#fileIsCurrent` is a claim that the file on disk MATCHES the
			// entries in memory, and an unreachable file cannot be claimed to match anything. Leaving
			// it false costs a full rewrite on the next write, which is the cheap wrong answer; the
			// expensive one is a title patch applied to a file nobody could read.
			if (hadWriter || (this.#sessionFile && this.#storage.existsStateSync(this.#sessionFile) === "present"))
				this.#fileIsCurrent = true;
		});
		await this.#dropIfEmptyAndNoDraft();
		// Wait for any queued backing writes (IndexedSessionStorage per-path
		// tail) to become durable so a graceful shutdown does not exit while
		// a fire-and-forget publish is still on the wire.
		await this.#storage.drain();
		if (this.#diskFailure) throw this.#diskFailure;
	}

	/**
	 * The session's working directory, ALWAYS as an absolute path.
	 *
	 * The constructor resolves its seed, but nothing kept the field resolved after that, and every
	 * caller in the process reads the cwd through here: the two `ToolSession.cwd` getters in `sdk.ts`
	 * return this directly, so a relative value reached every tool at once. It surfaced as `set_cwd`
	 * answering `Session cwd is now . (previously .)` on a successful re-root, which tells the model
	 * nothing and reads as a failure, and it is the harmless-looking half of a worse one: a relative
	 * cwd makes `resolveToCwd(target, session.cwd)` rebase silently on `process.cwd()`, so the tools
	 * and the session disagree about where the session is the moment those two differ.
	 *
	 * Resolved on the way OUT as well as on the way in, so no assignment anywhere in this class can
	 * reintroduce it. `path.resolve` on an already-absolute path is a normalization, not a change.
	 */
	getCwd(): string {
		return path.resolve(this.#cwd);
	}

	/**
	 * Attach the operator-visible channel used by later session loads.
	 *
	 * Hosts that supply an already-constructed manager call this once their
	 * shared UI channel exists. Repeating the attachment is harmless and simply
	 * makes the most recent host channel authoritative.
	 */
	setOperatorNotices(operatorNotices?: OperatorNotices): void {
		this.#operatorNotices = operatorNotices;
	}

	/**
	 * Apply the canonical session telemetry granularity. Every level change
	 * closes the current measured interval before the new policy takes effect,
	 * then starts a fresh interval when telemetry remains enabled.
	 */
	setInstrumentationLevel(level: InstrumentationLevel | undefined): void {
		const previous = this.#instrumentation;
		if (previous === level) return;
		const wasEnabled = allowsSessionTelemetry(previous, "lifecycle");
		const isEnabled = allowsSessionTelemetry(level, "lifecycle");
		if (wasEnabled) {
			this.#endLifecycle(isEnabled ? "instrumentation_changed" : "instrumentation_disabled");
		}
		this.#instrumentation = level;
		if (!isEnabled) return;
		this.#nextSequence = nextSessionSequence(this.#entries);
		this.#lifecycleStarted = false;
		this.#lifecycleEnded = false;
		this.#startLifecycle(this.#entries.length === 0 ? "created" : "resumed");
	}

	/**
	 * Re-root this session's working directory in place.
	 *
	 * Unlike {@link moveTo}, this does NOT relocate session storage or artifacts —
	 * only the live session cwd (and header) change. Profile settings are never
	 * written. Validation (exists + isDirectory) is on by default.
	 */
	async setCwd(newCwd: string, options?: { validate?: boolean }): Promise<string> {
		// ONE cwd authority. A relative target resolves against THIS session's cwd,
		// never `process.cwd()`. Bare `path.resolve(newCwd)` used the OS process dir
		// as its hidden base, so a relative path validated (and, on the callers that
		// pass raw input, could move to) a DIFFERENT directory than the tools, which
		// all resolve against the session cwd via `resolveToCwd(path, session.cwd)`.
		// That split base is what let `set_cwd home/x` report "does not exist" while
		// bash/eval still ended up in the intended directory. `path.resolve(base,
		// target)` returns `target` when it is absolute (base ignored) and resolves
		// it against `base` when it is relative, which is exactly the tool contract.
		const resolvedCwd = path.resolve(this.#cwd, newCwd);
		const validate = options?.validate !== false;
		if (validate) {
			let st: fs.Stats;
			try {
				st = await fs.promises.stat(resolvedCwd);
			} catch (err) {
				if (isEnoent(err)) {
					throw new Error(`Directory does not exist: ${resolvedCwd}`);
				}
				throw new Error(`Cannot access directory ${resolvedCwd}: ${errorMessage(err)}`);
			}
			if (!st.isDirectory()) {
				throw new Error(`Not a directory: ${resolvedCwd}`);
			}
		}

		// `resolvedCwd`, not `this.#cwd`. Both sides of the comparison are resolved, so returning the
		// raw field here was the one path that could hand a caller a relative cwd it had just proved
		// was the same directory: `set_cwd /abs/path/keyhog` on a session whose field held `.` matched,
		// took this branch, and answered `Session cwd is . `, which is false twice over and reads as a
		// failed call. The declared contract is "returns the resolved absolute path" and this is the
		// same directory either way, so there is nothing to weigh.
		if (resolvedCwd === path.resolve(this.#cwd)) {
			// The field is normalized, but the header is deliberately left alone: this branch is the
			// no-move case, so there is no change to persist, and the header does not exist yet on a
			// manager that has not been initialized.
			this.#cwd = resolvedCwd;
			return resolvedCwd;
		}

		const previous = path.resolve(this.#cwd);
		const previousHeaderCwd = this.#header.cwd;
		const previousForceFileCreation = this.#forceFileCreation;
		const previousFileIsCurrent = this.#fileIsCurrent;
		const previousRewriteRequired = this.#rewriteRequired;
		const previousDiskFailure = this.#diskFailure;
		const previousDiskFailureLogged = this.#diskFailureLogged;
		this.#cwd = resolvedCwd;
		this.#header.cwd = resolvedCwd;

		// Persist the updated header cwd when a session file already exists so
		// resume/adoption sees the live root. Storage location is unchanged.
		try {
			if (this.#persist && this.#sessionFile && this.#storage.existsStateSync(this.#sessionFile) !== "absent") {
				this.#forceFileCreation = true;
				await this.#rewriteAtomically();
			}
		} catch (error) {
			// Atomic persistence leaves the old transcript intact. Restore the
			// matching in-memory authority as well, so a rejected cwd change never
			// splits live tool resolution from the resumable header.
			this.#cwd = previous;
			this.#header.cwd = previousHeaderCwd;
			this.#forceFileCreation = previousForceFileCreation;
			this.#fileIsCurrent = previousFileIsCurrent;
			this.#rewriteRequired = previousRewriteRequired;
			this.#diskFailure = previousDiskFailure;
			this.#diskFailureLogged = previousDiskFailureLogged;
			throw error;
		}

		this.#notifyCwdListeners(previous, resolvedCwd);
		return resolvedCwd;
	}

	getUsageStatistics(): UsageStatistics {
		return this.#index.usageSnapshot();
	}

	/**
	 * Open a new per-turn budget window: snapshot the cumulative output baseline,
	 * reset the eval-subagent counter, and set the (optional) ceiling.
	 */
	beginTurnBudget(total: number | null, hard: boolean): void {
		this.#turnBudgetTotal = total;
		this.#turnBudgetHard = hard;
		this.#turnOutputBaseline = this.#index.usageSnapshot().output;
		this.#turnEvalOutput = 0;
	}

	recordEvalSubagentOutput(output: number): void {
		if (Number.isFinite(output) && output > 0) this.#turnEvalOutput += output;
	}

	getTurnBudget(): { total: number | null; spent: number; hard: boolean } {
		const mainOutput = Math.max(0, this.#index.usageSnapshot().output - this.#turnOutputBaseline);
		return { total: this.#turnBudgetTotal, spent: mainOutput + this.#turnEvalOutput, hard: this.#turnBudgetHard };
	}

	getSessionDir(): string {
		return this.#sessionDir;
	}

	getSessionId(): string {
		return this.#sessionId;
	}

	/**
	 * The one place `#sessionId` is written. Every mint site goes through it so
	 * a listener cannot be bypassed by a new one.
	 */
	#setSessionId(next: string): void {
		if (this.#sessionId === next) return;
		this.#sessionId = next;
		for (const listener of this.#sessionIdListeners) listener(next);
	}

	/** Observe session-id changes. Returns the unsubscribe. */
	onSessionIdChanged(listener: (sessionId: string) => void): () => void {
		this.#sessionIdListeners.add(listener);
		return () => {
			this.#sessionIdListeners.delete(listener);
		};
	}

	getSessionFile(): string | undefined {
		return this.#sessionFile;
	}

	getArtifactsDir(): string | null {
		if (this.#adoptedArtifactManager) return this.#adoptedArtifactManager.dir;
		return artifactsDirectoryFor(this.#sessionFile);
	}

	adoptArtifactManager(manager: ArtifactManager): void {
		this.#adoptedArtifactManager = manager;
	}

	getArtifactManager(): ArtifactManager | null {
		return this.#artifactManagerForSession();
	}

	async allocateArtifactPath(toolType: string): Promise<{ id?: string; path?: string }> {
		return (await this.#artifactManagerForSession()?.allocatePath(toolType)) ?? {};
	}

	async saveArtifact(content: string, toolType: string): Promise<string | undefined> {
		const manager = this.#artifactManagerForSession();
		if (manager) return manager.save(content, toolType);

		// Non-persistent session: keep an in-memory copy so spill truncation works.
		this.#inMemoryArtifacts ??= new Map();
		const id = String(this.#inMemoryArtifactCounter++);
		this.#inMemoryArtifacts.set(id, content);
		return id;
	}

	async getArtifactPath(id: string): Promise<string | null> {
		return (await this.#artifactManagerForSession()?.getPath(id)) ?? null;
	}

	async saveDraft(text: string): Promise<void> {
		const draftPath = this.#draftPath();
		if (!draftPath || !this.#persist) return;

		if (text.length === 0) {
			try {
				await this.#storage.unlink(draftPath);
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
			return;
		}

		const sessionFile = this.#sessionFile;
		// `=== "absent"` and not `!existsSync(...)`, because this flag ARMS the cleanup that deletes
		// the session on close. The boolean answered `false` for an unreachable file, which negates
		// to `true` here: a session whose file exists and could not be reached was recorded as one
		// this draft had just brought into being, and closing then deleted a real transcript. Only a
		// file that is genuinely not there yet can make this a materialization.
		const draftWillMaterializeMetadataOnlyFile =
			sessionFile !== undefined &&
			this.#storage.existsStateSync(sessionFile) === "absent" &&
			this.#entries.every(isDraftOnlyMetadataEntry);
		// Force the header onto disk so resume can find the file this draft attaches to.
		await this.ensureOnDisk();
		if (draftWillMaterializeMetadataOnlyFile) {
			await this.#writeDraftOnlySessionMarker();
			this.#draftOnlySessionCleanupArmed = true;
		}
		await this.#storage.writeText(draftPath, text);
	}

	async consumeDraft(): Promise<string | null> {
		const draftPath = this.#draftPath();
		if (!draftPath) return null;

		let draft: string;
		try {
			draft = await this.#storage.readText(draftPath);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}

		try {
			await this.#storage.unlink(draftPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		if (this.#entries.every(isDraftOnlyMetadataEntry) && this.#hasDraftOnlySessionMarker())
			this.#draftOnlySessionCleanupArmed = true;

		return draft;
	}

	/** The source that set the session name: "user" (manual/RPC) or "auto" (generated title). */
	get titleSource(): SessionTitleSource | undefined {
		return this.#titleSource;
	}

	getSessionName(): string | undefined {
		return this.#sessionName;
	}

	onSessionNameChanged(cb: () => void): () => void {
		this.#sessionNameChangedCallbacks.add(cb);
		return () => {
			this.#sessionNameChangedCallbacks.delete(cb);
		};
	}

	onCwdChanged(cb: (previous: string, next: string) => void): () => void {
		this.#cwdChangedCallbacks.add(cb);
		return () => {
			this.#cwdChangedCallbacks.delete(cb);
		};
	}

	/**
	 * Set the session display name.
	 * @param source "user" for explicit renames; "auto" for generated titles.
	 *   Auto titles are ignored once the user has set a name.
	 */
	async setSessionName(name: string, source: SessionTitleSource = "auto", trigger?: string): Promise<boolean> {
		if (this.#titleSource === "user" && source === "auto") return false;

		const title = SessionManager.#cleanTitle(name);
		if (!title) return false;

		const previousTitle = this.#sessionName;
		const timestamp = nowIso();
		this.#sessionName = title;
		this.#titleSource = source;
		this.#titleUpdatedAt = timestamp;
		this.#header.title = title;
		this.#header.titleSource = source;

		const entry: TitleChangeEntry = {
			type: TITLE_CHANGE_ENTRY_TYPE,
			...this.#freshEntryFields(),
			timestamp,
			title,
			source,
		};
		if (previousTitle) entry.previousTitle = previousTitle;
		if (trigger) entry.trigger = trigger;
		this.#noteIdSeen(entry.id);
		this.#entries.push(entry);
		this.#index.insert(entry);
		this.#notifyEntryAppended(entry);
		await this.#persistTitleChangeEntry(entry, { title, source, updatedAt: timestamp });

		this.#notifySessionNameListeners();
		return true;
	}

	/**
	 * Append a foreign (host-authored) entry verbatim, preserving its
	 * `id`/`parentId`. Used by collab guests to mirror the host session.
	 */
	ingestReplicatedEntry(entry: SessionEntry): void {
		this.#recordEntry(entry);
	}

	/**
	 * Snapshot the session for collab replication: the live header plus a deep
	 * copy of every entry (the host mutates entries in place on rewrite paths, so
	 * guests must not share references).
	 */
	snapshotForReplication(): { header: SessionHeader; entries: SessionEntry[] } {
		return { header: structuredClone(this.#header), entries: structuredClone(this.#entries) as SessionEntry[] };
	}

	/**
	 * Append a message as a child of the current leaf, then advance the leaf.
	 * CompactionSummaryMessage / BranchSummaryMessage are rejected here — they are
	 * top-level entries via appendCompaction()/branchWithSummary().
	 */
	appendMessage(
		message:
			| Message
			| CustomMessage
			| HookMessage
			| BashExecutionMessage
			| PythonExecutionMessage
			| FileMentionMessage,
	): string {
		const entry: SessionMessageEntry = { type: "message", ...this.#freshEntryFields(), message };
		this.#recordEntry(entry);
		return entry.id;
	}

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(thinkingLevel?: string, configured?: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			...this.#freshEntryFields(),
			thinkingLevel: thinkingLevel ?? null,
			configured: configured ?? null,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	appendServiceTierChange(serviceTier: ServiceTierByFamily | null): string {
		const entry: ServiceTierChangeEntry = { type: "service_tier_change", ...this.#freshEntryFields(), serviceTier };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendModeChange(mode: string, data?: Record<string, unknown>): string {
		const entry: ModeChangeEntry = { type: "mode_change", ...this.#freshEntryFields(), mode, data };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Append a model change as a child of the current leaf, then advance the leaf.
	 * @param model Model in "provider/modelId" format
	 * @param role Optional role (default: "default")
	 */
	appendModelChange(model: string, role?: string): string {
		const entry: ModelChangeEntry = { type: "model_change", ...this.#freshEntryFields(), model, role };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendSessionInit(init: {
		systemPrompt: string;
		task: string;
		tools: string[];
		outputSchema?: unknown;
		spawns?: string;
		readSummarize?: boolean;
		maxNestedSpawnDepth?: number;
	}): string {
		const entry: SessionInitEntry = { type: "session_init", ...this.#freshEntryFields(), ...init };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Append a structured parent->child index entry recording one subagent this
	 * session spawned. The record points at the child's durable transcript and
	 * captures its task, isolation, outcome, timing, and usage so a study/backtest
	 * tool can enumerate a session's subagents without scraping tool-result prose.
	 */
	appendSubagentSpawn(record: SubagentSpawnRecord): string {
		const entry: SubagentSpawnEntry = { type: "subagent_spawn", ...this.#freshEntryFields(), ...record };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Append an effective-settings snapshot recording the resolved config that
	 * governed the run. `kind: "full"` is the complete config written at session
	 * start; `kind: "diff"` carries only keys that changed since the prior snapshot.
	 */
	appendSettingsSnapshot(values: Record<string, unknown>, kind: "full" | "diff" = "full"): string {
		const entry: SettingsSnapshotEntry = { type: "settings_snapshot", ...this.#freshEntryFields(), kind, values };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendCompaction<T = unknown>(
		summary: string,
		shortSummary: string | undefined,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromExtension?: boolean,
		preserveData?: Record<string, unknown>,
	): string {
		// Every compaction summary is retained verbatim on the active branch. Superseded
		// summaries stay out of the LLM context (buildSessionContext emits only the latest
		// compaction), but they are preserved on disk so a session can be studied in full
		// after any number of compactions.
		const entry: CompactionEntry<T> = {
			type: "compaction",
			...this.#freshEntryFields(),
			summary,
			shortSummary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromExtension,
			preserveData,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = { type: "custom", customType, data, ...this.#freshEntryFields() };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Rewrite the session file after in-place entry updates (e.g. pruning old tool
	 * outputs). Use sparingly.
	 */
	async rewriteEntries(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		await this.#rewriteAtomically();
	}

	/**
	 * Append a custom message entry (for extensions) that participates in LLM context.
	 * @param customType Hook identifier for filtering on reload
	 * @param content Message content (string or TextContent/ImageContent array)
	 * @param display Whether to show in TUI (true = styled display, false = hidden)
	 * @param details Optional extension-specific metadata (not sent to LLM)
	 * @param attribution Who initiated this message for billing/attribution semantics
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string | undefined,
		content: string | (TextContent | ImageContent)[] | undefined,
		display: boolean | undefined,
		details?: T,
		attribution: MessageAttribution | undefined = "agent",
	): string {
		const normalized = normalizeCustomMessagePayload<T>({ customType, content, display, details, attribution });
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType: normalized.customType,
			content: normalized.content,
			display: normalized.display,
			// Drop AgentSession-internal transient fields before disk persistence.
			details: stripInternalDetailsFields(normalized.details),
			attribution: normalized.attribution,
			...this.#freshEntryFields(),
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Append an MCP tool selection entry recording the discovery-selected MCP tools.
	 */
	appendMCPToolSelection(selectedToolNames: string[]): string {
		const entry: MCPToolSelectionEntry = {
			type: "mcp_tool_selection",
			...this.#freshEntryFields(),
			selectedToolNames: [...selectedToolNames],
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/** Append a TTSR injection entry recording which rules were injected. */
	appendTtsrInjection(ruleNames: string[]): string {
		const entry: TtsrInjectionEntry = {
			type: "ttsr_injection",
			...this.#freshEntryFields(),
			injectedRules: [...ruleNames],
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/** All unique TTSR rule names injected on the current branch (root → leaf). */
	getInjectedTtsrRules(): string[] {
		const names = new Set<string>();
		for (const entry of this.getBranch()) {
			if (entry.type !== "ttsr_injection") continue;
			for (const name of entry.injectedRules) names.add(name);
		}
		return [...names];
	}

	getLeafId(): string | null {
		return this.#index.leafId();
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.#index.leafEntry();
	}

	/**
	 * The most recent model role on the current branch, or undefined when no
	 * model change has been recorded.
	 */
	getLastModelChangeRole(): string | undefined {
		const branch = this.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type === "model_change") return entry.role ?? "default";
		}
		return undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.#index.get(id);
	}

	/** All direct children of an entry. */
	getChildren(parentId: string): SessionEntry[] {
		return this.#index.childrenOf(parentId);
	}

	getLabel(id: string): string | undefined {
		return this.#index.labelFor(id);
	}

	/**
	 * Set or clear a label on an entry. Pass undefined/empty to clear.
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.#index.has(targetId)) throw new Error(`Entry ${targetId} not found`);

		const entry: LabelEntry = { type: "label", ...this.#freshEntryFields(), targetId, label };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Walk from an entry to root, returning entries in path order. Includes all
	 * entry types; use buildSessionContext() for the resolved LLM messages.
	 */
	getBranch(fromId?: string): SessionEntry[] {
		return this.#index.pathTo(fromId ?? this.#index.leafId());
	}

	/**
	 * Build the session context (LLM messages), or — with `{ transcript: true }` —
	 * the full-history display transcript, from the current leaf path.
	 */
	buildSessionContext(options?: BuildSessionContextOptions): SessionContext {
		return buildSessionContext(this.#entries, this.#index.leafId(), this.#index.entriesById(), options);
	}

	/** Strip stale OpenAI Responses assistant replay metadata from loaded entries. */
	sanitizeLoadedOpenAIResponsesReplayMetadata(): boolean {
		let changed = false;
		for (const entry of this.#entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;

			const sanitized = sanitizeRehydratedOpenAIResponsesAssistantMessage(entry.message);
			if (sanitized === entry.message) continue;

			entry.message = sanitized;
			changed = true;
		}

		return changed;
	}

	getHeader(): SessionHeader | null {
		return this.#header;
	}

	/** All session entries (excludes header). Returns a shallow copy. */
	getEntries(): SessionEntry[] {
		return [...this.#entries];
	}

	/** Latest persisted lifecycle state, or `unknown` for old/off files. */
	getLifecycleState(): SessionLifecycleState | "unknown" {
		for (let index = this.#entries.length - 1; index >= 0; index--) {
			const entry = this.#entries[index];
			if (entry?.type === "session_lifecycle") return entry.state;
		}
		return "unknown";
	}

	/**
	 * Append an immutable marker naming the exact entry prefix that exists now.
	 * Later appends cannot move the marker or change its frozen prefix.
	 */
	createCheckpoint(): SessionCheckpoint | null {
		if (!allowsSessionTelemetry(this.#instrumentation, "lifecycle") || this.#lifecycleEnded) return null;
		const prefixSequence = this.#nextSequence - 1;
		const entry: SessionCheckpointEntry = {
			type: "session_checkpoint",
			...this.#freshEntryFields(),
			prefixSequence,
		};
		this.#recordEntry(entry);
		return { id: entry.id, prefixSequence };
	}

	/**
	 * Resolve a checkpoint to the immutable prefix preceding its marker.
	 * The marker id, rather than the current tail, is the boundary.
	 */
	getEntriesThroughCheckpoint(checkpoint: SessionCheckpoint | string): SessionEntry[] {
		const checkpointId = typeof checkpoint === "string" ? checkpoint : checkpoint.id;
		const index = this.#entries.findIndex(
			(entry): entry is SessionCheckpointEntry => entry.type === "session_checkpoint" && entry.id === checkpointId,
		);
		if (index < 0) throw new Error(`Session checkpoint ${checkpointId} not found`);
		const entry = this.#entries[index] as SessionCheckpointEntry;
		if (typeof checkpoint !== "string" && entry.prefixSequence !== checkpoint.prefixSequence) {
			throw new Error(`Session checkpoint ${checkpointId} identity does not match`);
		}
		return this.#entries.slice(0, index);
	}

	/**
	 * The session as a tree. A well-formed session has exactly one root; orphaned
	 * entries (broken parent chain) are returned as roots too.
	 */
	getTree(): SessionTreeNode[] {
		return this.#index.tree(this.#entries);
	}

	/**
	 * Move the leaf to an earlier entry so the next append forms a new branch.
	 * Existing entries are never modified or deleted.
	 */
	branch(branchFromId: string): void {
		if (!this.#index.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
		this.#index.setLeaf(branchFromId);
	}

	/** Reset the leaf to null so the next append creates a new root entry. */
	resetLeaf(): void {
		this.#index.setLeaf(null);
	}

	/** Like branch(), but also records a branch_summary of the abandoned path. */
	branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromExtension?: boolean): string {
		if (branchFromId !== null && !this.#index.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);

		this.#index.setLeaf(branchFromId);
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.#index),
			parentId: branchFromId,
			timestamp: nowIso(),
			fromId: branchFromId ?? "root",
			summary,
			details,
			fromExtension,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Create a new session file containing only the path from root to `leafId`.
	 * Returns the new file path, or undefined when not persisting.
	 */
	createBranchedSession(leafId: string): string | undefined {
		const sourceSessionFile = this.#sessionFile;
		if (!this.#index.has(leafId)) throw new Error(`Entry ${leafId} not found`);
		this.#endLifecycle("session_switched");
		const branchPath = this.getBranch(leafId);

		// Labels are resolved afresh, and lifecycle/checkpoint entries belong to
		// the source session identity rather than the child.
		const entriesToKeep = branchPath.filter(entry => entry.type !== "label" && !isSessionIncarnationTelemetry(entry));
		const keptIds = new Set(entriesToKeep.map(entry => entry.id));
		const labelsToCarry: Array<{ targetId: string; label: string }> = [];
		for (const [targetId, label] of this.#index.labelsInEffect()) {
			if (keptIds.has(targetId)) labelsToCarry.push({ targetId, label });
		}

		const timestamp = nowIso();
		const newSessionId = mintSessionId();
		const newSessionFile = path.join(
			this.#sessionDir,
			sessionFileName(`${fileSafeTimestamp(timestamp)}_${newSessionId}`),
		);
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.#cwd,
			parentSession: this.#persist ? sourceSessionFile : undefined,
			// A branch keeps `entriesToKeep`, a genuine prefix of the source
			// conversation, so the provider prefix cache the source populated is
			// still valid for it. Carry the source's cache identity forward the
			// same way `fork()` does; without it the reminted session id becomes a
			// brand-new `prompt_cache_key` and the first post-branch turn pays a
			// full uncached prefill of the entire retained history.
			providerPromptCacheKey: this.#header.providerPromptCacheKey ?? this.#sessionId,
		};

		const labels: LabelEntry[] = [];
		let parentId = entriesToKeep[entriesToKeep.length - 1]?.id ?? null;
		for (const carried of labelsToCarry) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...keptIds, ...labels.map(entry => entry.id)])),
				parentId,
				timestamp: nowIso(),
				targetId: carried.targetId,
				label: carried.label,
			};
			labels.push(labelEntry);
			parentId = labelEntry.id;
		}

		this.#header = header;
		this.#entries = [...entriesToKeep, ...labels];
		this.#setSessionId(newSessionId);
		this.#sessionName = header.title;
		this.#titleSource = header.titleSource;
		this.#titleUpdatedAt = timestamp;
		this.#hasTitleSlot = true;
		this.#index.rebuild(this.#entries);
		// A branch is a new file holding a prefix of the source: the source's foreign
		// tail stays behind, and the prefix we kept is ours here.
		this.#forgetForeignWriter();
		this.#nextSequence = nextSessionSequence(this.#entries);
		this.#lifecycleStarted = false;
		this.#lifecycleEnded = false;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#forceFileCreation = this.#persist;

		if (!this.#persist) {
			this.#sessionFile = undefined;
			this.#fileIsCurrent = false;
			this.#rewriteRequired = false;
			this.#startLifecycle("created");
			return undefined;
		}

		this.#sessionFile = newSessionFile;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = true;
		this.#startLifecycle("created");
		if (!this.#lifecycleStarted) this.#rewriteSynchronously();
		this.#rememberBreadcrumb(this.#cwd, newSessionFile);
		return newSessionFile;
	}

	/** Resolve the canonical default session directory for a cwd. */
	static getDefaultSessionDir(
		cwd: string,
		agentDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): string {
		return computeDefaultSessionDir(cwd, storage, getSessionsDir(agentDir));
	}

	/**
	 * Create a new session.
	 * @param cwd Working directory (stored in the session header)
	 * @param sessionDir Optional session directory; defaults to the cwd-derived dir.
	 */
	/**
	 * Start a fresh session at `cwd`.
	 *
	 * `sessionDir` pins where this session's files live. It is honoured for the
	 * life of the session: {@link moveTo} re-derives a cwd-encoded directory only
	 * when the current one sits inside a sessions root, so a pinned directory
	 * stays pinned across a cwd change rather than being redirected to the global
	 * sessions root.
	 */
	static create(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		options?: SessionManagerNoticeOptions,
	): SessionManager {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const manager = new SessionManager(
			cwd,
			dir,
			true,
			storage,
			sessionDir !== undefined,
			options?.operatorNotices,
			options?.instrumentation,
		);
		manager.#resetToNewSession();
		manager.#startLifecycle("created");
		return manager;
	}

	/**
	 * Create a fresh empty session file in the default session directory for
	 * `cwd`, writing only the session header. The returned path can be passed to
	 * `setSessionFile` / `AgentSession.switchSession` when a caller explicitly
	 * needs a brand-new persisted session at a cwd-derived path.
	 */
	static createEmptySessionFile(cwd: string, storage: SessionStorage = new FileSessionStorage()): string {
		const sessionDir = SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const id = mintSessionId();
		const timestamp = nowIso();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id,
			timestamp,
			cwd: path.resolve(cwd),
		};
		const file = path.join(sessionDir, sessionFileName(`${fileSafeTimestamp(timestamp)}_${id}`));
		storage.writeTextSync(file, `${serializeTitleSlot({ updatedAt: timestamp })}${JSON.stringify(header)}\n`);
		return file;
	}

	/**
	 * Fork a session into the current project directory: copy history from another
	 * session file while creating a fresh session file in this sessionDir.
	 *
	 * `options.sessionFile` pins the new session's file path (default: an
	 * auto-named `<timestamp>_<id>.jsonl` in `sessionDir`). Callers that register
	 * the fork as a named agent (e.g. `/tan`) pass `<agentId>.jsonl` so the
	 * persisted-subagent scan keys the agent by the same id the live ref uses.
	 */
	static async forkFrom(
		sourcePath: string,
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		options?: {
			suppressBreadcrumb?: boolean;
			sessionFile?: string;
			operatorNotices?: OperatorNotices;
			instrumentation?: InstrumentationLevel;
		},
	): Promise<SessionManager> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const manager = new SessionManager(
			cwd,
			dir,
			true,
			storage,
			sessionDir !== undefined,
			options?.operatorNotices,
			options?.instrumentation,
		);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;

		const sourceEntries = structuredClone(
			await loadEntriesFromFile(sourcePath, storage, { operatorNotices: options?.operatorNotices }),
		) as FileEntry[];
		migrateToCurrentVersion(sourceEntries);
		await resolveBlobRefsInEntries(sourceEntries, manager.#blobs);

		const sourceHeader = sourceEntries.find(entry => entry.type === "session") as SessionHeader | undefined;
		const history = sourceEntries.filter((entry): entry is SessionEntry => {
			if (!("parentId" in entry)) return false;
			return !isSessionIncarnationTelemetry(entry);
		});
		manager.#resetToNewSession(
			{
				parentSession: sourceHeader?.id,
				providerPromptCacheKey: sourceHeader?.providerPromptCacheKey ?? sourceHeader?.id,
			},
			options?.sessionFile,
		);
		manager.#header.title = sourceHeader?.title;
		manager.#header.titleSource = sourceHeader?.titleSource;
		manager.#sessionName = manager.#header.title;
		manager.#titleSource = manager.#header.titleSource;
		manager.#titleUpdatedAt = nowIso();
		manager.#hasTitleSlot = true;
		manager.#applyEntries(manager.#header, history);
		manager.sanitizeLoadedOpenAIResponsesReplayMetadata();
		manager.#startLifecycle("created");
		manager.#forceFileCreation = true;
		await manager.#rewriteAtomically();
		return manager;
	}

	/**
	 * Open a specific session file.
	 * @param sessionDir Optional dir for /new or /branch; defaults to the file's parent.
	 * @param options.initialCwd Cwd to use when the file is empty or missing.
	 */
	static async open(
		filePath: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		options?: {
			initialCwd?: string;
			suppressBreadcrumb?: boolean;
			operatorNotices?: OperatorNotices;
			instrumentation?: InstrumentationLevel;
		},
	): Promise<SessionManager> {
		const loaded = await loadEntriesFromFile(filePath, storage, { operatorNotices: options?.operatorNotices });
		const header = loaded.find(entry => entry.type === "session") as SessionHeader | undefined;
		// Resume into the session's recorded cwd only when that directory still
		// exists. A deleted project dir would make the constructor's #cwd — and the
		// `setProjectDir` chdir interactive mode runs next — point at (and fail on)
		// a missing path, so fall back to the launch cwd and anchor /new and /branch
		// there too, keeping the resumed session where the user already is.
		const recordedCwd = header?.cwd;
		const recordedCwdUsable = !!recordedCwd && (await directoryExists(recordedCwd));
		const cwd = recordedCwdUsable ? recordedCwd : (options?.initialCwd ?? getProjectDir());
		const dir =
			sessionDir ??
			(recordedCwd && !recordedCwdUsable
				? SessionManager.getDefaultSessionDir(cwd, undefined, storage)
				: path.dirname(path.resolve(filePath)));
		const manager = new SessionManager(
			cwd,
			dir,
			true,
			storage,
			sessionDir !== undefined,
			options?.operatorNotices,
			options?.instrumentation,
		);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;
		await manager.setSessionFile(filePath);
		return manager;
	}

	/**
	 * Lock-free peek for cold subagent revival: returns the recorded working
	 * directory (session header) and the latest `session_init` contract (system
	 * prompt / tools / output schema) WITHOUT taking the single-writer lock that
	 * {@link open} acquires — the caller re-opens for the actual revive. Returns
	 * null when the file can't be read, and reports it first unless the file is
	 * simply absent, so an unreadable session is not silently a missing one;
	 * `init` is null for files written before `session_init` was recorded (no
	 * faithful contract to rebuild from).
	 */
	static async peekSessionInit(
		filePath: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<{
		cwd: string;
		init: {
			systemPrompt: string;
			task: string;
			tools: string[];
			outputSchema?: unknown;
			spawns?: string;
			readSummarize?: boolean;
			maxNestedSpawnDepth?: number;
		} | null;
	} | null> {
		let loaded: FileEntry[];
		try {
			loaded = await loadEntriesFromFile(filePath, storage);
		} catch (err) {
			// A session file that is not there is a normal miss and the caller says so. A file that IS
			// there and could not be loaded is a different fact, and returning the same null told the
			// user their session did not exist when it did.
			if (!isEnoent(err)) {
				logger.warn("Session file exists but could not be loaded; treating it as missing", {
					path: filePath,
					error: errorMessage(err),
				});
			}
			return null;
		}
		// A missing/empty file has no usable session — nothing to revive from.
		if (loaded.length === 0) return null;
		const header = loaded.find(entry => entry.type === "session") as SessionHeader | undefined;
		let init: {
			systemPrompt: string;
			task: string;
			tools: string[];
			outputSchema?: unknown;
			spawns?: string;
			readSummarize?: boolean;
			maxNestedSpawnDepth?: number;
		} | null = null;
		for (let index = loaded.length - 1; index >= 0; index--) {
			const entry = loaded[index];
			if (entry.type === "session_init") {
				init = {
					systemPrompt: entry.systemPrompt,
					task: entry.task,
					tools: entry.tools,
					outputSchema: entry.outputSchema,
					readSummarize: entry.readSummarize,
					spawns: entry.spawns,
					maxNestedSpawnDepth: entry.maxNestedSpawnDepth,
				};
				break;
			}
		}
		return { cwd: header?.cwd ?? getProjectDir(), init };
	}

	/** Continue the most recent session, or create a new one if none exists. */
	static async continueRecent(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		options?: SessionManagerNoticeOptions,
	): Promise<SessionManager> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const resolvedCwd = path.resolve(cwd);
		const breadcrumb = await readTerminalBreadcrumbEntry();
		let chosenSession: string | null | undefined;

		if (breadcrumb) {
			// Recover stale crumbs: a subagent open (pre-fix) may have pointed this
			// terminal's breadcrumb at an artifact child; resume the parent instead.
			breadcrumb.sessionFile = resolveBreadcrumbToInteractiveRoot(breadcrumb.sessionFile);
			const breadcrumbCwd = path.resolve(breadcrumb.cwd);
			if (breadcrumbCwd === resolvedCwd) {
				chosenSession = breadcrumb.sessionFile;
			} else {
				// The terminal's last session started in a different cwd. If that cwd is
				// gone (worktree move/rename) and this location has no sessions of its
				// own, re-root the moved session here instead of starting fresh. When an
				// explicit sessionDir is reused across the move, the stale breadcrumb file
				// may be the newest entry there; prefer a genuine current-cwd session.
				let newestInTargetDir = await findMostRecentSession(dir, storage);
				const breadcrumbFile = path.resolve(breadcrumb.sessionFile);
				// `=== "absent"` because "missing" here means the worktree was moved or renamed, and
				// that conclusion RE-ROOTS a session into a different directory. `existsSync` answered
				// `false` for a cwd that exists and cannot be reached (an unmounted network project, a
				// directory whose permissions changed), so a temporarily unavailable project read as a
				// deleted one and the terminal's session was adopted somewhere else. Not knowing is not
				// the same as gone.
				const breadcrumbCwdMissing = pathStateSync(breadcrumbCwd) === "absent";
				const newestIsBreadcrumb = newestInTargetDir ? path.resolve(newestInTargetDir) === breadcrumbFile : false;
				let currentProjectAlreadyHasSession = false;

				if (breadcrumbCwdMissing && newestIsBreadcrumb) {
					const localSession = (await SessionManager.list(cwd, dir, storage)).find(
						session =>
							path.resolve(session.path) !== breadcrumbFile &&
							session.cwd &&
							path.resolve(session.cwd) === resolvedCwd,
					);
					if (localSession) {
						newestInTargetDir = localSession.path;
						currentProjectAlreadyHasSession = true;
					}
				}

				const looksLikeMovedProject =
					breadcrumbCwdMissing &&
					(newestInTargetDir === null || (newestIsBreadcrumb && !currentProjectAlreadyHasSession));
				if (looksLikeMovedProject) {
					logger.info("Re-rooting moved session", { from: breadcrumbCwd, to: resolvedCwd });
					// Anchor at the gone breadcrumb cwd so the moveTo below relocates the
					// session: open() now falls back to the launch cwd for a missing
					// recorded cwd, which would no-op moveTo when it equals `cwd`.
					const manager = await SessionManager.open(breadcrumb.sessionFile, undefined, storage, {
						initialCwd: breadcrumbCwd,
						operatorNotices: options?.operatorNotices,
						instrumentation: options?.instrumentation,
					});
					await manager.moveTo(cwd, sessionDir);
					return manager;
				}

				chosenSession = newestInTargetDir;
			}
		}

		if (chosenSession === undefined) chosenSession = await findMostRecentSession(dir, storage);

		const manager = new SessionManager(
			cwd,
			dir,
			true,
			storage,
			sessionDir !== undefined,
			options?.operatorNotices,
			options?.instrumentation,
		);
		if (chosenSession) await manager.setSessionFile(chosenSession);
		else {
			manager.#resetToNewSession();
			manager.#startLifecycle("created");
		}
		return manager;
	}

	/** Create an in-memory session (no file persistence). */
	static inMemory(
		cwd: string = getProjectDir(),
		storage: SessionStorage = new MemorySessionStorage(),
	): SessionManager {
		const manager = new SessionManager(cwd, "", false, storage);
		manager.#resetToNewSession();
		return manager;
	}

	/**
	 * List sessions for a project directory.
	 * @param sessionDir Optional dir; defaults to the cwd-derived dir.
	 */
	static async list(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<SessionInfo[]> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		return listSessions(dir, storage);
	}

	/** List all sessions across all project directories. */
	static listAll(storage: SessionStorage = new FileSessionStorage()): Promise<SessionInfo[]> {
		return listAllSessions(storage);
	}
}

/**
 * If the current session was created by `/move` and contains no real
 * user/assistant messages, delete it so empty move sessions don't accumulate.
 */
export async function cleanupEmptyMoveSession(
	sessionManager: SessionManager,
	movedFromEmptySessionFile: string | undefined,
): Promise<void> {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !movedFromEmptySessionFile) return;
	if (path.resolve(sessionFile) !== path.resolve(movedFromEmptySessionFile)) return;
	const entries = sessionManager.getEntries();
	const hasRealMessages = entries.some(
		e => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"),
	);
	if (hasRealMessages) return;
	// The same question the draft-only drop asks: this session having no real
	// messages says nothing about the turns another window appended to the file it
	// created. A `/move` session is a fresh file and therefore the newest one in its
	// directory, which is exactly the file the other window resumes.
	if (await sessionManager.holdsForeignEntries()) return;
	try {
		await sessionManager.dropSession(sessionFile);
	} catch (err) {
		logger.warn("Failed to clean up empty move session", { sessionFile, error: String(err) });
	}
}
