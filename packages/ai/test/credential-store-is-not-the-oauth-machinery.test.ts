import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isSqliteBusyError, serializeCredential } from "@veyyon/ai/auth-credential-rows";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
import {
	createModuleReachCache,
	type ModuleReachResolution,
	moduleReach,
	moduleReachCount,
	moduleSpecifiersIn,
} from "@veyyon/utils/module-reach";
import { workspaceModuleReachResolution } from "@veyyon/utils/module-reach-workspace";

/**
 * Contracts: writing a credential row does not import the OAuth machinery.
 *
 * WHAT WAS WRONG. `auth-storage.ts` held three jobs in one 7,800-line module: the credential TYPES every
 * consumer speaks, the `AuthStorage` class that selects and refreshes credentials, and
 * `SqliteAuthCredentialStore`, which opens a database and reads and writes rows. Reaching the third
 * meant importing all of it, and all of it means the provider registry with its 75 provider definition
 * modules, the OAuth flows, and the error taxonomy: 213 modules to persist a credential.
 *
 * That cost landed somewhere specific. `packages/coding-agent/src/session/agent-storage.ts` wants exactly
 * this store, and it is imported by `config/settings.ts`, the module ~528 test files and every runtime
 * consumer of `Settings` import. So a settings read instantiated the OAuth stack. The split took
 * `config/settings.ts` from 250 modules to 126 and `agent-storage.ts` from 213 to 84.
 *
 * WHAT THE SHAPE OF THE SPLIT IS. `auth-credential-rows.ts` holds the row types and the pure functions
 * that map between a row and a credential, importing nothing but `@veyyon/utils`.
 * `auth-storage-sqlite.ts` holds the store: statements, transactions, migrations. `auth-storage.ts` keeps
 * the OAuth machinery and the types, imports the store for its `AuthStorage.create` factory, and
 * re-exports both moved modules so no existing caller changed. The back edge from the store to the types
 * is `import type`, which is erased, so at runtime the store and the rows are a closed pair.
 *
 * WHY THESE ASSERTIONS. Nothing FAILS when the split is undone: every function keeps working and one
 * convenient import restores the mesh, which is exactly how it grew. The numbers and the specific
 * absences are the only things that move, so they are what is pinned. The behavioural half is covered by
 * the twenty-odd `auth-storage-*.test.ts` suites, which passed unchanged across the move; what is added
 * here is a round trip through the store imported from its NEW path, because "the store works standalone"
 * is the actual new capability and nothing else asserts it.
 *
 * RAISED BY THREE 2026-07-26, and not by anything in this package: applying a user's `.env` split into two
 * phases, so the `@veyyon/utils` barrel grew from 79 modules to 82 (`dotenv-home.ts`, `dotenv-parse.ts`,
 * `dir-env-keys.ts`). Every number here that contains the barrel moved by the same three. See
 * `packages/utils/CHANGELOG.md`. */

const SRC = path.join(import.meta.dir, "..", "src");
const PACKAGES = path.join(SRC, "..", "..");

/**
 * The whole workspace resolved to source, derived from every package's `exports` field.
 *
 * Every assertion here is an upper bound or an absence, so under-resolution makes all of them pass while
 * measuring less. This table was two packages listed by hand; the derivation in
 * `@veyyon/utils/module-reach-workspace` reads every manifest under `packages/` instead, so a package
 * cannot be missing from it. See the note in `module-reach-stays-cut.test.ts` for what listing them by hand
 * cost the gates that did it.
 */
const RESOLUTION: ModuleReachResolution = workspaceModuleReachResolution(path.join(PACKAGES, ".."));

/** One memo for the whole gate: every entry below walks the same shared graph. See `ModuleReachCache`. */
const CACHE = createModuleReachCache();

function reach(relative: string): number {
	return moduleReachCount(path.join(SRC, relative), RESOLUTION, CACHE);
}

function reachedNames(relative: string): string[] {
	return [...moduleReach(path.join(SRC, relative), RESOLUTION, CACHE)].map(file => path.relative(SRC, file)).sort();
}

function runtimeImportsOf(relative: string): string[] {
	return moduleSpecifiersIn(require("node:fs").readFileSync(path.join(SRC, relative), "utf-8") as string);
}

