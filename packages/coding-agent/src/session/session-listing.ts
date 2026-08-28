import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@veyyon/ai";
import {
	DAY_MS,
	getAgentDir as getDefaultAgentDir,
	HOUR_MS,
	isEnoent,
	logger,
	parseJsonlLenient,
	toError,
} from "@veyyon/utils";
import {
	SESSION_BACKUP_EXTENSION,
	SESSION_FILE_EXTENSION,
	sessionBackupPrimaryName,
	sessionFileStem,
} from "@veyyon/utils/session-file";
import { contentText } from "./content-text";
import { computeDefaultSessionDir } from "./session-paths";
import { FileSessionStorage, type SessionStorage } from "./session-storage";

export type SessionStatus = "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";

export interface SessionInfo {
	path: string;
	id: string;
	cwd: string;
	title?: string;
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	size: number;
	firstMessage: string;
	allMessagesText: string;
	status?: SessionStatus;
}

export interface ResolvedSessionMatch {
	session: SessionInfo;
	scope: "local" | "global";
}

export interface RecentSessionInfo {
	path: string;
	name: string;
	timeAgo: string;
}

const SESSION_LIST_PREFIX_BYTES = 4096;
const SESSION_LIST_ESCALATED_PREFIX_BYTES = 1_048_576;
const SESSION_LIST_SUFFIX_BYTES = 32_768;
const SESSION_LIST_PARALLEL_THRESHOLD = 64;
const SESSION_LIST_MAX_WORKERS = 16;

function sanitizeSessionName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const firstLine = value.split(/\r?\n/)[0] ?? "";
	const stripped = firstLine.replace(/[\x00-\x1F\x7F]/g, "");
	const trimmed = stripped.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function formatTimeAgo(date: Date): string {
	const now = Date.now();
	const diffMs = now - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / HOUR_MS);
	const diffDays = Math.floor(diffMs / DAY_MS);

	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays < 7) return `${diffDays}d ago`;
	return date.toLocaleDateString();
}

function sessionDisplayName(info: SessionInfo): string {
	const title = sanitizeSessionName(info.title);
	if (title) return title;
	const first =
		info.firstMessage && info.firstMessage !== "(no messages)" ? sanitizeSessionName(info.firstMessage) : undefined;
	if (first) return first;
	const created = info.created.getTime();
	const ts = Number.isFinite(created) ? created : info.modified.getTime();
	const date = new Date(ts);
	const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	return `Untitled · ${time}`;
}

function deriveSessionStatus(suffix: string): SessionStatus {
	if (!suffix) return "unknown";
	const lines = suffix.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line.charCodeAt(0) !== 123) continue;
		let entry: { type?: string; message?: TailMessage };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "message" && entry.message) {
			return statusFromTailMessage(entry.message);
		}
	}
	return "unknown";
}

interface TailMessage {
	role?: string;
	stopReason?: string;
	content?: unknown;
}

function isToolCallBlock(block: unknown): boolean {
	return typeof block === "object" && block !== null && "type" in block && block.type === "toolCall";
}

function statusFromTailMessage(message: TailMessage): SessionStatus {
	switch (message.role) {
		case "assistant": {
			switch (message.stopReason) {
				case "error":
					return "error";
				case "aborted":
					return "aborted";
				case "length":
					return "interrupted";
			}
			const content = message.content;
			if (Array.isArray(content) && content.some(isToolCallBlock)) return "interrupted";
			return "complete";
		}
		case "toolResult":
			return "interrupted";
		case "user":
			return "pending";
		default:
			return "unknown";
	}
}

function decodeJsonStringFragment(value: string): string {
	const safeValue = value.endsWith("\\") ? value.slice(0, -1) : value;
	try {
		return JSON.parse(`"${safeValue}"`) as string;
	} catch {
		return safeValue
			.replace(/\\n/g, "\n")
			.replace(/\\r/g, "\r")
			.replace(/\\t/g, "\t")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");
	}
}

