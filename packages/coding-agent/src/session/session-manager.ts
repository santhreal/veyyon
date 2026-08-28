import * as fs from "node:fs";
import * as path from "node:path";
import type { ImageContent, Message, MessageAttribution, ServiceTierByFamily, TextContent } from "@veyyon/ai";
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
	clearDraftOnlyMarker,
	draftPathFor,
	hasDraftOnlyMarker,
	holdsOnlyDraftMetadata,
	isAssistantEntry,
	writeDraftOnlyMarker,
} from "./session-drafts";
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
import { SessionEntryIndex } from "./session-entry-index";
import {
	artifactsDirectoryFor,
	assertSessionSequence,
	fileSafeTimestamp,
	findEntriesThroughCheckpoint,
	getLifecycleStateFromEntries,
	isSessionIncarnationTelemetry,
	mintSessionId,
	nextSessionSequence,
	nowIso,
	resolveBreadcrumbToInteractiveRoot,
} from "./session-lifecycle";
import { findMostRecentSession, listAllSessions, listSessions, type SessionInfo } from "./session-listing";
import { loadEntriesFromFile, readTitleSlotFromFile, resolveBlobRefsInEntries } from "./session-loader";
import {
	CHUNK_TARGET_CHARS,
	type DiskQueueOptions,
	type SessionManagerNoticeOptions,
	type SessionManagerStateSnapshot,
} from "./session-manager-helpers";
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
	type SessionFileBody,
	type SessionStorage,
	type SessionStorageStat,
	type SessionStorageWriter,
} from "./session-storage";
import { type SessionTitleUpdate, serializeTitleSlot } from "./session-title-slot";

export {
	cleanupEmptyMoveSession,
	type ReadonlySessionManager,
	type SessionManagerNoticeOptions,
} from "./session-manager-helpers";

export class SessionManager {
	#cwd: string;
	#sessionDir: string;
	readonly #persist: boolean;
	readonly #storage: SessionStorage;
	readonly #blobs: BlobStore;
	#operatorNotices: OperatorNotices | undefined;

	#sessionId = "";
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

	#fileIsCurrent = false;
	#rewriteRequired = false;
	#forceFileCreation = false;
	#draftOnlySessionCleanupArmed = false;

	onEntryAppended?: (entry: SessionEntry) => void;

	#turnBudgetTotal: number | null = null;
	#turnBudgetHard = false;
	#turnOutputBaseline = 0;
	#turnEvalOutput = 0;

	#writer: SessionStorageWriter | undefined;
	#diskTail: Promise<void> = Promise.resolve();
	#diskFailure: Error | undefined;
	#diskFailureLogged = false;
	#diskEpoch = 0;
	#lastBodyBytes = 0;
	#atomicRewriteFenceEpoch: number | null = null;
	#atomicRewriteDirty = false;

	#idsEverSeen = new Set<string>();
	#foreignLines: string[] = [];
	#reportedForeignWriter = false;
	#publishedFileState: { size: number; identity?: string } | null = null;

	#artifactManager: ArtifactManager | null = null;
	#artifactManagerSessionFile: string | null = null;
	#adoptedArtifactManager: ArtifactManager | null = null;
	#inMemoryArtifacts: Map<string, string> | null = null;
	#inMemoryArtifactCounter = 0;

	#suppressBreadcrumb = false;
	#sessionNameChangedCallbacks = new Set<() => void>();
	#cwdChangedCallbacks = new Set<(previous: string, next: string) => void>();

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

