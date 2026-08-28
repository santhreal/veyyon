import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isNotFound } from "./fs-util.js";
import { type GenerateOptions, generateDictFromRepo, type RepoFile } from "./generate.js";
import { parseDict } from "./parse.js";
import type { Vocabulary } from "./types.js";

export function cacheDictPath(baseDir: string, cacheId: string, contentSig: string): string {
	return join(baseDir, cacheId, `${contentSig}.dict`);
}

export function listingSignature(files: RepoFile[]): string {
	const lines = files.map(file => {
		const contentHash = file.content === undefined ? "" : sha256(file.content);
		return `${file.path}\0${contentHash}`;
	});
	lines.sort();
	return sha256(lines.join("\n")).slice(0, 32);
}

function sha256(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

export async function readDictFile(path: string): Promise<Vocabulary | undefined> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (err) {
		if (isNotFound(err)) {
			return undefined;
		}
		throw err;
	}
	return parseDict(content, path);
}

let tempCounter = 0;

export async function writeDictFileAtomic(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${tempCounter++}.tmp`;
	try {
		const handle = await open(temp, "w", 0o600);
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch (err) {
		await rm(temp, { force: true }).catch(() => {});
		throw err;
	}
	try {
		await rename(temp, path);
	} catch (err) {
		await rm(temp, { force: true }).catch(() => {});
		throw err;
	}
}

export interface ResolveCacheOptions {
	baseDir: string;
	cacheId: string;
	contentSig: string;
	files: RepoFile[];
	options?: GenerateOptions;
}

export interface ResolvedCache {
	vocab: Vocabulary;
	path: string;
	hit: boolean;
	writeError?: string;
}

export async function resolveProjectCache(params: ResolveCacheOptions): Promise<ResolvedCache> {
	const path = cacheDictPath(params.baseDir, params.cacheId, params.contentSig);

	const existing = await readDictFile(path);
	if (existing !== undefined) {
		return { vocab: existing, path, hit: true };
	}

	const result = generateDictFromRepo(params.files, { naming: "mnemonic", ...params.options });
	if (result.toml === "") {
		return { vocab: result.vocab, path, hit: false };
	}

	try {
		await writeDictFileAtomic(path, result.toml);
	} catch (err) {
		return { vocab: result.vocab, path, hit: false, writeError: describeWriteFailure(path, err) };
	}
	return { vocab: result.vocab, path, hit: false };
}

function describeWriteFailure(path: string, err: unknown): string {
	const reason = err instanceof Error ? err.message : String(err);
	return `argot: could not save the generated dictionary to ${path} (${reason}); the dictionary itself is correct and in use, but it will be regenerated on every session until this directory is writable`;
}
