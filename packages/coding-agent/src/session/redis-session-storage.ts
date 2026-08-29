import { logger, toError } from "@veyyon/utils";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "./indexed-session-storage";
import type { RedisSessionStorageClient, RedisSessionStorageOptions } from "./redis-session-storage-helpers";

import { DEFAULT_PREFIX, DEFAULT_SCAN_COUNT, decodeTitleMeta, encodeTitleMeta } from "./redis-session-storage-helpers";
import type { SessionTitleUpdate } from "./session-title-slot";

export type { RedisSessionStorageClient };

export class RedisSessionStorage extends IndexedSessionStorage {
	static async create(options: RedisSessionStorageOptions): Promise<RedisSessionStorage> {
		const storage = new RedisSessionStorage(new RedisSessionStorageBackend(options));
		await storage.initialize();
		return storage;
	}
}

class RedisSessionStorageBackend implements SessionStorageBackend {
	readonly #client: RedisSessionStorageClient;
	readonly #prefix: string;
	readonly #scanCount: number;

	constructor(options: RedisSessionStorageOptions) {
		this.#client = options.client;
		this.#prefix = options.prefix ?? DEFAULT_PREFIX;
		this.#scanCount = options.scanCount ?? DEFAULT_SCAN_COUNT;
	}

	init(): Promise<void> {
		return Promise.resolve();
	}

	async loadIndex(): Promise<SessionStorageIndexEntry[]> {
		const filePrefix = this.#fileKey("");
		const metaRaw = await this.#client.hgetall(this.#metaKey());
		const titleRaw = await this.#client.hgetall(this.#titleMetaKey());
		const meta: Record<string, string> = metaRaw ?? {};
		const titles: Record<string, string> = titleRaw ?? {};
		const seen = new Set<string>();
		let cursor = "0";
		do {
			const [next, batch] = await this.#client.scan(
				cursor,
				"MATCH",
				`${filePrefix}*`,
				"COUNT",
				String(this.#scanCount),
			);
			cursor = next;
			for (const key of batch) seen.add(key);
		} while (cursor !== "0");

		const fallbackMtimeMs = Date.now();
		return Promise.all(
			Array.from(seen, async key => {
				const path = key.slice(filePrefix.length);
				const size = await this.#client.strlen(key);
				const rawMtime = meta[path];
				const parsedMtime = rawMtime === undefined ? Number.NaN : Number(rawMtime);
				const title = decodeTitleMeta(titles[path]);
				return {
					path,
					size,
					mtimeMs: Number.isFinite(parsedMtime) ? parsedMtime : fallbackMtimeMs,
					title: title?.title,
					titleSource: title?.source,
					titleUpdatedAt: title?.updatedAt,
				};
			}),
		);
	}

	readFull(path: string): Promise<string | null> {
		return this.#client.get(this.#fileKey(path));
	}

	async readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const key = this.#fileKey(path);
		const head = prefixBytes > 0 ? this.#client.getrange(key, 0, prefixBytes - 1) : Promise.resolve("");
		const tail = suffixBytes > 0 ? this.#client.getrange(key, -suffixBytes, -1) : Promise.resolve("");
		return Promise.all([head, tail]);
	}

	async writeFull(path: string, content: string, mtimeMs: number, title?: SessionTitleUpdate): Promise<void> {
		await this.#client.set(this.#fileKey(path), content);
		await this.#client.hset(this.#metaKey(), path, String(mtimeMs));
		if (title) {
			await this.#client.hset(this.#titleMetaKey(), path, encodeTitleMeta(title));
		} else {
			await this.#client.hdel(this.#titleMetaKey(), path);
		}
	}

	async append(path: string, line: string, mtimeMs: number): Promise<void> {
		await this.#client.append(this.#fileKey(path), line);
		await this.#client.hset(this.#metaKey(), path, String(mtimeMs));
	}

	async updateSessionTitle(path: string, title: SessionTitleUpdate, mtimeMs: number): Promise<void> {
		await this.#client.hset(this.#metaKey(), path, String(mtimeMs));
		await this.#client.hset(this.#titleMetaKey(), path, encodeTitleMeta(title));
	}

	async truncate(path: string, mtimeMs: number): Promise<void> {
		await this.writeFull(path, "", mtimeMs);
	}

	async remove(paths: string[]): Promise<void> {
		if (paths.length === 0) return;
		await this.#client.del(...paths.map(path => this.#fileKey(path)));
		await this.#client.hdel(this.#metaKey(), ...paths);
		await this.#client.hdel(this.#titleMetaKey(), ...paths);
	}

	async move(src: string, dst: string, mtimeMs: number): Promise<void> {
		await this.#client.rename(this.#fileKey(src), this.#fileKey(dst));
		try {
			const titleMeta = await this.#client.hgetall(this.#titleMetaKey());
			await this.#client.hdel(this.#metaKey(), src);
			await this.#client.hset(this.#metaKey(), dst, String(mtimeMs));
			await this.#client.hdel(this.#titleMetaKey(), src);
			const title = titleMeta[src];
			if (title !== undefined) await this.#client.hset(this.#titleMetaKey(), dst, title);
		} catch (err) {
			logger.warn("Redis session storage meta rename failed", {
				src,
				dst,
				error: toError(err).message,
			});
		}
	}

	#fileKey(path: string): string {
		return `${this.#prefix}file:${path}`;
	}

	#metaKey(): string {
		return `${this.#prefix}meta`;
	}

	#titleMetaKey(): string {
		return `${this.#prefix}title`;
	}
}
