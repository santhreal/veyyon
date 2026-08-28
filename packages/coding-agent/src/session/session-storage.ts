import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { reportFault } from "@veyyon/utils/fault-sink";
import { hasFsCode, isEnoent } from "@veyyon/utils/fs-error";
import { type PathState, pathStateSync } from "@veyyon/utils/fs-optional";
import * as logger from "@veyyon/utils/logger";
import { peekFileEnds } from "@veyyon/utils/peek-file";
import { sessionBackupName, sessionFileStem } from "@veyyon/utils/session-file";
import { Snowflake } from "@veyyon/utils/snowflake";
import { toError } from "@veyyon/utils/type-guards";
import { overlayTitleSlotContent, type SessionTitleUpdate, serializeTitleSlot } from "./session-title-slot";

const utf8Decoder = new TextDecoder("utf-8");

export interface SessionStorageStat {
	size: number;
	mtimeMs: number;
	mtime: Date;
	identity?: string;
}

export interface SessionStorageWriter {
	append(line: string): Promise<void>;
	flush(): Promise<void>;
	isOpen(): boolean;
	close(): Promise<void>;
	getError(): Error | undefined;
}

export interface WriteTextAtomicOptions {
	commitGuard?: () => boolean;
}

export type SessionFileBody = string | (() => Iterable<string>);

export function sessionBodyChunks(body: SessionFileBody): Iterable<string> {
	return typeof body === "string" ? [body] : body();
}

export function sessionBodyToString(body: SessionFileBody): string {
	if (typeof body === "string") return body;
	let text = "";
	for (const chunk of body()) text += chunk;
	return text;
}

function writeChunksSync(fpath: string, body: SessionFileBody): void {
	const fd = fs.openSync(fpath, "w");
	try {
		for (const chunk of sessionBodyChunks(body)) {
			if (chunk.length > 0) fs.writeSync(fd, chunk);
		}
	} finally {
		fs.closeSync(fd);
	}
}

async function writeChunks(fpath: string, body: SessionFileBody): Promise<void> {
	const handle = await fs.promises.open(fpath, "w");
	try {
		for (const chunk of sessionBodyChunks(body)) {
			if (chunk.length > 0) await handle.write(chunk);
		}
	} finally {
		await handle.close();
	}
}

export interface SessionStorage {
	ensureDirSync(dir: string): void;
	existsSync(path: string): boolean;
	existsStateSync(path: string): PathState;
	writeTextSync(path: string, body: SessionFileBody): void;
	updateSessionTitle(path: string, update: SessionTitleUpdate): Promise<void>;
	statSync(path: string): SessionStorageStat;
	listFilesSync(dir: string, pattern: string): string[];
	listFilesRecursiveSync(dir: string, pattern: string): string[];

	exists(path: string): Promise<boolean>;
	readText(path: string): Promise<string>;
	readTextSync?(path: string): string | undefined;
	readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]>;
	writeText(path: string, content: string): Promise<void>;
	writeTextAtomic(path: string, body: SessionFileBody, options?: WriteTextAtomicOptions): Promise<void>;
	rename(path: string, nextPath: string): Promise<void>;
	moveSessionWithArtifacts(path: string, nextPath: string): Promise<void>;
	unlink(path: string): Promise<void>;
	deleteSessionWithArtifacts(sessionPath: string): Promise<void>;
	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter;
	drain(): Promise<void>;
}

const writerRegistry = new FinalizationRegistry<number>(fd => {
	try {
		fs.closeSync(fd);
	} catch {}
});

class FileSessionStorageWriter implements SessionStorageWriter {
	#fd: number;
	#closed = false;
	#error: Error | undefined;
	#onError: ((err: Error) => void) | undefined;

