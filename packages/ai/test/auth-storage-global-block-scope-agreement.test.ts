/**
 * Which credential blocks a scoped read is allowed to see, and the one
 * deliberate exception.
 *
 * WHY THIS SUITE EXISTS. Blocks come in two flavours. A SCOPED block
 * (`tier:fable`, `shared`) says "this account is out of quota for that slice of
 * models". An UNSCOPED block says the credential itself is unusable right now,
 * which is what the three credential-wide writers record: a transient
 * token-refresh failure, and the two rotate-away paths after an upstream
 * rejection. Nothing about those depends on which model was asked for, so a
 * scoped read has to see them — and `#getCredentialBlockedUntil` reads the
 * unscoped in-memory key first, unconditionally, for exactly that reason.
 *
 * The persisted read then breaks that symmetry for one provider, and the reason
 * is not visible from the code, which is why this suite exists: a scoped
 * `openai-codex` read skips the persisted global row. That looks like an
 * inconsistency and is not one. The two copies differ in where they can have
 * come from. An in-memory unscoped block was written by the running process and
 * really is global. A PERSISTED unscoped Codex row may be LEGACY data — older
 * versions recorded Codex quota windows with no scope at all — so honouring it
 * under a scope would strand an account for a week over what was really one
 * five-hour window, while a scoped read of the same account can see it is fine.
 *
 * Worth recording why this needs saying: read on its own, the carve-out looks
 * like a stray provider check, and "make the persisted read match the in-memory
 * read" looks like an obvious ONE-PLACE cleanup. It is not. That change was
 * tried here and broke "ignores legacy global Codex blocks when a scoped quota
 * window has fresh siblings" in `auth-storage-codex-selection.test.ts` — one
 * assertion buried in a large ranking suite, which is a thin thread to hang a
 * non-obvious rule on. The tests below pin BOTH directions explicitly, so the
 * next reader who notices the asymmetry finds the contract stated.
 *
 * Every case reads through a SECOND AuthStorage over the same database. That is
 * deliberate: with an empty in-memory backoff map the persisted reader is the
 * one answering, which is the state a restart or a peer process is actually in
 * and the only state where these rules are observable.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";

const FUTURE_BLOCK_MS = Date.now() + 60 * 60 * 1000;

function oauthCredential(seed: string) {
	return {
		type: "oauth" as const,
		access: `access-${seed}`,
		refresh: `refresh-${seed}`,
		expires: Date.now() + 60 * 60 * 1000,
	};
}

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "veyyon-block-scope-"));
	dbPath = path.join(dir, "agent.db");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Persist one block, then resolve it through a fresh AuthStorage over the same file. */
async function blockedUntilAfterRestart(
	provider: string,
	providerKey: string,
	writeScope: string,
	readScope: string | undefined,
	blockedUntilMs = FUTURE_BLOCK_MS,
): Promise<number | undefined> {
	const store = await SqliteAuthCredentialStore.open(dbPath);
	store.saveOAuth(provider, oauthCredential("1"));
	const [row] = store.listAuthCredentials(provider);
	if (!row) throw new Error("expected credential row");
	const writer = new AuthStorage(store);
	await writer.reload();
	writer.upsertCredentialBlock({ credentialId: row.id, providerKey, blockScope: writeScope, blockedUntilMs });
	writer.close();

	const reopened = await SqliteAuthCredentialStore.open(dbPath);
	const reader = new AuthStorage(reopened);
	await reader.reload();
	try {
		return reader.credentialBlockedUntil(provider, providerKey, 0, readScope);
	} finally {
		reader.close();
	}
}

describe("credential block visibility across scopes", () => {
	it("shows a persisted global block to a scoped read for an ordinary provider", async () => {
		// The general rule. A globally blocked credential is blocked for every
		// model, so asking about one tier must not hide it.
		expect(await blockedUntilAfterRestart("anthropic", "anthropic:oauth", "", "tier:fable")).toBe(FUTURE_BLOCK_MS);
	});

	it("hides a persisted global block from a SCOPED openai-codex read, the legacy carve-out", async () => {
		// The exception, and the reason it exists. A persisted unscoped Codex row
		// may be a pre-scoping quota window rather than a real global block; a
		// scoped caller has better information and is trusted over it.
		expect(await blockedUntilAfterRestart("openai-codex", "openai-codex:oauth", "", "tier:fable")).toBeUndefined();
	});

	it("still shows a persisted global block to an UNSCOPED openai-codex read", async () => {
		// The carve-out is about scoped callers only. Without a scope there is no
		// better information to prefer, so the global row still applies and a dead
		// credential is not silently treated as available.
		expect(await blockedUntilAfterRestart("openai-codex", "openai-codex:oauth", "", undefined)).toBe(FUTURE_BLOCK_MS);
	});

	it("does not leak a scoped block into an unrelated scope", async () => {
		// A `tier:fable` block says nothing about `tier:sonnet`.
		expect(
			await blockedUntilAfterRestart("openai-codex", "openai-codex:oauth", "tier:fable", "tier:sonnet"),
		).toBeUndefined();
	});

	it("does not leak a scoped block into an unscoped read", async () => {
		// The other half: a tier-limited account is not globally blocked, so an
		// unscoped caller goes through.
		expect(await blockedUntilAfterRestart("anthropic", "anthropic:oauth", "tier:fable", undefined)).toBeUndefined();
	});

	it("takes the later deadline when a global and a scoped block both apply", async () => {
		// Both rows are consulted for providers without the carve-out, and the
		// longer block wins, so a scoped limit stacked on a global one is not
		// shortened by it.
		const store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveOAuth("anthropic", oauthCredential("1"));
		const [row] = store.listAuthCredentials("anthropic");
		if (!row) throw new Error("expected credential row");
		const writer = new AuthStorage(store);
		await writer.reload();
		writer.upsertCredentialBlock({
			credentialId: row.id,
			providerKey: "anthropic:oauth",
			blockScope: "",
			blockedUntilMs: FUTURE_BLOCK_MS,
		});
		writer.upsertCredentialBlock({
			credentialId: row.id,
			providerKey: "anthropic:oauth",
			blockScope: "tier:fable",
			blockedUntilMs: FUTURE_BLOCK_MS + 60_000,
		});
		writer.close();

		const reopened = await SqliteAuthCredentialStore.open(dbPath);
		const reader = new AuthStorage(reopened);
		await reader.reload();
		try {
			expect(reader.credentialBlockedUntil("anthropic", "anthropic:oauth", 0, "tier:fable")).toBe(
				FUTURE_BLOCK_MS + 60_000,
			);
		} finally {
			reader.close();
		}
	});

	it("drops an expired persisted block instead of reporting it", async () => {
		// An elapsed deadline must read as unblocked, not as a block in the past;
		// the selector treats any returned value as "still blocked".
		expect(
			await blockedUntilAfterRestart("anthropic", "anthropic:oauth", "", undefined, Date.now() - 1_000),
		).toBeUndefined();
	});
});