	#retryPersistenceAfterFailure(): boolean {
		if (!this.#diskFailure) return false;
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
			this.#operatorNotices?.error(
				"session",
				`could not write this conversation to ${this.#sessionFile ?? "its transcript"} (${error.message}). It is still complete in this window and the whole file is rewritten on the next attempt.`,
			);
		}

		return this.#diskFailure;
	}

	#scheduleDiskWork(work: () => Promise<void>, options: DiskQueueOptions = {}): Promise<void> {
		const epoch = options.epoch ?? this.#diskEpoch;
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

	#fileBody(): SessionFileBody {
		return () => this.#fileChunks();
	}

	*#fileLines(): Generator<string> {
		yield this.#titleSlotLine();
		yield this.#lineFor(this.#header);
		for (const entry of this.#entries) yield this.#lineFor(entry);
		for (const line of this.#foreignLines) yield line.endsWith("\n") ? line : `${line}\n`;
	}

	*#fileChunks(): Generator<string> {
		this.#lastBodyBytes = 0;
		let chunk = "";
		for (const line of this.#fileLines()) {
			chunk += line;
			if (chunk.length < CHUNK_TARGET_CHARS) continue;
			this.#lastBodyBytes += Buffer.byteLength(chunk, "utf-8");
			yield chunk;
			chunk = "";
		}
		if (chunk.length === 0) return;
		this.#lastBodyBytes += Buffer.byteLength(chunk, "utf-8");
		yield chunk;
	}

	#noteIdSeen(id: string | undefined): void {
		if (id) this.#idsEverSeen.add(id);
	}

	#forgetForeignWriter(): void {
		this.#idsEverSeen.clear();
		this.#foreignLines = [];
		this.#reportedForeignWriter = false;
		this.#publishedFileState = null;
		this.#noteIdSeen(this.#header.id);
		for (const entry of this.#entries) this.#noteIdSeen(entry.id);
	}

	#fileIsExactlyAsPublished(): boolean {
		const expected = this.#publishedFileState;
		if (expected === null || !this.#sessionFile) return false;
		if (expected.identity === undefined) return false;
		let current: SessionStorageStat;
		try {
			current = this.#storage.statSync(this.#sessionFile);
		} catch {
			return false;
		}
		return current.identity === expected.identity && current.size === expected.size;
	}

	async #refreshForeignLines(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#fileIsExactlyAsPublished()) return;
		if (!(await this.#storage.exists(this.#sessionFile))) return;
		let text: string;
		try {
			text = await this.#storage.readText(this.#sessionFile);
		} catch {
			return;
		}
		this.#adoptForeignLines(text);
	}

	#refreshForeignLinesSync(): void {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#fileIsExactlyAsPublished()) return;
		let text: string | undefined;
		try {
			text = this.#storage.readTextSync?.(this.#sessionFile);
		} catch {
			return;
		}
		if (text === undefined) return;
		this.#adoptForeignLines(text);
	}

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

	#rewriteSynchronously(): void {
		if (!this.#persist || !this.#sessionFile || !this.#shouldHaveSessionFile()) return;

		try {
			this.#refreshForeignLinesSync();
			const body = this.#fileBody();
			this.#diskEpoch++;
			this.#diskTail = Promise.resolve();
			this.#closeWriterEventually();
			this.#storage.writeTextSync(this.#sessionFile, body);
			this.#notePublishedFile(this.#lastBodyBytes);
			this.#clearDiskError();
			this.#fileIsCurrent = true;
			this.#rewriteRequired = false;
			this.#hasTitleSlot = true;
		} catch (err) {
			this.#noteDiskFailure(err);
		}
	}

	async #rewriteAtomically(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;

		const startEpoch = this.#diskEpoch;
		await this.#scheduleDiskWork(
			async () => {
				if (await this.#runFencedAtomicRewrite(startEpoch)) {
					this.#clearDiskError();
					this.#fileIsCurrent = true;
					this.#rewriteRequired = false;
					this.#hasTitleSlot = true;
				}
			},
			{ epoch: startEpoch },
		);
	}

	async #runFencedAtomicRewrite(epoch: number): Promise<boolean> {
		this.#atomicRewriteFenceEpoch = epoch;
		try {
			do {
				this.#atomicRewriteDirty = false;
				await this.#closeWriterHandle();
				const sessionFile = this.#sessionFile;
				if (!sessionFile) return false;
				if (this.#diskEpoch !== epoch) return false;
				await this.#refreshForeignLines();
				if (this.#diskEpoch !== epoch) return false;
				const body = this.#fileBody();
				await this.#storage.writeTextAtomic(sessionFile, body, {
					commitGuard: () => this.#diskEpoch === epoch,
				});
				if (this.#diskEpoch !== epoch) return false;
				this.#notePublishedFile(this.#lastBodyBytes);
			} while (this.#atomicRewriteDirty);
			return true;
		} finally {
			if (this.#atomicRewriteFenceEpoch === epoch) this.#atomicRewriteFenceEpoch = null;
		}
	}

	#appendToSessionFile(entry: SessionEntry): void {
		if (!this.#persist || !this.#sessionFile) return;

		this.#retryPersistenceAfterFailure();

		if (!this.#shouldHaveSessionFile()) {
			this.#fileIsCurrent = false;
			return;
		}

		if (this.#atomicRewriteFenceEpoch !== null && this.#atomicRewriteFenceEpoch === this.#diskEpoch) {
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
			this.#atomicRewriteDirty = true;
			return;
		}
		if (!this.#fileIsCurrent || this.#rewriteRequired) {
			this.#rewriteSynchronously();
			return;
		}

		if (this.#fileReplacedUnderWriter()) {
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;

			this.#atomicRewriteDirty = true;
			this.#atomicRewriteFenceEpoch = this.#diskEpoch;
			void this.#rewriteAtomically();
			return;
		}

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

	#fileReplacedUnderWriter(): boolean {
		const expected = this.#publishedFileState;
		if (expected === null || !this.#sessionFile) return false;
		let current: SessionStorageStat;
		try {
			current = this.#storage.statSync(this.#sessionFile);
		} catch {
			return true;
		}
		if (expected.identity !== undefined && current.identity !== undefined) {
			return current.identity !== expected.identity;
		}
		return current.size !== expected.size;
	}

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
		for (const callback of Array.from(this.#sessionNameChangedCallbacks)) {
			try {
				callback();
			} catch (err) {
				logger.warn("SessionManager: session name change hook failed", { error: String(err) });
			}
		}
	}

	#notifyCwdListeners(previous: string, next: string): void {
		for (const callback of Array.from(this.#cwdChangedCallbacks)) {
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

	async putBlob(data: Buffer, options?: BlobPutOptions): Promise<BlobPutResult> {
		return this.#blobs.put(data, options);
	}

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
			header: this.#header,
			entries: this.#entries.slice(),
		};
	}

	restoreState(snapshot: SessionManagerStateSnapshot): void {
		this.#closeWriterEventually();
		this.#diskTail = Promise.resolve();
		this.#clearDiskError();

		this.#cwd = path.resolve(snapshot.cwd);
		this.#sessionDir = snapshot.sessionDir;
		this.#sessionFile = snapshot.sessionFile;
		this.#fileIsCurrent = snapshot.onDisk;
		this.#rewriteRequired = snapshot.needsRewrite;
		this.#forceFileCreation = snapshot.onDisk;
		this.#draftOnlySessionCleanupArmed = snapshot.draftOnlySessionCleanupArmed;
		this.#applyEntries(snapshot.header, snapshot.entries.slice());
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
			await resolveBlobRefsInEntries(fileEntries, this.#blobs, {
				source: resolvedSessionFile,
				operatorNotices: this.#operatorNotices,
			});
			header = fileEntries[0] as SessionHeader;
			const headerCwd = header.cwd ? path.resolve(header.cwd) : undefined;
			if (headerCwd && headerCwd !== path.resolve(this.#cwd) && (await directoryExists(headerCwd))) {
				adoptedCwd = headerCwd;
			}
		}

		this.#endLifecycle("session_switched");
		await this.#drainAndCloseWriter();
		this.#clearDiskError();
		this.#draftOnlySessionCleanupArmed = false;
		this.#sessionFile = resolvedSessionFile;
		this.#rememberBreadcrumb(this.#cwd, resolvedSessionFile);

		if (!header) {
			this.#resetToNewSession(undefined, resolvedSessionFile);
			this.#startLifecycle("created");
			this.#forceFileCreation = true;
			await this.#rewriteAtomically();
			this.#fileIsCurrent = true;
			return;
		}

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

	async newSession(options?: NewSessionOptions): Promise<string | undefined> {
		this.#endLifecycle("new_session");
		await this.#drainAndCloseWriter();
		const sessionFile = this.#resetToNewSession(options);
		this.#startLifecycle("created");
		return sessionFile;
	}

	async dropSession(sessionPath: string): Promise<void> {
		await this.#drainAndCloseWriter();
		try {
			await this.#storage.deleteSessionWithArtifacts(sessionPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}

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

		this.#forgetForeignWriter();
		await this.#rewriteAtomically();
		return { oldSessionFile, newSessionFile: this.#sessionFile };
	}

	async moveTo(newCwd: string, targetSessionDir?: string): Promise<void> {
		const resolvedCwd = path.resolve(this.#cwd, newCwd);
		const resolvedTargetDir = targetSessionDir ? path.resolve(targetSessionDir) : undefined;
		if (
			resolvedCwd === path.resolve(this.#cwd) &&
			(!resolvedTargetDir || resolvedTargetDir === path.resolve(this.#sessionDir))
		) {
			return;
		}

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

	async ensureOnDisk(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		this.#forceFileCreation = true;
		if (this.#fileIsCurrent && !this.#rewriteRequired) return;
		await this.#rewriteAtomically();
	}

	async flush(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#retryPersistenceAfterFailure()) await this.#rewriteAtomically();
		await this.#scheduleDiskWork(async () => {
			if (this.#writer?.isOpen()) await this.#writer.flush();
		});
		await this.#storage.drain();
		if (this.#diskFailure) throw this.#diskFailure;
	}

	flushSync(): void {
		if (!this.#persist || !this.#sessionFile) return;
		this.#retryPersistenceAfterFailure();
		if (this.#fileIsCurrent && !this.#rewriteRequired) {
			const writerError = this.#writer?.getError();
			if (writerError) throw writerError;
			return;
		}
		this.#rewriteSynchronously();
		if (this.#diskFailure) throw this.#diskFailure;
	}

	async holdsForeignEntries(): Promise<boolean> {
		await this.#refreshForeignLines();
		return this.#foreignLines.length > 0;
	}

	async #dropIfEmptyAndNoDraft(): Promise<void> {
		if (!this.#draftOnlySessionCleanupArmed) return;
		const sessionFile = this.#sessionFile;

		if (!sessionFile || this.#storage.existsStateSync(sessionFile) !== "present") {
			this.#draftOnlySessionCleanupArmed = false;
			return;
		}

		const draftPath = draftPathFor(this.getArtifactsDir());
		if (draftPath && this.#storage.existsStateSync(draftPath) !== "absent") return;
		if (!holdsOnlyDraftMetadata(this.#entries)) {
			await clearDraftOnlyMarker(this.#storage, this.getArtifactsDir());
			this.#draftOnlySessionCleanupArmed = false;
			return;
		}

		if (await this.holdsForeignEntries()) {
			await clearDraftOnlyMarker(this.#storage, this.getArtifactsDir());
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

	async close(): Promise<void> {
		this.#endLifecycle("closed");
		if (!this.#persist) return;
		if (this.#retryPersistenceAfterFailure()) await this.#rewriteAtomically();
		await this.#scheduleDiskWork(async () => {
			const hadWriter = this.#writer !== undefined;
			await this.#closeWriterHandle();
			if (hadWriter || (this.#sessionFile && this.#storage.existsStateSync(this.#sessionFile) === "present"))
				this.#fileIsCurrent = true;
		});
		await this.#dropIfEmptyAndNoDraft();
		await this.#storage.drain();
		if (this.#diskFailure) throw this.#diskFailure;
	}

	getCwd(): string {
		return path.resolve(this.#cwd);
	}

	setOperatorNotices(operatorNotices?: OperatorNotices): void {
		this.#operatorNotices = operatorNotices;
	}

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

	async setCwd(newCwd: string, options?: { validate?: boolean }): Promise<string> {
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

		if (resolvedCwd === path.resolve(this.#cwd)) {
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

		try {
			if (this.#persist && this.#sessionFile && this.#storage.existsStateSync(this.#sessionFile) !== "absent") {
				this.#forceFileCreation = true;
				await this.#rewriteAtomically();
			}
		} catch (error) {
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

	#setSessionId(next: string): void {
		if (this.#sessionId === next) return;
		this.#sessionId = next;
		for (const listener of this.#sessionIdListeners) listener(next);
	}

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

		this.#inMemoryArtifacts ??= new Map();
		const id = String(this.#inMemoryArtifactCounter++);
		this.#inMemoryArtifacts.set(id, content);
		return id;
	}

	async getArtifactPath(id: string): Promise<string | null> {
		return (await this.#artifactManagerForSession()?.getPath(id)) ?? null;
	}

	async saveDraft(text: string): Promise<void> {
		const draftPath = draftPathFor(this.getArtifactsDir());
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

		const draftWillMaterializeMetadataOnlyFile =
			sessionFile !== undefined &&
			this.#storage.existsStateSync(sessionFile) === "absent" &&
			holdsOnlyDraftMetadata(this.#entries);
		await this.ensureOnDisk();
		if (draftWillMaterializeMetadataOnlyFile) {
			await writeDraftOnlyMarker(this.#storage, this.getArtifactsDir());
			this.#draftOnlySessionCleanupArmed = true;
		}
		await this.#storage.writeText(draftPath, text);
	}

	async consumeDraft(): Promise<string | null> {
		const draftPath = draftPathFor(this.getArtifactsDir());
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
		if (holdsOnlyDraftMetadata(this.#entries) && hasDraftOnlyMarker(this.#storage, this.getArtifactsDir()))
			this.#draftOnlySessionCleanupArmed = true;

		return draft;
	}

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

	ingestReplicatedEntry(entry: SessionEntry): void {
		this.#recordEntry(entry);
	}

	snapshotForReplication(): { header: SessionHeader; entries: SessionEntry[] } {
		return { header: structuredClone(this.#header), entries: structuredClone(this.#entries) as SessionEntry[] };
	}

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

	appendSubagentSpawn(record: SubagentSpawnRecord): string {
		const entry: SubagentSpawnEntry = { type: "subagent_spawn", ...this.#freshEntryFields(), ...record };
		this.#recordEntry(entry);
		return entry.id;
	}

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

	async rewriteEntries(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		await this.#rewriteAtomically();
	}

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
			details: stripInternalDetailsFields(normalized.details),
			attribution: normalized.attribution,
			...this.#freshEntryFields(),
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	appendMCPToolSelection(selectedToolNames: string[]): string {
		const entry: MCPToolSelectionEntry = {
			type: "mcp_tool_selection",
			...this.#freshEntryFields(),
			selectedToolNames: selectedToolNames.slice(),
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	appendTtsrInjection(ruleNames: string[]): string {
		const entry: TtsrInjectionEntry = {
			type: "ttsr_injection",
			...this.#freshEntryFields(),
			injectedRules: ruleNames.slice(),
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	getInjectedTtsrRules(): string[] {
		const names = new Set<string>();
		for (const entry of this.getBranch()) {
			if (entry.type !== "ttsr_injection") continue;
			for (const name of entry.injectedRules) names.add(name);
		}
		return Array.from(names);
	}

	getLeafId(): string | null {
		return this.#index.leafId();
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.#index.leafEntry();
	}

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

	getChildren(parentId: string): SessionEntry[] {
		return this.#index.childrenOf(parentId);
	}

	getLabel(id: string): string | undefined {
		return this.#index.labelFor(id);
	}

	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.#index.has(targetId)) throw new Error(`Entry ${targetId} not found`);

		const entry: LabelEntry = { type: "label", ...this.#freshEntryFields(), targetId, label };
		this.#recordEntry(entry);
		return entry.id;
	}

	getBranch(fromId?: string): SessionEntry[] {
		return this.#index.pathTo(fromId ?? this.#index.leafId());
	}

	buildSessionContext(options?: BuildSessionContextOptions): SessionContext {
		return buildSessionContext(this.#entries, this.#index.leafId(), this.#index.entriesById(), options);
	}

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

	getEntries(): SessionEntry[] {
		return this.#entries.slice();
	}

	getLifecycleState(): SessionLifecycleState | "unknown" {
		return getLifecycleStateFromEntries(this.#entries);
	}

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

	getEntriesThroughCheckpoint(checkpoint: SessionCheckpoint | string): SessionEntry[] {
		return findEntriesThroughCheckpoint(this.#entries, checkpoint);
	}

	getTree(): SessionTreeNode[] {
		return this.#index.tree(this.#entries);
	}

	branch(branchFromId: string): void {
		if (!this.#index.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
		this.#index.setLeaf(branchFromId);
	}

	resetLeaf(): void {
		this.#index.setLeaf(null);
	}

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

	createBranchedSession(leafId: string): string | undefined {
		const sourceSessionFile = this.#sessionFile;
		if (!this.#index.has(leafId)) throw new Error(`Entry ${leafId} not found`);
		this.#endLifecycle("session_switched");
		const branchPath = this.getBranch(leafId);

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
			providerPromptCacheKey: this.#header.providerPromptCacheKey ?? this.#sessionId,
		};

		const labels: LabelEntry[] = [];
		let parentId = entriesToKeep[entriesToKeep.length - 1]?.id ?? null;
		for (const carried of labelsToCarry) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set(Array.from(keptIds).concat(labels.map(entry => entry.id)))),
				parentId,
				timestamp: nowIso(),
				targetId: carried.targetId,
				label: carried.label,
			};
			labels.push(labelEntry);
			parentId = labelEntry.id;
		}

		this.#header = header;
		this.#entries = entriesToKeep.concat(labels);
		this.#setSessionId(newSessionId);
		this.#sessionName = header.title;
		this.#titleSource = header.titleSource;
		this.#titleUpdatedAt = timestamp;
		this.#hasTitleSlot = true;
		this.#index.rebuild(this.#entries);
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

	static getDefaultSessionDir(
		cwd: string,
		agentDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): string {
		return computeDefaultSessionDir(cwd, storage, getSessionsDir(agentDir));
	}

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
		await resolveBlobRefsInEntries(sourceEntries, manager.#blobs, {
			source: sourcePath,
			operatorNotices: options?.operatorNotices,
		});

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
			if (!isEnoent(err)) {
				logger.warn("Session file exists but could not be loaded; treating it as missing", {
					path: filePath,
					error: errorMessage(err),
				});
			}
			return null;
		}
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
			breadcrumb.sessionFile = resolveBreadcrumbToInteractiveRoot(breadcrumb.sessionFile);
			const breadcrumbCwd = path.resolve(breadcrumb.cwd);
			if (breadcrumbCwd === resolvedCwd) {
				chosenSession = breadcrumb.sessionFile;
			} else {
				let newestInTargetDir = await findMostRecentSession(dir, storage);
				const breadcrumbFile = path.resolve(breadcrumb.sessionFile);

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

	static inMemory(
		cwd: string = getProjectDir(),
		storage: SessionStorage = new MemorySessionStorage(),
	): SessionManager {
		const manager = new SessionManager(cwd, "", false, storage);
		manager.#resetToNewSession();
		return manager;
	}

	static async list(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<SessionInfo[]> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		return listSessions(dir, storage);
	}

	static listAll(storage: SessionStorage = new FileSessionStorage()): Promise<SessionInfo[]> {
		return listAllSessions(storage);
	}
}
