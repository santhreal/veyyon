import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as pathModule from "node:path";

export interface WriteResult {
	text: string;
}

import type { PreflightWriteOptions } from "./fs-helpers";
export * from "./fs-helpers";

export class NotFoundError extends Error {
	readonly code = "ENOENT";

	constructor(path: string, cause?: unknown) {
		super(`File not found: ${path}`);
		this.name = "NotFoundError";
		if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
	}
}

export function isNotFound(error: unknown): boolean {
	if (error instanceof NotFoundError) return true;
	if (error instanceof Error && (error as Error & { code?: string }).code === "ENOENT") return true;
	return false;
}

export async function sameExistingFile(a: string, b: string): Promise<boolean> {
	try {
		const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
		return sa.dev === sb.dev && sa.ino === sb.ino;
	} catch {
		return false;
	}
}

let atomicTempCounter = 0;

async function resolveAtomicWriteTarget(filePath: string): Promise<{ target: string; viaSymlink: boolean }> {
	try {
		const stats = await fs.lstat(filePath);
		if (!stats.isSymbolicLink()) {
			assertRegularFileTarget(stats, filePath);
			return { target: filePath, viaSymlink: false };
		}
	} catch (error) {
		if (!isNotFound(error)) throw error;
		return { target: filePath, viaSymlink: false };
	}
	try {
		const target = await fs.realpath(filePath);
		assertRegularFileTarget(await fs.lstat(target), target);
		return { target, viaSymlink: true };
	} catch (error) {
		if (!isNotFound(error)) throw error;
		return {
			target: pathModule.resolve(pathModule.dirname(filePath), await fs.readlink(filePath)),
			viaSymlink: true,
		};
	}
}

function assertRegularFileTarget(stats: Stats, target: string): void {
	if (stats.isFile()) return;
	const kind = stats.isDirectory()
		? "a directory"
		: stats.isFIFO()
			? "a named pipe (FIFO)"
			: stats.isSocket()
				? "a socket"
				: stats.isBlockDevice() || stats.isCharacterDevice()
					? "a device node"
					: "not a regular file";
	throw new Error(
		`Refusing to write ${target}: it is ${kind}, and an atomic write would replace it with a regular file. ` +
			`Point the write at a regular file path instead.`,
	);
}

function withTargetInMessage(error: unknown, target: string, tempPath: string): unknown {
	if (!(error instanceof Error) || !error.message.includes(tempPath)) return error;
	const restated = new Error(
		`${error.message.replaceAll(tempPath, target)} (the write is staged in a temporary file beside the target, ` +
			`so it can replace it atomically; the temporary file is what the operating system named)`,
		{ cause: error },
	);
	const code = (error as NodeJS.ErrnoException).code;
	if (code !== undefined) (restated as NodeJS.ErrnoException).code = code;
	return restated;
}

export async function writeFileAtomic(targetPath: string, content: string): Promise<void> {
	const { target, viaSymlink } = await resolveAtomicWriteTarget(targetPath);

	let mode = 0o644;
	try {
		mode = (await fs.stat(target)).mode & 0o777;
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}

	const dir = pathModule.dirname(target);
	if (!viaSymlink) await fs.mkdir(dir, { recursive: true });

	const tempPath = pathModule.join(dir, `.${pathModule.basename(target)}.${process.pid}.${atomicTempCounter++}.tmp`);
	try {
		const handle = await fs.open(tempPath, "w", mode);
		try {
			await handle.writeFile(content);
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => {});
		throw withTargetInMessage(error, target, tempPath);
	}

	try {
		await fs.rename(tempPath, target);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST" || code === "EPERM" || code === "EACCES") {
			try {
				await fs.rm(target, { force: true });
				await fs.rename(tempPath, target);
			} catch (retryError) {
				await fs.rm(tempPath, { force: true }).catch(() => {});
				throw withTargetInMessage(retryError, target, tempPath);
			}
		} else {
			await fs.rm(tempPath, { force: true }).catch(() => {});
			throw withTargetInMessage(error, target, tempPath);
		}
	}

	try {
		const dirHandle = await fs.open(dir, "r");
		try {
			await dirHandle.sync();
		} finally {
			await dirHandle.close();
		}
	} catch {}
}