/**
 * Measured 2026-07-26 at 4: this module and the three utils OWNERS it takes a pure function from.
 *
 * It was 75, which was the `@veyyon/utils` barrel (81 small leaves) plus this module, for
 * `decodeJwtPayload`, `isRecord` and `tryParseJson`. The barrel edge was the entire cost.
 */
const ROWS_CEILING = 8;
/**
 * Measured at 30: the rows module, `bun:sqlite`, the sqlite helper, one error class, and the utils owners
 * behind them. It was 83, the same barrel arriving through both this module and the rows module.
 */
const STORE_CEILING = 36;

describe("the row helpers are pure", () => {
	/**
	 * 4 is this module plus three pure-function owners, so it adds NOTHING of its own. That is the property
	 * that makes the store cheap, and it is worth a tight bound rather than a loose one: the moment this
	 * module imports a registry, an error taxonomy or the utils barrel, every consumer of the store pays it
	 * again.
	 */
	it(`reaches at most ${ROWS_CEILING} modules`, () => {
		expect(reach("auth-credential-rows.ts")).toBeLessThanOrEqual(ROWS_CEILING);
	});

	/**
	 * The two absences that matter, by name. The provider registry is what made `auth-storage.ts`
	 * expensive (75 provider definition modules), and the OAuth flows are the job this module is defined
	 * as not having.
	 */
	it("reaches neither the provider registry nor the OAuth flows", () => {
		const reached = reachedNames("auth-credential-rows.ts");

		expect(reached).not.toContain(path.join("registry", "index.ts"));
		expect(reached).not.toContain(path.join("registry", "oauth", "index.ts"));
		expect(reached).not.toContain("stream.ts");
	});

	/**
	 * Its only runtime imports are three utils OWNERS; the credential types come as `import type`, which is
	 * erased. Asserted as the exact list, because "does not import X" one name at a time cannot notice a
	 * new import nobody thought to check for.
	 *
	 * It took the bare `@veyyon/utils` barrel for `decodeJwtPayload`, `isRecord` and `tryParseJson`, which
	 * is 81 modules of small leaves for three pure functions; naming the owners took this module from 84 to
	 * 4. The subpaths rather than the barrel are the contract now: widening any of them back is the
	 * regression this exact list refuses.
	 *
	 * THE FOURTH ENTRY IS DELIBERATE AND COSTS ONE MODULE. `@veyyon/catalog/wire/codex` owns the two OpenAI
	 * JWT claim namespaces and the reader for them, and its own only import is `@veyyon/utils/jwt`, which is
	 * already on this list, so the reach went from 4 to 5. It is here because this module used to spell both
	 * claim URIs as BARE LITERALS while three other modules declared them under three names, and a bare
	 * literal is the copy a grep for any of those names never finds. A claim namespace is a lookup key, so a
	 * drift returns `undefined` and a valid token reads as one carrying no account. One leaf module is the
	 * price of that not being possible.
	 */
	it("imports three utils owners and one wire leaf at runtime", () => {
		expect(runtimeImportsOf("auth-credential-rows.ts")).toEqual([
			"@veyyon/catalog/wire/codex",
			"@veyyon/utils/json",
			"@veyyon/utils/jwt",
			"@veyyon/utils/type-guards",
		]);
	});
});