	constructor(fpath: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }) {
		this.#onError = options?.onError;
		const flags = options?.flags ?? "a";
		const dir = path.dirname(fpath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		this.#fd = fs.openSync(fpath, flags === "w" ? "w" : "a");
		writerRegistry.register(this, this.#fd, this);
	}

	#recordError(err: unknown): Error {
		const error = toError(err);
		if (!this.#error) this.#error = error;
		this.#onError?.(error);
		return error;
	}

	async append(line: string): Promise<void> {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		try {
			const buf = Buffer.from(line, "utf-8");
			let offset = 0;
			while (offset < buf.length) {
				const written = fs.writeSync(this.#fd, buf, offset, buf.length - offset);
				if (written === 0) {
					throw new Error("Short write");
				}
				offset += written;
			}
		} catch (err) {
			throw this.#recordError(err);
		}
	}

	async flush(): Promise<void> {
		if (this.#error) throw this.#error;
	}

	isOpen(): boolean {
		return !this.#closed;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		writerRegistry.unregister(this);
		try {
			fs.closeSync(this.#fd);
		} catch (err) {
			const error = this.#recordError(err);
			logger.warn("Could not close the session file cleanly; the transcript may be missing its last writes", {
				error: error.message,
				fix: "Check that the session directory is writable and not out of space. The session's earlier messages are unaffected.",
			});
		}
	}

	getError(): Error | undefined {
		return this.#error;
	}
}

export class FileSessionStorage implements SessionStorage {
	readonly #reportedUnreachable = new Set<string>();

	ensureDirSync(dir: string): void {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	existsSync(path: string): boolean {
		const state = pathStateSync(path);
		if (state === "unreadable" && !this.#reportedUnreachable.has(path)) {
			this.#reportedUnreachable.add(path);
			reportFault({
				source: "session",
				text: `${path} exists but could not be reached, so this session is being treated as though it were not there. Check the directory's permissions and whether its filesystem is mounted.`,
				context: { path },
			});
		}
		if (state === "present") this.#reportedUnreachable.delete(path);
		return state === "present";
	}

	existsStateSync(path: string): PathState {
		const state = pathStateSync(path);
		if (state === "unreadable" && !this.#reportedUnreachable.has(path)) {
			this.#reportedUnreachable.add(path);
			reportFault({
				source: "session",
				text: `${path} exists but could not be reached, so what it holds is unknown. Check the directory's permissions and whether its filesystem is mounted.`,
				context: { path },
			});
		}
		if (state === "present") this.#reportedUnreachable.delete(path);
		return state;
	}

	writeTextSync(fpath: string, body: SessionFileBody): void {
		const dir = path.dirname(fpath);
		this.ensureDirSync(dir);
		const tempPath = path.join(dir, `.${path.basename(fpath)}.${Snowflake.next()}.tmp`);
		try {
			writeChunksSync(tempPath, body);
			fs.renameSync(tempPath, fpath);
		} catch (err) {
			try {
				if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
			} catch (cleanupErr) {
				if (!isEnoent(cleanupErr)) {
					logger.warn("Failed to remove session rewrite temp file", {
						sessionFile: fpath,
						tempPath,
						error: toError(cleanupErr).message,
					});
				}
			}
			if (hasFsCode(err, "EPERM")) {
				writeChunksSync(fpath, body);
				return;
			}
			throw toError(err);
		}
	}

	async updateSessionTitle(fpath: string, update: SessionTitleUpdate): Promise<void> {
		const fd = fs.openSync(fpath, "r+");
		try {
			const buf = Buffer.from(serializeTitleSlot(update), "utf-8");
			let offset = 0;
			while (offset < buf.length) {
				const written = fs.writeSync(fd, buf, offset, buf.length - offset, offset);
				if (written === 0) {
					throw new Error("Short write");
				}
				offset += written;
			}
		} catch (err) {
			throw toError(err);
		} finally {
			fs.closeSync(fd);
		}
	}

	statSync(path: string): SessionStorageStat {
		const stats = fs.statSync(path);
		return {
			size: stats.size,
			mtimeMs: stats.mtimeMs,
			mtime: stats.mtime,
			identity: `${stats.dev}:${stats.ino}`,
		};
	}

	listFilesSync(dir: string, pattern: string): string[] {
		try {
			return Array.from(new Bun.Glob(pattern).scanSync(dir)).map(name => path.join(dir, name));
		} catch (err) {
			if (isEnoent(err)) return [];
			logger.warn("Session directory could not be listed; its sessions are invisible to this run", {
				dir,
				pattern,
				error: toError(err).message,
			});
			return [];
		}
	}

	listFilesRecursiveSync(dir: string, pattern: string): string[] {
		try {
			return Array.from(new Bun.Glob(`**/${pattern}`).scanSync(dir)).map(name => path.join(dir, name));
		} catch (err) {
			if (isEnoent(err)) return [];
			logger.warn("Session directory tree could not be listed; some sessions are invisible to this run", {
				dir,
				pattern,
				error: toError(err).message,
			});
			return [];
		}
	}

	async exists(path: string): Promise<boolean> {
		try {
			await fs.promises.access(path);
			return true;
		} catch (err) {
			if (isEnoent(err)) return false;
			throw err;
		}
	}

	readText(path: string): Promise<string> {
		return Bun.file(path).text();
	}

	readTextSync(path: string): string | undefined {
		try {
			return fs.readFileSync(path, "utf-8");
		} catch (err) {
			if (isEnoent(err)) return undefined;
			throw toError(err);
		}
	}

	async readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		return peekFileEnds(path, prefixBytes, suffixBytes, (head, tail) => [
			utf8Decoder.decode(head),
			utf8Decoder.decode(tail),
		]);
	}

	async writeText(path: string, content: string): Promise<void> {
		await Bun.write(path, content, { createPath: true });
	}

	async writeTextAtomic(fpath: string, body: SessionFileBody, options?: WriteTextAtomicOptions): Promise<void> {
		const dir = path.resolve(fpath, "..");
		const tempPath = path.join(dir, `.${path.basename(fpath)}.${Snowflake.next()}.tmp`);
		await fs.promises.mkdir(dir, { recursive: true });
		try {
			await writeChunks(tempPath, body);
		} catch (err) {
			this.#discardTemp(tempPath, fpath);
			throw toError(err);
		}
		if (options?.commitGuard && !options.commitGuard()) {
			this.#discardTemp(tempPath, fpath);
			return;
		}
		try {
			this.renameSync(tempPath, fpath);
			return;
		} catch (err) {
			if (!hasFsCode(err, "EPERM")) {
				this.#discardTemp(tempPath, fpath);
				throw toError(err);
			}
			try {
				this.#replaceSessionFileAfterEpermSync(tempPath, fpath, err, options?.commitGuard);
			} catch (fallbackErr) {
				this.#discardTemp(tempPath, fpath);
				throw fallbackErr;
			}
		}
	}

	renameSync(source: string, target: string): void {
		fs.renameSync(source, target);
	}

	#discardTemp(tempPath: string, targetPath: string): void {
		try {
			fs.unlinkSync(tempPath);
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to remove session rewrite temp file", {
					sessionFile: targetPath,
					tempPath,
					error: toError(err).message,
				});
			}
		}
	}

	#replaceSessionFileAfterEpermSync(
		tempPath: string,
		targetPath: string,
		renameError: unknown,
		commitGuard?: () => boolean,
	): void {
		const dir = path.resolve(targetPath, "..");
		const backupPath = path.join(dir, sessionBackupName(path.basename(targetPath), Snowflake.next()));
		try {
			this.renameSync(targetPath, backupPath);
		} catch (moveAsideError) {
			if (isEnoent(moveAsideError)) {
				if (commitGuard && !commitGuard()) {
					this.#discardTemp(tempPath, targetPath);
					return;
				}
				this.renameSync(tempPath, targetPath);
				return;
			}
			throw toError(renameError);
		}
		if (commitGuard && !commitGuard()) {
			try {
				this.renameSync(backupPath, targetPath);
			} catch (restoreErr) {
				logger.warn("Failed to restore backup after commitGuard rejection", {
					sessionFile: targetPath,
					backupPath,
					error: toError(restoreErr).message,
				});
			}
			this.#discardTemp(tempPath, targetPath);
			return;
		}
		try {
			this.renameSync(tempPath, targetPath);
		} catch (replaceError) {
			try {
				this.renameSync(backupPath, targetPath);
			} catch (rollbackErr) {
				const rollbackError = toError(rollbackErr);
				throw new Error(
					`Failed to replace session file after EPERM (original: ${toError(renameError).message}; retry: ${
						toError(replaceError).message
					}; rollback: ${rollbackError.message})`,
					{ cause: toError(renameError) },
				);
			}
			throw toError(replaceError);
		}
		try {
			fs.unlinkSync(backupPath);
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to remove session rewrite backup", {
					sessionFile: targetPath,
					backupPath,
					error: toError(err).message,
				});
			}
		}
	}

	async rename(path: string, nextPath: string): Promise<void> {
		try {
			await fs.promises.rename(path, nextPath);
		} catch (err) {
			throw toError(err);
		}
	}

	async moveSessionWithArtifacts(sourcePath: string, targetPath: string): Promise<void> {
		const sourceArtifacts = sessionFileStem(sourcePath);
		const targetArtifacts = sessionFileStem(targetPath);
		const sessionPathChanged = path.resolve(sourcePath) !== path.resolve(targetPath);
		const artifactPathChanged = path.resolve(sourceArtifacts) !== path.resolve(targetArtifacts);
		this.ensureDirSync(path.dirname(targetPath));

		let sessionMoved = false;
		let artifactsMoved = false;
		try {
			if (sessionPathChanged && this.existsStateSync(sourcePath) !== "absent") {
				await this.rename(sourcePath, targetPath);
				sessionMoved = true;
			}
			if (artifactPathChanged && this.existsStateSync(sourceArtifacts) !== "absent") {
				await this.rename(sourceArtifacts, targetArtifacts);
				artifactsMoved = true;
			}
		} catch (error) {
			const rollbackErrors: Error[] = [];
			if (artifactsMoved) {
				try {
					await this.rename(targetArtifacts, sourceArtifacts);
				} catch (rollbackError) {
					rollbackErrors.push(toError(rollbackError));
				}
			}
			if (sessionMoved) {
				try {
					await this.rename(targetPath, sourcePath);
				} catch (rollbackError) {
					rollbackErrors.push(toError(rollbackError));
				}
			}
			if (rollbackErrors.length > 0) {
				throw new AggregateError([toError(error), ...rollbackErrors], "Session relocation and rollback failed");
			}
			throw error;
		}
	}

	unlink(path: string): Promise<void> {
		return fs.promises.unlink(path);
	}

	drain(): Promise<void> {
		return Promise.resolve();
	}

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		return new FileSessionStorageWriter(path, options);
	}

	async deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		await this.unlink(sessionPath);

		const artifactsDir = sessionPath.slice(0, -6);

		try {
			await fsp.rm(artifactsDir, { recursive: true, force: true });
		} catch (err) {
			const error = toError(err);
			throw new Error(
				`Session file deleted but failed to remove artifacts directory ${artifactsDir}: ${error.message}`,
				{
					cause: error,
				},
			);
		}
	}
}

