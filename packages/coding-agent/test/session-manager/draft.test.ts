import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createSessionTeardown } from "@veyyon/coding-agent/modes/session-teardown";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { isEnoent, TempDir } from "@veyyon/utils";

async function fileExists(p: string): Promise<boolean> {
	try {
		await Bun.file(p).stat();
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

/** Every regular file under `dir`, recursively. */
async function filesUnder(dir: string): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await filesUnder(full)));
		else if (entry.isFile()) found.push(full);
	}
	return found;
}

describe("SessionManager draft", () => {
	it("round-trips text through saveDraft + consumeDraft", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-roundtrip-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.flush();

		await session.saveDraft("unsent text");

		// consumeDraft is single-shot: returns the text and removes the sidecar.
		expect(await session.consumeDraft()).toBe("unsent text");
		expect(await session.consumeDraft()).toBeNull();
	});

	it("places the draft inside the artifacts directory so dropSession cleans it", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-location-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.flush();

		await session.saveDraft("inside artifacts");

		const artifactsDir = session.getArtifactsDir();
		expect(artifactsDir).not.toBeNull();
		const draftPath = path.join(artifactsDir!, "draft.txt");
		expect(await fileExists(draftPath)).toBe(true);

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await session.dropSession(sessionFile);

		expect(await fileExists(draftPath)).toBe(false);
	});

	it("removes any stale draft when saving an empty string", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-empty-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.flush();

		await session.saveDraft("first attempt");
		await session.saveDraft("");

		expect(await session.consumeDraft()).toBeNull();
	});

	it("forces the session header onto disk so resume can find the draft owner", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-ensure-on-disk-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		// No assistant reply yet: without ensureOnDisk the session file would not
		// exist, leaving an orphan draft sidecar that --resume can never reach.
		session.appendMessage({ role: "user", content: "draft only", timestamp: 1 });

		await session.saveDraft("queued for next time");

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(await fileExists(sessionFile)).toBe(true);
	});

	it("is a no-op for in-memory sessions", async () => {
		const session = SessionManager.inMemory();

		await session.saveDraft("ignored");
		expect(await session.consumeDraft()).toBeNull();
	});

	/**
	 * THE LEAK, measured on the artifact it reached. `createSessionTeardown` routes
	 * the editor draft through `isSensitiveSlashCommand` before calling `saveDraft`,
	 * so a credential-bearing slash command must never become a resume sidecar. The
	 * predicate used to test `/(?:^|\s)--token(?:\s|$)/`, which demands whitespace
	 * or end-of-string after `--token`, so
	 *
	 *     /mcp add srv --url https://example.com --token=sk-live-SECRET123
	 *
	 * was classified non-sensitive and this exact file — `<artifacts>/draft.txt` —
	 * came back holding those bytes verbatim, and `consumeDraft()` returned them.
	 * The classification matrix lives in
	 * `test/slash-commands/credential-bearing-commands-never-persist.test.ts`; what
	 * is here is the durable artifact.
	 */
	it("never writes a credential-bearing slash command to the draft sidecar at teardown", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-credential-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.flush();
		// Materialize the JSONL and the sidecar with ordinary text first, so the scan
		// below runs against real files and cannot pass by finding nothing.
		await session.saveDraft("an earlier ordinary draft");
		const artifactsDir = session.getArtifactsDir();
		if (!artifactsDir) throw new Error("Expected artifacts dir");
		const draftPath = path.join(artifactsDir, "draft.txt");
		expect(await fileExists(draftPath)).toBe(true);

		const secret = "sk-live-SECRET123";
		const teardown = createSessionTeardown({
			getDraftText: () => `/mcp add srv --url https://example.com --token=${secret}`,
			beginDispose: () => {},
			saveDraft: text => session.saveDraft(text),
			flushSettings: async () => {},
			disposeSession: async () => {},
		});
		await teardown();

		// The sensitive line is not restorable, and the earlier draft was cleared
		// rather than left stale.
		expect(await session.consumeDraft()).toBeNull();
		expect(await fileExists(draftPath)).toBe(false);

		// And the bytes are in no file the session owns, not merely absent from the
		// sidecar path this test happens to know about.
		const owned = await filesUnder(tempDir.path());
		expect(owned.length).toBeGreaterThan(0);
		for (const file of owned) {
			const bytes = await Bun.file(file).text();
			expect(bytes, file).not.toContain(secret);
			expect(bytes, file).not.toContain("--token");
		}
	});

	/** The same teardown still persists an ordinary draft, so the test above is not vacuous. */
	it("still persists an ordinary draft through teardown", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-teardown-control-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.flush();

		const teardown = createSessionTeardown({
			getDraftText: () => "/mcp list",
			beginDispose: () => {},
			saveDraft: text => session.saveDraft(text),
			flushSettings: async () => {},
			disposeSession: async () => {},
		});
		await teardown();

		expect(await session.consumeDraft()).toBe("/mcp list");
	});
});
