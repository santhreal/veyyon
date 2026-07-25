import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { logger } from "@veyyon/utils";
import { removeWithRetries } from "../../utils/src/temp";

/**
 * A failed credential write must be LOUD, never swallowed (Law 10).
 *
 * `#runCredentialUpdate` used to `catch { // Ignore update failures }`. That silence
 * is exactly how a rotated OAuth token gets lost on disk under write contention
 * (SQLITE_BUSY / SQLITE_LOCKED while several rebuilt processes hammer the shared
 * store, or an IO error): the refresh succeeds in memory, the persist quietly fails,
 * the dead old token stays on disk, and the next run hits `invalid_grant` and logs the
 * user out — with nothing in the logs to explain it. This suite pins that a persist
 * failure emits an error-level log so the cause is diagnosable.
 */
describe("A failing credential persist is surfaced, not silently swallowed", () => {
	let tempDir = "";
	let errors: Array<{ message: string; fields: Record<string, unknown> }>;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-persist-loud-"));
		errors = [];
		vi.spyOn(logger, "error").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			errors.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	async function seedOneCredential(dbPath: string): Promise<{ store: SqliteAuthCredentialStore; id: number }> {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		store.replaceAuthCredentialsForProvider("anthropic", [
			{ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
		]);
		const id = store.listAuthCredentials("anthropic")[0]!.id;
		return { store, id };
	}

	test("updateAuthCredential logs an error when the write fails", async () => {
		const { store, id } = await seedOneCredential(path.join(tempDir, "agent.db"));
		// Force every subsequent DB operation to fail the way a locked/broken store would.
		store.close();

		store.updateAuthCredential(id, { type: "oauth", access: "a2", refresh: "r2", expires: Date.now() + 60_000 });

		const persistErrors = errors.filter(e => e.message === "Failed to persist auth credential update");
		expect(persistErrors).toHaveLength(1);
		expect(persistErrors[0]?.fields.id).toBe(id);
		expect(persistErrors[0]?.fields.clearDisabled).toBe(false);
		expect(String(persistErrors[0]?.fields.error ?? "")).not.toBe("");
	});

	test("updateAuthCredentialEnabling (the refresh-success persist) logs an error when the write fails", async () => {
		const { store, id } = await seedOneCredential(path.join(tempDir, "agent.db"));
		store.close();

		store.updateAuthCredentialEnabling(id, {
			type: "oauth",
			access: "a2",
			refresh: "r2",
			expires: Date.now() + 60_000,
		});

		const persistErrors = errors.filter(e => e.message === "Failed to persist auth credential update");
		expect(persistErrors).toHaveLength(1);
		// The refresh-success variant is the one whose silent failure caused the logout,
		// so its loud signal carries the clearDisabled marker.
		expect(persistErrors[0]?.fields.clearDisabled).toBe(true);
		expect(persistErrors[0]?.fields.id).toBe(id);
	});

	test("a healthy write emits no error and actually persists", async () => {
		const { store, id } = await seedOneCredential(path.join(tempDir, "agent.db"));
		try {
			store.updateAuthCredential(id, {
				type: "oauth",
				access: "a2",
				refresh: "r2",
				expires: Date.now() + 60_000,
			});
			expect(errors.filter(e => e.message === "Failed to persist auth credential update")).toHaveLength(0);
			const row = store.listAuthCredentials("anthropic")[0]?.credential;
			expect(row?.type).toBe("oauth");
			if (row?.type === "oauth") expect(row.refresh).toBe("r2");
		} finally {
			store.close();
		}
	});
});