describe("the sqlite store stands on its own", () => {
	it(`reaches at most ${STORE_CEILING} modules`, () => {
		expect(reach("auth-storage-sqlite.ts")).toBeLessThanOrEqual(STORE_CEILING);
	});

	/**
	 * THE POINT OF THE WHOLE CHANGE. If this ever contains `auth-storage.ts` the split is undone, and the
	 * way it would happen is a value import replacing the type-only one at the top of the store: the
	 * names look identical in the editor and TypeScript accepts both.
	 */
	it("does not reach the OAuth module, the registry, or the streaming engine", () => {
		const reached = reachedNames("auth-storage-sqlite.ts");

		expect(reached).not.toContain("auth-storage.ts");
		expect(reached).not.toContain(path.join("registry", "index.ts"));
		expect(reached).not.toContain(path.join("registry", "oauth", "index.ts"));
		expect(reached).not.toContain("stream.ts");
	});

	/**
	 * NON-VACUITY. The three absences above are satisfied by a walk that resolves nothing, so this pins
	 * that the store really does reach its own dependencies: the row helpers it calls and the utils owners
	 * behind them.
	 *
	 * The floor was 70, which was the `@veyyon/utils` barrel arriving through both modules. Both name their
	 * owners now (the store took `errorMessage`, `getAgentDbPath` and `logger` from the barrel), so the
	 * store is 30 and the floor is stated against what it actually reaches: the row helpers and the two
	 * owners that cannot be absent if the walk is working.
	 */
	it("actually reaches the row helpers it calls", () => {
		const reached = reachedNames("auth-storage-sqlite.ts");

		expect(reached).toContain("auth-credential-rows.ts");
		expect(reached.some(file => file.endsWith(path.join("utils", "src", "type-guards.ts")))).toBe(true);
		expect(reached.some(file => file.endsWith(path.join("utils", "src", "dirs.ts")))).toBe(true);
		expect(reach("auth-storage-sqlite.ts")).toBeGreaterThan(20);
	});

	/**
	 * The credential types arrive type-only. A value import of the same module compiles and runs, and the
	 * only visible consequence is that every consumer of the store pays 213 modules again, so the form of
	 * the import is the contract.
	 */
	it("takes the credential types from auth-storage as types, not as values", () => {
		const source = require("node:fs").readFileSync(path.join(SRC, "auth-storage-sqlite.ts"), "utf-8") as string;

		expect(source).toContain("import type {");
		expect(source).toContain('} from "./auth-storage";');
		expect(runtimeImportsOf("auth-storage-sqlite.ts")).not.toContain("./auth-storage");
	});
});

describe("the OAuth module no longer touches a database", () => {
	/**
	 * A consequence of the split worth asserting on its own, because it is the clearest statement that
	 * the two jobs really were separable: after the move, `auth-storage.ts` has no `bun:sqlite` import, no
	 * filesystem import and no schema statements. If one comes back, a second place is writing rows and
	 * the two will disagree about the schema.
	 */
	it("imports neither bun:sqlite nor the filesystem", () => {
		const imports = runtimeImportsOf("auth-storage.ts");

		expect(imports).not.toContain("bun:sqlite");
		expect(imports).not.toContain("node:fs/promises");
		expect(imports).not.toContain("@veyyon/utils/sqlite");
	});

	/** And it still re-exports both moved pieces, which is what kept every existing caller working. */
	it("re-exports the store and the row predicate", () => {
		const source = require("node:fs").readFileSync(path.join(SRC, "auth-storage.ts"), "utf-8") as string;

		expect(source).toContain("export { SqliteAuthCredentialStore }");
		expect(source).toContain("isSqliteBusyError");
	});
});

