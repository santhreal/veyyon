import * as fs from "node:fs";
import type { PathState } from "@veyyon/utils/fs-optional";
import type { SessionTitleUpdate } from "./session-title-slot";

export const utf8Decoder = new TextDecoder("utf-8");

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

function sessionBodyChunks(body: SessionFileBody): Iterable<string> {
	return typeof body === "string" ? [body] : body();
}

export function sessionBodyToString(body: SessionFileBody): string {
	if (typeof body === "string") return body;
	let text = "";
	for (const chunk of body()) text += chunk;
	return text;
}

export function writeChunksSync(fpath: string, body: SessionFileBody): void {
	const fd = fs.openSync(fpath, "w");
	try {
		for (const chunk of sessionBodyChunks(body)) {
			if (chunk.length > 0) fs.writeSync(fd, chunk);
		}
	} finally {
		fs.closeSync(fd);
	}
}

export async function writeChunks(fpath: string, body: SessionFileBody): Promise<void> {
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

export const writerRegistry = new FinalizationRegistry<number>(fd => {
	try {
		fs.closeSync(fd);
	} catch {}
});