function extractStringProperty(source: string, name: string, startIndex = 0): string | undefined {
	const propertyIndex = source.indexOf(`"${name}"`, startIndex);
	if (propertyIndex === -1) return undefined;

	const colonIndex = source.indexOf(":", propertyIndex + name.length + 2);
	if (colonIndex === -1) return undefined;

	let valueIndex = colonIndex + 1;
	while (valueIndex < source.length) {
		const char = source.charCodeAt(valueIndex);
		if (char !== 32 && char !== 9 && char !== 10 && char !== 13) break;
		valueIndex++;
	}
	if (source.charCodeAt(valueIndex) !== 34) return undefined;

	const valueStart = valueIndex + 1;
	let escaped = false;
	for (let i = valueStart; i < source.length; i++) {
		const char = source.charCodeAt(i);
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === 92) {
			escaped = true;
			continue;
		}
		if (char === 34) {
			return decodeJsonStringFragment(source.slice(valueStart, i));
		}
	}

	return decodeJsonStringFragment(source.slice(valueStart));
}

function countMessageMarkers(content: string): number {
	let count = 0;
	let index = 0;
	while (index < content.length) {
		const typeIndex = content.indexOf('"type"', index);
		if (typeIndex === -1) break;
		const colonIndex = content.indexOf(":", typeIndex + 6);
		if (colonIndex === -1) break;
		const type = extractStringProperty(content, "type", typeIndex);
		if (type === "message") count++;
		index = colonIndex + 1;
	}
	return count;
}

function extractFirstDisplayMessageFromPrefix(content: string): string | undefined {
	let fallback: string | undefined;
	let index = content.indexOf('"role"');

	while (index !== -1) {
		const role = extractStringProperty(content, "role", index);
		const text = extractStringProperty(content, "content", index) ?? extractStringProperty(content, "text", index);
		if (text) {
			if (role === "user") return text;
			if (!fallback && (role === "developer" || role === "assistant")) fallback = text;
		}
		index = content.indexOf('"role"', index + 6);
	}

	return fallback;
}

interface SessionListHeader {
	type: "session";
	id: string;
	cwd?: string;
	title?: string;
	parentSession?: string;
	timestamp?: string;
}

function normalizeTitleOverride(title: string | undefined): string | null | undefined {
	if (title === undefined) return undefined;
	return title.trim() ? title : null;
}

function sessionListHeaderFromRecord(
	record: Record<string, unknown> | undefined,
	titleOverride?: string | null,
): SessionListHeader | undefined {
	if (record?.type !== "session" || typeof record.id !== "string") return undefined;
	return {
		type: "session",
		id: record.id,
		cwd: typeof record.cwd === "string" ? record.cwd : undefined,
		title:
			titleOverride === null
				? undefined
				: (titleOverride ?? (typeof record.title === "string" ? record.title : undefined)),
		parentSession: typeof record.parentSession === "string" ? record.parentSession : undefined,
		timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
	};
}

function parseSessionListHeaderLine(line: string, titleOverride?: string | null): SessionListHeader | undefined {
	if (extractStringProperty(line, "type") !== "session") return undefined;
	const id = extractStringProperty(line, "id");
	if (!id) return undefined;
	return {
		type: "session",
		id,
		cwd: extractStringProperty(line, "cwd"),
		title: titleOverride === null ? undefined : (titleOverride ?? extractStringProperty(line, "title")),
		parentSession: extractStringProperty(line, "parentSession"),
		timestamp: extractStringProperty(line, "timestamp"),
	};
}

function parseSessionListHeader(
	content: string,
	entries: Array<Record<string, unknown>>,
): SessionListHeader | undefined {
	const firstEntry = entries[0];
	const parsedSlotTitle = normalizeTitleOverride(
		firstEntry?.type === "title" && typeof firstEntry.title === "string" ? firstEntry.title : undefined,
	);
	const parsedHeader = sessionListHeaderFromRecord(entries[firstEntry?.type === "title" ? 1 : 0], parsedSlotTitle);
	if (parsedHeader) return parsedHeader;

	let slotTitle: string | null | undefined;
	let firstNonEmpty = true;
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (firstNonEmpty && extractStringProperty(line, "type") === "title") {
			slotTitle = normalizeTitleOverride(extractStringProperty(line, "title"));
			firstNonEmpty = false;
			continue;
		}
		return parseSessionListHeaderLine(line, slotTitle);
	}
	return undefined;
}

function getSessionListWorkerCount(fileCount: number): number {
	if (fileCount <= SESSION_LIST_PARALLEL_THRESHOLD) return 1;
	return Math.min(
		SESSION_LIST_MAX_WORKERS,
		os.availableParallelism(),
		Math.ceil(fileCount / SESSION_LIST_PARALLEL_THRESHOLD),
	);
}

