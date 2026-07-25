import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { logger } from "@veyyon/utils";
import { removeWithRetries } from "../../utils/src/temp";

/**
 * A broken session-stickiness cache must be LOUD, never a debug line (Law 10).
 *
 * Session stickiness is what pins one session to one credential. All four cache
 * paths that maintain it used to `logger.debug(...)` and carry on when the store
 * threw, which is a silent fallback in its purest form: the request still
 * succeeds, so nothing looks wrong, but the pin is gone and a conversation can
 * hop between accounts mid-flight. That is the same wrong-account routing the
 * index-only cache rows are explicitly dropped to prevent, reached by a
 * different route, and an operator asking "why did this session switch accounts"
 * would find nothing above debug level to explain it.
 *
 * The fix is not fail-closed: a cache that cannot be written must not take down
 * a request that is otherwise fine. It is loud, bounded and recorded, which is
 * the degrade this codebase does allow. Both halves are pinned here, because
 * either one alone is wrong: silence hides the fault, and warning on every
 * request buries the very line it is trying to make visible.
 */
describe("A failing session-stickiness cache is surfaced, not swallowed at debug level", () => {
	let tempDir = "";
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;
	let debugs: Array<{ message: string; fields: Record<string, unknown> }>;
	const closers: Array<{ close: () => void }> = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-sticky-loud-"));
		warnings = [];
		debugs = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
		vi.spyOn(logger, "debug").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			debugs.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const c of closers.splice(0)) {
			try {
				c.close();
			} catch {
				// Already closed by the test itself.
			}
		}
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	/** A store with one usable API key, whose cache layer throws on every call. */
	async function storeWithBrokenCache(provider: string): Promise<{
		store: SqliteAuthCredentialStore;
		authStorage: AuthStorage;
	}> {
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		closers.push(store);
		const authStorage = new AuthStorage(store);
		await authStorage.set(provider, [{ type: "api_key", key: "sk-test-key" }]);
		// The shape a read-only or corrupt cache table takes: the credential rows
		// are fine, only the cache is broken, which is why the request still works.
		vi.spyOn(store, "setCache").mockImplementation(() => {
			throw new Error("SQLITE_READONLY: attempt to write a readonly database");
		});
		vi.spyOn(store, "getCache").mockImplementation(() => {
			throw new Error("SQLITE_CORRUPT: database disk image is malformed");
		});
		return { store, authStorage };
	}

	const stickyWarnings = <T extends { message: string }>(entries: T[]): T[] =>
		entries.filter(entry => entry.message.startsWith("Session sticky credential cache failed"));

	/**
	 * The core contract. A failed cache write is reported at warn level, and the
	 * message says what actually degraded rather than naming an internal cache.
	 */
	test("warns, naming the consequence, when the sticky cache cannot be written", async () => {
		const provider = "sticky-loud-write";
		const { authStorage } = await storeWithBrokenCache(provider);

		const key = await authStorage.getApiKey(provider, "session-a");

		// The request itself is unaffected: a broken cache is not a broken login.
		expect(key).toBe("sk-test-key");
		const reported = stickyWarnings(warnings);
		expect(reported).toHaveLength(1);
		expect(reported[0]?.message).toContain("no longer pinned to one credential");
		expect(reported[0]?.message).toContain("different account");
		expect(reported[0]?.fields.provider).toBe(provider);
		expect(reported[0]?.fields.operation).toBe("write");
		expect(String(reported[0]?.fields.error)).toContain("SQLITE_READONLY");
	});

	/**
	 * The bound. The usual cause is a store broken for the whole process, so the
	 * warning must not repeat per request. This is the half that keeps the fix
	 * from replacing an invisible failure with an unreadable log.
	 */
	test("warns once per provider and operation, then drops to debug", async () => {
		const provider = "sticky-loud-repeat";
		const { authStorage } = await storeWithBrokenCache(provider);

		for (let i = 0; i < 5; i++) {
			await authStorage.getApiKey(provider, `session-${i}`);
		}

		expect(stickyWarnings(warnings)).toHaveLength(1);
		// The later ones are recorded, just not shouted: still four of them.
		const quiet = debugs.filter(entry => entry.message === "Session sticky credential cache still failing");
		expect(quiet).toHaveLength(4);
		expect(quiet[0]?.fields.provider).toBe(provider);
	});

	/**
	 * Two providers are two independent faults. Collapsing them would mean the
	 * second provider's breakage is never announced at all, which is the original
	 * bug scoped down rather than fixed.
	 */
	test("warns separately for each provider", async () => {
		const first = "sticky-loud-a";
		const { authStorage } = await storeWithBrokenCache(first);
		const second = "sticky-loud-b";
		await authStorage.set(second, [{ type: "api_key", key: "sk-second" }]);

		await authStorage.getApiKey(first, "s1");
		await authStorage.getApiKey(second, "s2");

		const reported = stickyWarnings(warnings);
		expect(reported).toHaveLength(2);
		expect(reported.map(entry => entry.fields.provider).sort()).toEqual([first, second]);
	});

	/**
	 * A healthy store must stay silent. Without this the suite would pass against
	 * an implementation that warned unconditionally, which would train every
	 * operator to ignore the message.
	 */
	test("says nothing at all when the cache works", async () => {
		const provider = "sticky-quiet";
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "healthy.db"));
		closers.push(store);
		const authStorage = new AuthStorage(store);
		await authStorage.set(provider, [{ type: "api_key", key: "sk-healthy" }]);

		const key = await authStorage.getApiKey(provider, "session-healthy");

		expect(key).toBe("sk-healthy");
		expect(stickyWarnings(warnings)).toHaveLength(0);
	});
});
