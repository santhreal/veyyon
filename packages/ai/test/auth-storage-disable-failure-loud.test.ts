import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import * as logger from "@veyyon/utils/logger";
import { removeWithRetries } from "../../utils/src/temp";

/**
 * Locks out three `catch {}` bodies in `auth-storage-sqlite.ts` that discarded a
 * failed write and returned `void`, so the caller could not tell the write from
 * a no-op.
 *
 * - `deleteAuthCredential` / `deleteAuthCredentialsForProvider`: these are how a
 *   credential is disabled after the provider rejects it. Swallowing the failure
 *   told the caller the credential was disabled while it stayed enabled and in
 *   rotation, so the same dead key is retried on every subsequent request and
 *   nothing anywhere says why.
 * - `recordUsageCosts`: a dropped batch makes the cost view under-report spend,
 *   and an under-report is indistinguishable from cheap usage.
 *
 * If this regresses, all three go back to returning normally with no log line,
 * and the symptoms above become undiagnosable from the operator's side.
 */
describe("A failed credential disable or cost write is reported, not discarded", () => {
	let tempDir = "";
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-disable-loud-"));
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	/**
	 * A store whose statements throw, which is the shape a closed or read-only
	 * database takes. The rows are untouched, which is exactly the point: the
	 * disable did not happen.
	 */
	async function brokenStore(): Promise<SqliteAuthCredentialStore> {
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		store.close();
		return store;
	}

	test("names the credential that could not be disabled and says it stays in rotation", async () => {
		const store = await brokenStore();

		store.deleteAuthCredential(41, "provider rejected the key");

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toContain("could not be disabled");
		expect(warnings[0]?.message).toContain("stays in rotation");
		expect(warnings[0]?.fields.id).toBe(41);
		expect(warnings[0]?.fields.disabledCause).toBe("provider rejected the key");
		expect(String(warnings[0]?.fields.error)).not.toBe("");
	});

	test("names the provider whose credentials could not be disabled", async () => {
		const store = await brokenStore();

		store.deleteAuthCredentialsForProvider("anthropic", "operator signed out");

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toContain("could not be disabled");
		expect(warnings[0]?.fields.provider).toBe("anthropic");
		expect(warnings[0]?.fields.disabledCause).toBe("operator signed out");
	});

	test("reports dropped cost rows and says the cost view will under-report", async () => {
		const store = await brokenStore();

		store.recordUsageCosts([
			{ recordedAt: Date.now(), provider: "anthropic", accountKey: "acct-1", costUsd: 1.25 },
			{ recordedAt: Date.now(), provider: "anthropic", accountKey: "acct-1", costUsd: 2.5 },
		]);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toContain("under-report");
		expect(warnings[0]?.fields.entries).toBe(2);
	});

	/**
	 * The other half of the contract: a working store stays silent. Without this
	 * the suite would pass against an implementation that warned unconditionally,
	 * which trains operators to ignore the message.
	 */
	test("says nothing when the writes succeed", async () => {
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "ok.db"));
		try {
			store.deleteAuthCredential(1, "no such row is still a successful statement");
			store.deleteAuthCredentialsForProvider("anthropic", "no rows is still success");
			store.recordUsageCosts([{ recordedAt: Date.now(), provider: "anthropic", accountKey: "a", costUsd: 1 }]);
		} finally {
			store.close();
		}

		expect(warnings).toEqual([]);
	});
});