function walkListEntries(entries: Record<string, unknown>[]): {
	parsedMessageCount: number;
	firstMessage: string;
	allMessages: string[];
	shortSummary: string | undefined;
} {
	let parsedMessageCount = 0;
	let firstMessage = "";
	const allMessages: string[] = [];
	let shortSummary: string | undefined;
	for (let i = 1; i < entries.length; i++) {
		const entry = entries[i] as { type?: string; message?: Message; shortSummary?: string };
		if (entry.type === "compaction" && typeof entry.shortSummary === "string") {
			shortSummary = entry.shortSummary;
		}
		if (entry.type === "message" && entry.message) {
			parsedMessageCount++;
			if (entry.message.role === "user" || entry.message.role === "assistant") {
				const textContent = contentText(entry.message.content, { separator: " " });
				if (textContent) {
					allMessages.push(textContent);
					if (!firstMessage && entry.message.role === "user") {
						firstMessage = textContent;
					}
				}
			}
		}
	}
	return { parsedMessageCount, firstMessage, allMessages, shortSummary };
}

export interface UnreadableSession {
	readonly path: string;
	readonly reason: string;
	readonly kind: "file" | "directory";
}

let unreadableSessions: UnreadableSession[] = [];

function recordUnreadableSession(file: string, reason: string): void {
	unreadableSessions.push({ path: file, reason, kind: "file" });
	logger.warn("Session file could not be read and was left out of the list", { sessionFile: file, error: reason });
}

function recordUnreadableSessionDir(sessionDir: string, reason: string): void {
	unreadableSessions.push({ path: sessionDir, reason, kind: "directory" });
	logger.warn("Session directory could not be scanned; the list is EMPTY, not empty of sessions", {
		sessionDir,
		error: reason,
	});
}

export function getUnreadableSessions(): readonly UnreadableSession[] {
	const seen = new Set<string>();
	return unreadableSessions.filter(entry => {
		if (seen.has(entry.path)) return false;
		seen.add(entry.path);
		return true;
	});
}

export function clearUnreadableSessions(): void {
	unreadableSessions = [];
}

async function scanSessionFile(
	file: string,
	storage: SessionStorage,
	withStatus: boolean,
): Promise<SessionInfo | undefined> {
	try {
		const stat = storage.statSync(file);
		const [content, suffix] = await storage.readTextSlices(
			file,
			SESSION_LIST_PREFIX_BYTES,
			withStatus ? SESSION_LIST_SUFFIX_BYTES : 0,
		);
		const { size, mtime } = stat;
		const entries = parseJsonlLenient<Record<string, unknown>>(content);
		const header = parseSessionListHeader(content, entries);
		if (!header) {
			recordUnreadableSession(
				file,
				"no readable session header (file is empty, truncated at the start, or corrupt)",
			);
			return undefined;
		}

		let walked = walkListEntries(entries);
		let scanned = content;
		if (!walked.firstMessage && !extractFirstDisplayMessageFromPrefix(content) && size > SESSION_LIST_PREFIX_BYTES) {
			const [wide] = await storage.readTextSlices(file, Math.min(size, SESSION_LIST_ESCALATED_PREFIX_BYTES), 0);
			scanned = wide;
			walked = walkListEntries(parseJsonlLenient<Record<string, unknown>>(wide));
		}
		const { parsedMessageCount, allMessages, shortSummary } = walked;
		const firstMessage = walked.firstMessage || (extractFirstDisplayMessageFromPrefix(scanned) ?? "");
		const messageCount = Math.max(parsedMessageCount, countMessageMarkers(scanned));
		return {
			path: file,
			id: header.id,
			cwd: header.cwd ?? "",
			title: header.title ?? shortSummary,
			parentSessionPath: header.parentSession,
			created: new Date(header.timestamp ?? ""),
			modified: mtime,
			messageCount,
			size,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.length > 0 ? allMessages.join(" ") : firstMessage,
			status: withStatus ? deriveSessionStatus(suffix) : undefined,
		};
	} catch (error) {
		if (!isEnoent(error)) {
			recordUnreadableSession(file, toError(error).message);
		}
		return undefined;
	}
}