function matchesPattern(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) {
		return name.endsWith(pattern.slice(1));
	}
	return name === pattern;
}

class MemorySessionStorageWriter implements SessionStorageWriter {
	#storage: MemorySessionStorage;
	#path: string;
	#closed = false;
	#error: Error | undefined;
	#onError: ((err: Error) => void) | undefined;

	constructor(
		storage: MemorySessionStorage,
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	) {
		this.#storage = storage;
		this.#path = path;
		this.#onError = options?.onError;
		if ((options?.flags ?? "a") === "w") {
			this.#storage.writeTextSync(path, "");
		}
	}

	#recordError(err: unknown): Error {
		const error = toError(err);
		if (!this.#error) this.#error = error;
		this.#onError?.(error);
		return error;
	}

	async append(line: string): Promise<void> {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		try {
			this.#storage.appendSync(this.#path, line);
		} catch (err) {
			throw this.#recordError(err);
		}
	}

	async flush(): Promise<void> {
		if (this.#error) throw this.#error;
	}

	isOpen(): boolean {
		return !this.#closed;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
	}

	getError(): Error | undefined {
		return this.#error;
	}
}

interface MemoryFileEntry {
	chunks: string[];
	cumulativeBytes: number[];
	size: number;
	mtimeMs: number;
}

function createMemoryFileEntry(content: string, mtimeMs: number): MemoryFileEntry {
	const size = Buffer.byteLength(content, "utf-8");
	return {
		chunks: size === 0 ? [] : [content],
		cumulativeBytes: size === 0 ? [] : [size],
		size,
		mtimeMs,
	};
}

function appendMemoryChunk(entry: MemoryFileEntry, chunk: string): void {
	const chunkSize = Buffer.byteLength(chunk, "utf-8");
	if (chunkSize === 0) return;
	entry.size += chunkSize;
	entry.chunks.push(chunk);
	entry.cumulativeBytes.push(entry.size);
}

function normalizeByteLimit(maxBytes: number, size: number): number {
	if (!(maxBytes > 0) || size === 0) return 0;
	return Math.min(Math.trunc(maxBytes), size);
}

function lowerBound(values: readonly number[], target: number): number {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (values[mid] < target) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

function upperBound(values: readonly number[], target: number): number {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (values[mid] <= target) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

function joinChunkRange(chunks: readonly string[], start: number, end: number): string {
	const count = end - start;
	if (count <= 0) return "";
	if (count === 1) return chunks[start] ?? "";

	let content = "";
	for (let i = start; i < end; i++) {
		content += chunks[i];
	}
	return content;
}

function decodeChunkByteRange(chunk: string, startByte: number, endByte: number, chunkSize: number): string {
	if (startByte >= endByte) return "";
	if (startByte === 0 && endByte === chunkSize) return chunk;
	if (chunk.length === chunkSize) return chunk.slice(startByte, endByte);
	const bytes = Buffer.from(chunk, "utf-8");
	return utf8Decoder.decode(bytes.subarray(startByte, endByte));
}

function materializeMemoryEntry(entry: MemoryFileEntry): string {
	const { chunks } = entry;
	if (chunks.length === 0) return "";
	if (chunks.length === 1) return chunks[0];

	const content = chunks.join("");
	entry.chunks = [content];
	entry.cumulativeBytes = [entry.size];
	return content;
}

function sliceChunksHead(entry: MemoryFileEntry, maxBytes: number): string {
	const limit = normalizeByteLimit(maxBytes, entry.size);
	if (limit === 0) return "";
	if (limit >= entry.size) return materializeMemoryEntry(entry);

	const boundaryIndex = lowerBound(entry.cumulativeBytes, limit);
	const chunkStart = boundaryIndex === 0 ? 0 : entry.cumulativeBytes[boundaryIndex - 1];
	const chunkEnd = entry.cumulativeBytes[boundaryIndex];
	if (chunkEnd === limit) return joinChunkRange(entry.chunks, 0, boundaryIndex + 1);

	const chunk = entry.chunks[boundaryIndex];
	const chunkPrefix = decodeChunkByteRange(chunk, 0, limit - chunkStart, chunkEnd - chunkStart);
	return joinChunkRange(entry.chunks, 0, boundaryIndex) + chunkPrefix;
}

function sliceChunksTail(entry: MemoryFileEntry, maxBytes: number): string {
	const limit = normalizeByteLimit(maxBytes, entry.size);
	if (limit === 0) return "";
	if (limit >= entry.size) return materializeMemoryEntry(entry);

	const startByte = entry.size - limit;
	const boundaryIndex = upperBound(entry.cumulativeBytes, startByte);
	const chunkStart = boundaryIndex === 0 ? 0 : entry.cumulativeBytes[boundaryIndex - 1];
	const chunkEnd = entry.cumulativeBytes[boundaryIndex];
	const chunkOffset = startByte - chunkStart;
	if (chunkOffset === 0) return joinChunkRange(entry.chunks, boundaryIndex, entry.chunks.length);

	const chunk = entry.chunks[boundaryIndex];
	const chunkSuffix = decodeChunkByteRange(chunk, chunkOffset, chunkEnd - chunkStart, chunkEnd - chunkStart);
	return chunkSuffix + joinChunkRange(entry.chunks, boundaryIndex + 1, entry.chunks.length);
}

export class MemorySessionStorage implements SessionStorage {
	#files = new Map<string, MemoryFileEntry>();

	#requireEntry(path: string): MemoryFileEntry {
		const entry = this.#files.get(path);
		if (!entry) throw new Error(`File not found: ${path}`);
		return entry;
	}

	ensureDirSync(_dir: string): void {}

	existsSync(path: string): boolean {
		return this.#files.has(path);
	}

	existsStateSync(path: string): PathState {
		return this.#files.has(path) ? "present" : "absent";
	}

	writeTextSync(path: string, body: SessionFileBody): void {
		this.#files.set(path, createMemoryFileEntry(sessionBodyToString(body), Date.now()));
	}

	setMtimeSync(path: string, mtimeMs: number): void {
		this.#requireEntry(path).mtimeMs = mtimeMs;
	}

	async updateSessionTitle(path: string, update: SessionTitleUpdate): Promise<void> {
		const entry = this.#requireEntry(path);
		this.#files.set(
			path,
			createMemoryFileEntry(overlayTitleSlotContent(materializeMemoryEntry(entry), update), Date.now()),
		);
	}

	appendSync(path: string, chunk: string): void {
		const mtimeMs = Date.now();
		let entry = this.#files.get(path);
		if (!entry) {
			entry = createMemoryFileEntry("", mtimeMs);
			this.#files.set(path, entry);
		}
		appendMemoryChunk(entry, chunk);
		entry.mtimeMs = mtimeMs;
	}

	statSync(path: string): SessionStorageStat {
		const entry = this.#requireEntry(path);
		return {
			size: entry.size,
			mtimeMs: entry.mtimeMs,
			mtime: new Date(entry.mtimeMs),
		};
	}

	listFilesSync(dir: string, pattern: string): string[] {
		const prefix = dir.endsWith("/") ? dir : `${dir}/`;
		const files: string[] = [];
		for (const path of this.#files.keys()) {
			if (!path.startsWith(prefix)) continue;
			const name = path.slice(prefix.length);
			if (name.includes("/") || name.includes("\\")) continue;
			if (!matchesPattern(name, pattern)) continue;
			files.push(path);
		}
		return files;
	}

	listFilesRecursiveSync(dir: string, pattern: string): string[] {
		const prefix = dir.endsWith("/") ? dir : `${dir}/`;
		const files: string[] = [];
		for (const filePath of this.#files.keys()) {
			if (!filePath.startsWith(prefix)) continue;
			if (!matchesPattern(path.basename(filePath), pattern)) continue;
			files.push(filePath);
		}
		return files;
	}

	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.existsSync(path));
	}

	readText(path: string): Promise<string> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		return Promise.resolve(materializeMemoryEntry(entry));
	}

	readTextSync(path: string): string | undefined {
		const entry = this.#files.get(path);
		return entry ? materializeMemoryEntry(entry) : undefined;
	}

	readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		return Promise.resolve([sliceChunksHead(entry, prefixBytes), sliceChunksTail(entry, suffixBytes)]);
	}

	writeText(path: string, content: string): Promise<void> {
		this.writeTextSync(path, content);
		return Promise.resolve();
	}

	writeTextAtomic(path: string, body: SessionFileBody, options?: WriteTextAtomicOptions): Promise<void> {
		if (options?.commitGuard && !options.commitGuard()) return Promise.resolve();
		this.writeTextSync(path, body);
		return Promise.resolve();
	}

	rename(path: string, nextPath: string): Promise<void> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		this.#files.set(nextPath, entry);
		this.#files.delete(path);
		return Promise.resolve();
	}

	moveSessionWithArtifacts(sourcePath: string, targetPath: string): Promise<void> {
		const sourceArtifacts = sessionFileStem(sourcePath);
		const targetArtifacts = sessionFileStem(targetPath);
		const artifactPrefix = `${sourceArtifacts}/`;
		const moves: Array<[string, string, MemoryFileEntry]> = [];
		for (const [filePath, entry] of this.#files) {
			if (filePath === sourcePath) {
				moves.push([filePath, targetPath, entry]);
			} else if (filePath.startsWith(artifactPrefix)) {
				moves.push([filePath, `${targetArtifacts}/${filePath.slice(artifactPrefix.length)}`, entry]);
			}
		}
		for (const [source] of moves) this.#files.delete(source);
		for (const [, target, entry] of moves) this.#files.set(target, entry);
		return Promise.resolve();
	}

	unlink(path: string): Promise<void> {
		this.#files.delete(path);
		return Promise.resolve();
	}
	deleteSessionWithArtifacts(_sessionPath: string): Promise<void> {
		return Promise.resolve();
	}

	drain(): Promise<void> {
		return Promise.resolve();
	}

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		return new MemorySessionStorageWriter(this, path, options);
	}
}
