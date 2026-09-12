import { describe, expect, test } from "bun:test";
import { MemorySessionStorage } from "../src/session/session-storage";

/**
 * WHY THIS SUITE EXISTS:
 * MemorySessionStorage.deleteSessionWithArtifacts was previously a no-op stub:
 * `deleteSessionWithArtifacts(_sessionPath: string): Promise<void> { return Promise.resolve(); }`
 * Calling deleteSessionWithArtifacts on MemorySessionStorage left the session file and all of its
 * associated artifacts in memory, violating the storage backend contract and consistency across backends.
 */
describe("MemorySessionStorage.deleteSessionWithArtifacts", () => {
	test("deletes the session file and its associated artifact entries", async () => {
		const storage = new MemorySessionStorage();
		const sessionPath = "/sessions/sess_123.jsonl";
		const artifact1 = "/sessions/sess_123/code.patch";
		const artifact2 = "/sessions/sess_123/nested/output.txt";
		const otherSession = "/sessions/sess_456.jsonl";
		const otherArtifact = "/sessions/sess_456/file.txt";

		await storage.writeText(sessionPath, '{"type":"session"}\n');
		await storage.writeText(artifact1, "patch content");
		await storage.writeText(artifact2, "output content");
		await storage.writeText(otherSession, '{"type":"session"}\n');
		await storage.writeText(otherArtifact, "other content");

		expect(storage.existsSync(sessionPath)).toBe(true);
		expect(storage.existsSync(artifact1)).toBe(true);
		expect(storage.existsSync(artifact2)).toBe(true);
		expect(storage.existsSync(otherSession)).toBe(true);
		expect(storage.existsSync(otherArtifact)).toBe(true);

		await storage.deleteSessionWithArtifacts(sessionPath);

		// Session and its artifacts must be removed
		expect(storage.existsSync(sessionPath)).toBe(false);
		expect(storage.existsSync(artifact1)).toBe(false);
		expect(storage.existsSync(artifact2)).toBe(false);

		// Other session and its artifacts must be preserved
		expect(storage.existsSync(otherSession)).toBe(true);
		expect(storage.existsSync(otherArtifact)).toBe(true);
	});
});