async function collectSessionsFromFileStride(
	files: string[],
	storage: SessionStorage,
	startIndex: number,
	stride: number,
	withStatus: boolean,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];

	for (let i = startIndex; i < files.length; i += stride) {
		const session = await scanSessionFile(files[i], storage, withStatus);
		if (session) sessions.push(session);
	}

	return sessions;
}

async function collectSessionsFromFiles(
	files: string[],
	storage: SessionStorage,
	withStatus: boolean,
): Promise<SessionInfo[]> {
	const workerCount = getSessionListWorkerCount(files.length);
	const sessions =
		workerCount === 1
			? await collectSessionsFromFileStride(files, storage, 0, 1, withStatus)
			: (
					await Promise.all(
						Array.from({ length: workerCount }, (_, workerIndex) =>
							collectSessionsFromFileStride(files, storage, workerIndex, workerCount, withStatus),
						),
					)
				).flat();

	sessions.sort(compareSessionsByRecency);
	return sessions;
}

function finiteTime(date: Date, fallback: number): number {
	const ms = date.getTime();
	return Number.isFinite(ms) ? ms : fallback;
}

function compareSessionsByRecency(a: SessionInfo, b: SessionInfo): number {
	const byModified = finiteTime(b.modified, 0) - finiteTime(a.modified, 0);
	if (byModified !== 0) return byModified;
	const byCreated = finiteTime(b.created, 0) - finiteTime(a.created, 0);
	if (byCreated !== 0) return byCreated;
	if (a.path < b.path) return -1;
	if (a.path > b.path) return 1;
	return 0;
}

export async function recoverOrphanedBackups(sessionDir: string, storage: SessionStorage): Promise<void> {
	let backups: string[];
	try {
		backups = storage.listFilesSync(sessionDir, `*${SESSION_BACKUP_EXTENSION}`);
	} catch (error) {
		if (!isEnoent(error)) {
			recordUnreadableSessionDir(sessionDir, toError(error).message);
		}
		return;
	}
	if (backups.length === 0) return;
	const candidates = new Map<string, { backup: string; mtimeMs: number }>();
	for (const backup of backups) {
		const name = path.basename(backup);
		const primaryName = sessionBackupPrimaryName(name);
		if (!primaryName) continue;
		const primaryPath = path.join(sessionDir, primaryName);
		let mtimeMs = 0;
		try {
			mtimeMs = storage.statSync(backup).mtimeMs;
		} catch (err) {
			if (isEnoent(err)) continue;
			recordUnreadableSession(backup, `session backup could not be measured: ${toError(err).message}`);
		}
		const existing = candidates.get(primaryPath);
		if (!existing || mtimeMs > existing.mtimeMs) {
			candidates.set(primaryPath, { backup, mtimeMs });
		}
	}
	for (const [primaryPath, { backup }] of candidates) {
		const primaryState = storage.existsStateSync(primaryPath);
		if (primaryState === "present") continue;
		if (primaryState === "unreadable") {
			recordUnreadableSession(
				primaryPath,
				"a session backup was left in place because the session it would replace could not be reached",
			);
			continue;
		}
		try {
			await storage.rename(backup, primaryPath);
			logger.warn("Recovered orphaned session backup", {
				sessionFile: primaryPath,
				backupPath: backup,
			});
		} catch (err) {
			logger.warn("Failed to recover orphaned session backup", {
				sessionFile: primaryPath,
				backupPath: backup,
				error: toError(err).message,
			});
		}
	}
}

async function scanSessionDir(
	sessionDir: string,
	storage: SessionStorage,
	withStatus: boolean,
): Promise<SessionInfo[]> {
	try {
		await recoverOrphanedBackups(sessionDir, storage);
		const files = storage.listFilesSync(sessionDir, `*${SESSION_FILE_EXTENSION}`);
		return await collectSessionsFromFiles(files, storage, withStatus);
	} catch (error) {
		if (!isEnoent(error)) {
			recordUnreadableSessionDir(sessionDir, toError(error).message);
		}
		return [];
	}
}

async function scanSessionDirReadOnly(
	sessionDir: string,
	storage: SessionStorage,
	withStatus: boolean,
): Promise<SessionInfo[]> {
	try {
		const files = storage.listFilesSync(sessionDir, `*${SESSION_FILE_EXTENSION}`);
		return await collectSessionsFromFiles(files, storage, withStatus);
	} catch (error) {
		if (!isEnoent(error)) {
			recordUnreadableSessionDir(sessionDir, toError(error).message);
		}
		return [];
	}
}

