/**
 * Every launch opens the profile `agent.db` through {@link AgentStorage} to read model usage order. The
 * credential store on that connection prepares about forty statements, runs the credential schema
 * checks, and keeps both for the life of the process: about 160 KiB of RSS and 0.35 ms per launch for a
 * process that, unless it reads a credential or the cache, never uses them. The store is built by the first
 * credential or cache call instead.
 *
 * Class closed: every public `AgentStorage` member, swept from the prototype at run time, is recorded here
 * as building the credential store or not, and a new member fails the sweep until it is recorded. Each
 * member runs as the FIRST call on a fresh database and must return its ordinary result, so a credential
 * member that reaches the credential tables through the raw connection before the store exists fails with
 * "no such table", and a usage or perf member that starts building the store fails the build check.
 *
 * Also pinned: a storage that never built the store still closes its connection and keeps `agent.db-wal`
 * and `agent.db-shm` on close (a WAL database on a read-only directory opens only when both exist), and
 * reopening a current database commits no write, for both schema owners of `agent.db`.
 *
 * Gap: the build check observes the credential tables on disk, which the store constructor creates, so a
 * change that builds the store on an already-initialised database is invisible to it, and the RSS and
 * timing cost are not asserted.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
import { AgentStorage } from "@veyyon/kernel/session/agent-storage";
import { TempDir } from "@veyyon/utils";

interface FirstCall {
	/** Whether this member, run first on a fresh database, builds the credential store. */
	builds: boolean;
	/** Runs the member first, then reads back through members that share its `builds` value. */
	run: (storage: AgentStorage, dir: string) => unknown;
	expected: unknown;
}

const API_KEY = { type: "api_key", key: "sk-test-0000" } as const;

const FIRST_CALLS: Record<string, FirstCall> = {
	recordModelUsage: {
		builds: false,
		run: storage => {
			storage.recordModelUsage("anthropic/model-a");
			return storage.getModelUsageOrder();
		},
		expected: ["anthropic/model-a"],
	},
	getModelUsageOrder: { builds: false, run: storage => storage.getModelUsageOrder(), expected: [] },
	recordModelPerf: {
		builds: false,
		run: async storage => {
			await storage.recordModelPerf("anthropic/model-a", { outputTokens: 500, durationMs: 1000 });
			return [...storage.getModelPerf().keys()];
		},
		expected: ["anthropic/model-a"],
	},
	getModelPerf: { builds: false, run: storage => storage.getModelPerf().size, expected: 0 },
	backfillModelPerfFromStats: {
		builds: false,
		run: (storage, dir) => {
			const statsDbPath = path.join(dir, "stats.db");
			const stats = new Database(statsDbPath);
			stats.run(
				"CREATE TABLE messages (timestamp INTEGER, provider TEXT, model TEXT, output_tokens INTEGER, duration INTEGER, ttft INTEGER, stop_reason TEXT)",
			);
			stats.close();
			return storage.backfillModelPerfFromStats(statsDbPath);
		},
		expected: 0,
	},
	hasAuthCredentials: { builds: true, run: storage => storage.hasAuthCredentials(), expected: false },
	authStore: { builds: true, run: storage => storage.authStore.listAuthCredentials(), expected: [] },
	listAuthCredentials: {
		builds: true,
		// The disabled-inclusive read queries the credential table through the raw connection.
		run: storage => storage.listAuthCredentials(undefined, true),
		expected: [],
	},
	replaceAuthCredentialsForProvider: {
		builds: true,
		run: storage =>
			storage
				.replaceAuthCredentialsForProvider("anthropic", [API_KEY])
				.map(row => [row.provider, row.credential, row.disabledCause]),
		expected: [["anthropic", API_KEY, null]],
	},
	updateAuthCredential: {
		builds: true,
		run: storage => {
			storage.updateAuthCredential(1, API_KEY);
			return storage.listAuthCredentials();
		},
		expected: [],
	},
	deleteAuthCredential: {
		builds: true,
		run: storage => {
			storage.deleteAuthCredential(1, "test");
			return storage.listAuthCredentials(undefined, true);
		},
		expected: [],
	},
	deleteAuthCredentialsForProvider: {
		builds: true,
		run: storage => {
			storage.deleteAuthCredentialsForProvider("anthropic", "test");
			return storage.listAuthCredentials(undefined, true);
		},
		expected: [],
	},
	getCache: { builds: true, run: storage => storage.getCache("k"), expected: null },
	setCache: {
		builds: true,
		run: storage => {
			storage.setCache("k", "v", Math.floor(Date.now() / 1000) + 3600);
			return storage.getCache("k");
		},
		expected: "v",
	},
	cleanExpiredCache: {
		builds: true,
		run: storage => {
			storage.cleanExpiredCache();
			return storage.getCache("k");
		},
		expected: null,
	},
};

