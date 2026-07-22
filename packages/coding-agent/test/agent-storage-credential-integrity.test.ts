import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { AgentStorage } from "@veyyon/coding-agent/session/agent-storage";
import { logger, TempDir } from "@veyyon/utils";

/**
 * `listAuthCredentials(provider, includeDisabled: true)` reads the credential
 * rows directly rather than through the auth store, and it used to drop any row
 * it could not make sense of without a word: a `JSON.parse` failure vanished
 * into an empty `catch {}`, and three more `continue` branches dropped rows
 * whose shape or type it did not recognize.
 *
 * A dropped credential does not present as a database problem. It presents as
 * "you are not signed in to Anthropic" for an account the user did sign in to,
 * and re-authenticating does not necessarily clear it, so they hit the same
 * wall again. These tests pin that every drop is reported at error level, names
 * the provider and the row, and still lets the remaining credentials through.
 */
describe("AgentStorage skips unreadable credentials loudly", () => {
	let tempDir: TempDir;

	afterEach(async () => {
		AgentStorage.resetInstance();
		if (tempDir) {
			await tempDir.remove().catch(() => {});
			tempDir = undefined as unknown as TempDir;
		}
	});

	async function openStorage(): Promise<{ storage: AgentStorage; dbPath: string }> {
		tempDir = TempDir.createSync("@veyyon-agent-storage-cred-");
		const dbPath = path.join(tempDir.path(), "agent.db");
		return { storage: await AgentStorage.open(dbPath), dbPath };
	}

	/** Write a row straight into the table, bypassing the writer's validation. */
	function insertRaw(dbPath: string, provider: string, credentialType: string, data: string): void {
		const db = new Database(dbPath);
		try {
			db.prepare("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, ?, ?)").run(
				provider,
				credentialType,
				data,
			);
		} finally {
			db.close();
		}
	}

	it("reports a credential whose stored JSON is malformed", async () => {
		const { storage, dbPath } = await openStorage();
		const errors = spyOn(logger, "error").mockImplementation(() => {});
		insertRaw(dbPath, "anthropic", "api_key", "{not json");

		try {
			const listed = storage.listAuthCredentials(undefined, true);

			expect(listed).toEqual([]);
			expect(errors).toHaveBeenCalledTimes(1);
			const [message, fields] = errors.mock.calls[0] as [string, Record<string, unknown>];
			expect(message).toBe("AgentStorage skipped an unreadable auth credential");
			expect(fields.provider).toBe("anthropic");
			expect(String(fields.reason)).toContain("not valid JSON");
		} finally {
			errors.mockRestore();
		}
	});

	it("reports an api_key row whose key is missing or not a string", async () => {
		const { storage, dbPath } = await openStorage();
		const errors = spyOn(logger, "error").mockImplementation(() => {});
		insertRaw(dbPath, "openai", "api_key", JSON.stringify({ key: 12345 }));

		try {
			expect(storage.listAuthCredentials(undefined, true)).toEqual([]);
			expect(errors).toHaveBeenCalledTimes(1);
			const [, fields] = errors.mock.calls[0] as [string, Record<string, unknown>];
			expect(fields.provider).toBe("openai");
			expect(String(fields.reason)).toContain("no string key");
		} finally {
			errors.mockRestore();
		}
	});

	it("reports a row whose credential type it does not recognize", async () => {
		// A row written by a newer veyyon, or by hand. Dropping it in silence made a
		// downgrade look like the credential had never existed.
		const { storage, dbPath } = await openStorage();
		const errors = spyOn(logger, "error").mockImplementation(() => {});
		insertRaw(dbPath, "google", "device_code", JSON.stringify({ token: "x" }));

		try {
			expect(storage.listAuthCredentials(undefined, true)).toEqual([]);
			expect(errors).toHaveBeenCalledTimes(1);
			const [, fields] = errors.mock.calls[0] as [string, Record<string, unknown>];
			expect(String(fields.reason)).toContain("device_code");
		} finally {
			errors.mockRestore();
		}
	});

	it("reports a row whose stored data is valid JSON but not an object", async () => {
		const { storage, dbPath } = await openStorage();
		const errors = spyOn(logger, "error").mockImplementation(() => {});
		insertRaw(dbPath, "anthropic", "api_key", '"just a string"');

		try {
			expect(storage.listAuthCredentials(undefined, true)).toEqual([]);
			expect(errors).toHaveBeenCalledTimes(1);
			const [, fields] = errors.mock.calls[0] as [string, Record<string, unknown>];
			expect(String(fields.reason)).toContain("not an object");
		} finally {
			errors.mockRestore();
		}
	});

	it("names a command that can actually fix it", async () => {
		// An error telling the user to run a subcommand that does not exist is worse
		// than saying nothing, so the fix line is pinned to the real one.
		const { storage, dbPath } = await openStorage();
		const errors = spyOn(logger, "error").mockImplementation(() => {});
		insertRaw(dbPath, "anthropic", "api_key", "{not json");

		try {
			storage.listAuthCredentials(undefined, true);

			const [, fields] = errors.mock.calls[0] as [string, Record<string, unknown>];
			expect(fields.fix).toBe('Run "veyyon auth-broker login anthropic" to replace it.');
		} finally {
			errors.mockRestore();
		}
	});

	it("keeps every readable credential when one row alongside them is broken", async () => {
		// The reason this reports instead of throwing: one corrupt row must not lock
		// the user out of the providers that are still fine.
		const { storage, dbPath } = await openStorage();
		const errors = spyOn(logger, "error").mockImplementation(() => {});
		insertRaw(dbPath, "anthropic", "api_key", JSON.stringify({ key: "sk-ant-good" }));
		insertRaw(dbPath, "openai", "api_key", "{not json");
		insertRaw(dbPath, "google", "api_key", JSON.stringify({ key: "goog-good" }));

		try {
			const listed = storage.listAuthCredentials(undefined, true);

			expect(listed.map(c => c.provider)).toEqual(["anthropic", "google"]);
			expect(listed.map(c => (c.credential as { key: string }).key)).toEqual(["sk-ant-good", "goog-good"]);
			expect(errors).toHaveBeenCalledTimes(1);
		} finally {
			errors.mockRestore();
		}
	});

	it("says nothing when every row is readable", async () => {
		// The counterpart that keeps the reporting meaningful: a healthy database
		// must not log an error, or the message stops being a signal.
		const { storage, dbPath } = await openStorage();
		const errors = spyOn(logger, "error").mockImplementation(() => {});
		insertRaw(dbPath, "anthropic", "api_key", JSON.stringify({ key: "sk-ant-good" }));
		insertRaw(dbPath, "openai", "oauth", JSON.stringify({ access: "tok", refresh: "r", expires: 1 }));

		try {
			const listed = storage.listAuthCredentials(undefined, true);

			expect(listed.map(c => c.provider)).toEqual(["anthropic", "openai"]);
			expect(listed.map(c => c.credential.type)).toEqual(["api_key", "oauth"]);
			expect(errors).not.toHaveBeenCalled();
		} finally {
			errors.mockRestore();
		}
	});
});