export function listSessions(sessionDir: string, storage: SessionStorage): Promise<SessionInfo[]> {
	return scanSessionDir(sessionDir, storage, true);
}

export function listSessionsReadOnly(sessionDir: string, storage: SessionStorage): Promise<SessionInfo[]> {
	return scanSessionDirReadOnly(sessionDir, storage, true);
}

export async function listAllSessions(storage: SessionStorage = new FileSessionStorage()): Promise<SessionInfo[]> {
	const sessionsRoot = path.join(getDefaultAgentDir(), "sessions");
	try {
		const backups = storage.listFilesRecursiveSync(sessionsRoot, `*${SESSION_BACKUP_EXTENSION}`);
		const backupDirs = new Set(backups.map(backup => path.dirname(backup)));
		await Promise.all(Array.from(backupDirs, sessionDir => recoverOrphanedBackups(sessionDir, storage)));

		const files = storage.listFilesRecursiveSync(sessionsRoot, `*${SESSION_FILE_EXTENSION}`);
		return await collectSessionsFromFiles(files, storage, true);
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.warn("Sessions directory could not be scanned; no sessions can be listed or resumed from it", {
			path: sessionsRoot,
			error: toError(err).message,
		});
		return [];
	}
}

export async function findMostRecentSession(
	sessionDir: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<string | null> {
	const sessions = await scanSessionDir(sessionDir, storage, false);
	return sessions[0]?.path ?? null;
}

function isBlankSession(info: SessionInfo): boolean {
	return !sanitizeSessionName(info.title) && (!info.firstMessage || info.firstMessage === "(no messages)");
}

export async function getRecentSessions(
	sessionDir: string,
	limit = 4,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<RecentSessionInfo[]> {
	const sessions = await scanSessionDir(sessionDir, storage, false);
	const recent: RecentSessionInfo[] = [];
	for (const info of sessions) {
		if (recent.length >= limit) break;
		if (isBlankSession(info)) continue;
		recent.push({ path: info.path, name: sessionDisplayName(info), timeAgo: formatTimeAgo(info.modified) });
	}
	return recent;
}

function sessionMatchesResumeArg(session: SessionInfo, sessionArg: string): boolean {
	const normalizedArg = sessionArg.toLowerCase();
	const normalizedId = session.id.toLowerCase();
	if (normalizedId.startsWith(normalizedArg)) {
		return true;
	}

	const fileName = sessionFileStem(path.basename(session.path)).toLowerCase();
	if (fileName.startsWith(normalizedArg)) {
		return true;
	}

	const separator = fileName.lastIndexOf("_");
	if (separator < 0) {
		return false;
	}

	const fileSessionId = fileName.slice(separator + 1);
	return fileSessionId.startsWith(normalizedArg);
}

export interface ResolveResumableSessionOptions {
	allowGlobalFallback?: boolean;
}

function isSessionStorage(value: SessionStorage | ResolveResumableSessionOptions): value is SessionStorage {
	return "listFilesSync" in value;
}

export async function resolveResumableSession(
	sessionArg: string,
	cwd: string,
	sessionDir?: string,
	storageOrOptions: SessionStorage | ResolveResumableSessionOptions = new FileSessionStorage(),
	options: ResolveResumableSessionOptions = {},
): Promise<ResolvedSessionMatch | undefined> {
	const storage = isSessionStorage(storageOrOptions) ? storageOrOptions : new FileSessionStorage();
	const resolvedOptions = isSessionStorage(storageOrOptions) ? options : storageOrOptions;
	const localSessionDir = sessionDir ?? computeDefaultSessionDir(cwd, storage);
	const localSessions = await listSessions(localSessionDir, storage);
	const localMatch = localSessions.find(session => sessionMatchesResumeArg(session, sessionArg));
	if (localMatch) {
		return { session: localMatch, scope: "local" };
	}

	if (sessionDir && resolvedOptions.allowGlobalFallback !== true) {
		return undefined;
	}

	const globalSessions = await listAllSessions(storage);
	const globalMatch = globalSessions.find(session => sessionMatchesResumeArg(session, sessionArg));
	if (!globalMatch) {
		return undefined;
	}

	return { session: globalMatch, scope: "global" };
}