/** Runs one statement on its own connection and finalizes both, so the probe leaves no connection behind. */
function readOnce(dbPath: string, sql: string, readonly = true): unknown[][] {
	const db = readonly ? new Database(dbPath, { readonly: true }) : new Database(dbPath);
	const statement = db.prepare(sql);
	try {
		return statement.values();
	} finally {
		statement.finalize();
		db.close();
	}
}

function credentialTablesExist(dbPath: string): boolean {
	return (
		readOnce(dbPath, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_credentials'").length > 0
	);
}

function dataVersion(db: Database): number {
	const statement = db.prepare("PRAGMA data_version");
	try {
		const version = statement.values()[0]?.[0];
		if (typeof version !== "number") throw new Error(`PRAGMA data_version returned ${String(version)}`);
		return version;
	} finally {
		statement.finalize();
	}
}

describe("AgentStorage builds its credential store on the first credential or cache call", () => {
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		AgentStorage.resetInstance();
		await tempDir?.remove();
		tempDir = undefined;
	});

	function freshDbPath(): string {
		tempDir = TempDir.createSync("@veyyon-agent-storage-lazy-auth-");
		return path.join(tempDir.path(), "agent.db");
	}

	it("records a first-call entry for every public member", () => {
		const members = Object.getOwnPropertyNames(AgentStorage.prototype).filter(name => name !== "constructor");
		expect(members.sort()).toEqual(Object.keys(FIRST_CALLS).sort());
	});

	for (const [member, call] of Object.entries(FIRST_CALLS)) {
		it(`${member} as the first call ${call.builds ? "builds" : "does not build"} the store and returns its result`, async () => {
			const dbPath = freshDbPath();
			const storage = await AgentStorage.open(dbPath);
			expect(await call.run(storage, path.dirname(dbPath))).toEqual(call.expected);
			expect(credentialTablesExist(dbPath)).toBe(call.builds);
		});
	}

	it("closes the database and keeps the WAL files when the credential store was never built", async () => {
		const dbPath = freshDbPath();
		const storage = await AgentStorage.open(dbPath);
		storage.recordModelUsage("anthropic/model-a");
		AgentStorage.resetInstance();
		// A statement still alive keeps a closed connection open until it is collected, and the WAL files are
		// deleted only when the connection really closes.
		Bun.gc(true);
		expect([fs.existsSync(`${dbPath}-wal`), fs.existsSync(`${dbPath}-shm`)]).toEqual([true, true]);
		// Leaving WAL mode needs the only connection to the file, so it succeeds only once the storage closed.
		expect(readOnce(dbPath, "PRAGMA journal_mode = DELETE", false)).toEqual([["delete"]]);
		expect(credentialTablesExist(dbPath)).toBe(false);
	});

	const reopeners: Record<string, (dbPath: string) => Promise<void>> = {
		AgentStorage: async dbPath => {
			AgentStorage.resetInstance();
			(await AgentStorage.open(dbPath)).authStore.listAuthCredentials();
		},
		SqliteAuthCredentialStore: async dbPath => {
			const store = await SqliteAuthCredentialStore.open(dbPath);
			store.listAuthCredentials();
			store.close();
		},
	};
	for (const [owner, reopen] of Object.entries(reopeners)) {
		it(`reopening a current database through ${owner} commits no write`, async () => {
			const dbPath = freshDbPath();
			(await AgentStorage.open(dbPath)).authStore.listAuthCredentials();
			AgentStorage.resetInstance();
			const observer = new Database(dbPath, { readonly: true });
			try {
				const before = dataVersion(observer);
				await reopen(dbPath);
				expect(dataVersion(observer)).toBe(before);
			} finally {
				observer.close();
			}
		});
	}
});