describe("the store works when imported from its own module", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-credential-store-split-"));
		dbPath = path.join(dir, "agent.db");
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function openStore(): Promise<SqliteAuthCredentialStore> {
		return await SqliteAuthCredentialStore.open(dbPath);
	}

	/**
	 * An api-key round trip: save, read it back, get the exact key. Asserted as the exact string, because
	 * a store that returned any credential at all would satisfy a presence check while handing back the
	 * wrong account's key.
	 */
	it("saves and reads an api key", async () => {
		const store = await openStore();
		try {
			store.saveApiKey("anthropic", "sk-ant-exact-value");

			expect(store.getApiKey("anthropic")).toBe("sk-ant-exact-value");
			expect(store.listProviders()).toEqual(["anthropic"]);
		} finally {
			store.close();
		}
	});

	/**
	 * An OAuth round trip through the same path a login takes. Asserts the whole credential comes back,
	 * not just its presence: `expires` and `accountId` travel as JSON through the row's `data` column, and
	 * a serializer that dropped either would still return something that reads as a valid credential.
	 */
	it("saves and reads an OAuth credential whole", async () => {
		const store = await openStore();
		try {
			store.saveOAuth("openai-codex", {
				access: "access-token",
				refresh: "refresh-token",
				expires: 1_800_000_000_000,
				accountId: "acct-77",
			});

			expect(store.getOAuth("openai-codex")).toEqual({
				access: "access-token",
				refresh: "refresh-token",
				expires: 1_800_000_000_000,
				accountId: "acct-77",
			});
		} finally {
			store.close();
		}
	});

	/**
	 * The identity-key seam, which is the one the split could most plausibly have broken: the store now
	 * calls `serializeCredential` and `resolveCredentialIdentityKey` ACROSS a module boundary. Two accounts
	 * on one provider are two rows; if the identity key came back null the upsert would treat the second
	 * login as a replacement and the first account would vanish.
	 */
	it("keeps two OAuth credentials for one provider apart by account", async () => {
		const store = await openStore();
		try {
			store.upsertAuthCredentialForProvider("anthropic", {
				type: "oauth",
				access: "access-one",
				refresh: "refresh-one",
				expires: 1_800_000_000_000,
				accountId: "account-one",
			});
			store.upsertAuthCredentialForProvider("anthropic", {
				type: "oauth",
				access: "access-two",
				refresh: "refresh-two",
				expires: 1_800_000_000_000,
				accountId: "account-two",
			});

			const accounts = store
				.listAuthCredentials("anthropic")
				.map(row => (row.credential.type === "oauth" ? row.credential.accountId : row.credential.type))
				.sort();
			expect(accounts).toEqual(["account-one", "account-two"]);
		} finally {
			store.close();
		}
	});

	/**
	 * And the same account twice is ONE row, updated. This is the other half of the identity contract and
	 * the direction that silently accumulates duplicates when it breaks: every refresh would append a row,
	 * and the pool would look like a hundred accounts.
	 */
	it("replaces rather than appends when the same account logs in again", async () => {
		const store = await openStore();
		try {
			store.upsertAuthCredentialForProvider("anthropic", {
				type: "oauth",
				access: "old-access",
				refresh: "old-refresh",
				expires: 1_700_000_000_000,
				accountId: "account-one",
			});
			const rows = store.upsertAuthCredentialForProvider("anthropic", {
				type: "oauth",
				access: "new-access",
				refresh: "new-refresh",
				expires: 1_800_000_000_000,
				accountId: "account-one",
			});

			expect(rows).toHaveLength(1);
			expect(rows[0]?.credential).toEqual({
				type: "oauth",
				access: "new-access",
				refresh: "new-refresh",
				expires: 1_800_000_000_000,
				accountId: "account-one",
			});
		} finally {
			store.close();
		}
	});

	/**
	 * Deleting a credential disables the row and records WHY, rather than removing it: the cause is what
	 * `isRefreshFailureDisableCause` later reads to decide whether a successful refresh may re-enable it,
	 * and that predicate moved into the rows module. Asserts the exact cause string, since a normalized-
	 * away cause turns a deliberate logout into a resurrectable row.
	 */
	it("disables a credential with its cause instead of dropping the row", async () => {
		const store = await openStore();
		try {
			const [row] = store.upsertAuthCredentialForProvider("anthropic", { type: "api_key", key: "sk-doomed" });
			expect(row).toBeDefined();
			store.deleteAuthCredential(row!.id, "deleted by user");

			expect(store.listAuthCredentials("anthropic")).toEqual([]);
			const disabled = store.listDisabledAuthCredentials("anthropic");
			expect(disabled).toHaveLength(1);
			expect(disabled[0]?.disabledCause).toBe("deleted by user");
			expect(disabled[0]?.credential).toEqual({ type: "api_key", key: "sk-doomed" });
		} finally {
			store.close();
		}
	});

	/**
	 * The cache table, the store's second job. Expiry is the part worth asserting: a read of an expired
	 * key must return null while `includeExpired` still recovers the bytes, because that is how a stale
	 * usage report is distinguished from a missing one.
	 */
	it("expires cache entries but can still read them explicitly", async () => {
		const store = await openStore();
		try {
			const past = Math.floor(1_600_000_000_000 / 1000);
			store.setCache("usage:anthropic", '{"remaining":3}', past);

			expect(store.getCache("usage:anthropic")).toBeNull();
			expect(store.getCache("usage:anthropic", { includeExpired: true })).toBe('{"remaining":3}');
		} finally {
			store.close();
		}
	});

	/**
	 * A rate-limit block round trip, keyed the way `AuthStorage` keys its in-memory blocks. Asserts the
	 * exact deadline: a block written with the wrong scope reads back as absent, so the credential would be
	 * used while the provider is still rejecting it.
	 */
	it("persists a rate-limit block under its provider key and scope", async () => {
		const store = await openStore();
		try {
			const [row] = store.upsertAuthCredentialForProvider("anthropic", { type: "api_key", key: "sk-blocked" });
			store.upsertCredentialBlock({
				credentialId: row!.id,
				providerKey: "anthropic:api_key",
				blockScope: "tier:fable",
				blockedUntilMs: 1_900_000_000_000,
			});

			expect(store.getCredentialBlock(row!.id, "anthropic:api_key", "tier:fable")).toBe(1_900_000_000_000);
			expect(store.getCredentialBlock(row!.id, "anthropic:api_key", "")).toBeUndefined();
			expect(store.listCredentialBlocks([row!.id])).toHaveLength(1);
		} finally {
			store.close();
		}
	});

	/**
	 * The refresh lease, which is what stops two processes refreshing one credential at once. Both the
	 * exclusion and the owner check matter: a lease a second owner could renew is not a lease.
	 */
	it("grants a refresh lease to one owner only", async () => {
		const store = await openStore();
		try {
			const [row] = store.upsertAuthCredentialForProvider("anthropic", { type: "api_key", key: "sk-leased" });
			const expires = Date.now() + 60_000;

			expect(store.tryAcquireCredentialRefreshLease(row!.id, "process-a", expires)).toBe(true);
			expect(store.tryAcquireCredentialRefreshLease(row!.id, "process-b", expires)).toBe(false);
			expect(store.renewCredentialRefreshLease(row!.id, "process-b", expires + 1000)).toBe(false);
			expect(store.renewCredentialRefreshLease(row!.id, "process-a", expires + 1000)).toBe(true);

			store.releaseCredentialRefreshLease(row!.id, "process-a");
			expect(store.tryAcquireCredentialRefreshLease(row!.id, "process-b", expires)).toBe(true);
		} finally {
			store.close();
		}
	});

	/**
	 * The usage-cost table, the store's third job. Filtered by provider, because the query builds its
	 * WHERE clause from optional parameters and an ignored filter returns every provider's spend.
	 */
	it("records and filters observed request costs", async () => {
		const store = await openStore();
		try {
			store.recordUsageCosts([
				{ recordedAt: 1_700_000_000_000, provider: "anthropic", accountKey: "account:one", costUsd: 0.25 },
				{ recordedAt: 1_700_000_001_000, provider: "openai", accountKey: "account:two", costUsd: 0.5 },
			]);

			const anthropic = store.listUsageCosts({ provider: "anthropic", sinceMs: 0 });
			expect(anthropic).toHaveLength(1);
			expect(anthropic[0]?.costUsd).toBe(0.25);
			expect(anthropic[0]?.accountKey).toBe("account:one");
			expect(store.listUsageCosts({ sinceMs: 0 })).toHaveLength(2);
		} finally {
			store.close();
		}
	});

	/**
	 * Reopening the same file sees the rows. The migrations run in the constructor path, so this is what
	 * proves the schema the moved class creates is the schema it later reads: a store that recreated
	 * tables on open would pass every case above and lose every credential between processes.
	 */
	it("reads back what a previous store instance wrote to the same file", async () => {
		const first = await openStore();
		try {
			first.saveApiKey("anthropic", "sk-persisted");
		} finally {
			first.close();
		}

		const second = await openStore();
		try {
			expect(second.getApiKey("anthropic")).toBe("sk-persisted");
		} finally {
			second.close();
		}
	});

	/**
	 * And the survivors of the move are usable on their own: the serializer produces the identity key the
	 * store writes, and the busy predicate still recognises sqlite's contention codes. Both are exported
	 * from the rows module now, and both are what a caller reaching for `@veyyon/ai/auth-credential-rows`
	 * gets without a database at all.
	 */
	it("exposes the row helpers without a database", () => {
		const serialized = serializeCredential("anthropic", {
			type: "oauth",
			access: "a",
			refresh: "r",
			expires: 0,
			accountId: "acct-42",
		});

		expect(serialized?.credentialType).toBe("oauth");
		expect(serialized?.identityKey).toBe("account:acct-42");
		expect(isSqliteBusyError({ code: "SQLITE_BUSY_TIMEOUT" })).toBe(true);
		expect(isSqliteBusyError({ code: "SQLITE_CONSTRAINT" })).toBe(false);
	});
});