export abstract class Filesystem {
	abstract readText(path: string): Promise<string>;

	readBinary?(path: string): Promise<Uint8Array | undefined>;

	async preflightWrite(_path: string, _options?: PreflightWriteOptions): Promise<void> {}

	abstract writeText(path: string, content: string): Promise<WriteResult>;

	async delete(path: string): Promise<void> {
		throw new Error(`Filesystem does not support delete: ${path}`);
	}

	async move(from: string, to: string, content?: string): Promise<void> {
		void content;
		throw new Error(`Filesystem does not support move: ${from} -> ${to}`);
	}

	async exists(path: string): Promise<boolean> {
		try {
			await this.readText(path);
			return true;
		} catch (error) {
			if (isNotFound(error)) return false;
			throw error;
		}
	}

	async isSameExistingFile(a: string, b: string): Promise<boolean> {
		return this.canonicalPath(a) === this.canonicalPath(b);
	}

	canonicalPath(path: string): string {
		return path;
	}

	allowTagPathRecovery(_authoredPath: string, _resolvedPath: string): boolean {
		return true;
	}
}

export class InMemoryFilesystem extends Filesystem {
	#files = new Map<string, string>();

	constructor(initial?: Iterable<readonly [string, string]>) {
		super();
		if (initial) {
			for (const [path, content] of initial) this.#files.set(path, content);
		}
	}

	async readText(path: string): Promise<string> {
		const text = this.#files.get(path);
		if (text === undefined) throw new NotFoundError(path);
		return text;
	}

	async writeText(path: string, content: string): Promise<WriteResult> {
		this.#files.set(path, content);
		return { text: content };
	}

	async delete(path: string): Promise<void> {
		if (!this.#files.delete(path)) throw new NotFoundError(path);
	}

	async move(from: string, to: string, content?: string): Promise<void> {
		const existing = this.#files.get(from);
		if (existing === undefined) throw new NotFoundError(from);
		const finalContent = content ?? existing;
		this.#files.set(to, finalContent);
		if (to !== from) this.#files.delete(from);
	}

	async exists(path: string): Promise<boolean> {
		return this.#files.has(path);
	}

	set(path: string, content: string): void {
		this.#files.set(path, content);
	}

	get(path: string): string | undefined {
		return this.#files.get(path);
	}

	clear(): void {
		this.#files.clear();
	}

	entries(): IterableIterator<[string, string]> {
		return this.#files.entries();
	}
}

export class NodeFilesystem extends Filesystem {
	async readText(path: string): Promise<string> {
		const file = Bun.file(path);
		if (!(await file.exists())) throw new NotFoundError(path);
		return file.text();
	}

	async readBinary(path: string): Promise<Uint8Array> {
		try {
			return await fs.readFile(path);
		} catch (error) {
			if (isNotFound(error)) throw new NotFoundError(path, error);
			throw error;
		}
	}

	async writeText(path: string, content: string): Promise<WriteResult> {
		await writeFileAtomic(path, content);
		return { text: content };
	}

	async delete(path: string): Promise<void> {
		try {
			await fs.rm(path);
		} catch (error) {
			if (isNotFound(error)) throw new NotFoundError(path, error);
			throw error;
		}
	}

	async move(from: string, to: string, content?: string): Promise<void> {
		if (content !== undefined) {
			await writeFileAtomic(to, content);
			if (!(await sameExistingFile(from, to))) {
				await this.delete(from);
			}
			return;
		}
		try {
			await fs.rename(from, to);
		} catch (error) {
			if (isNotFound(error)) throw new NotFoundError(from, error);
			throw error;
		}
	}

	canonicalPath(path: string): string {
		return pathModule.resolve(path);
	}

	async exists(path: string): Promise<boolean> {
		return Bun.file(path).exists();
	}

	override async isSameExistingFile(a: string, b: string): Promise<boolean> {
		return sameExistingFile(a, b);
	}
}
