/**
 * WHY:
 * FileSessionStorage and IndexedSessionStorage previously derived the artifacts directory by
 * hardcoded slicing: `sessionPath.slice(0, -6)`. This assumed every path ended with exactly `.jsonl`.
 * When invoked with a session file that does not end with `.jsonl` (e.g. custom extension or backup file),
 * `slice(0, -6)` truncated arbitrary characters from the path instead of using `sessionFileStem`.
 * Both backends now resolve the artifact directory via `sessionFileStem`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { SqlSessionStorage } from "@veyyon/kernel/session/sql-session-storage";
import { SQL } from "bun";

describe("session storage backends delete artifacts by canonical session stem", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const dir of tempDirs) {
			try {
				await fsp.rm(dir, { recursive: true, force: true });
			} catch {}
		}
		tempDirs.length = 0;
	});

	it("FileSessionStorage deletes artifacts matching stem for standard and non-standard session file paths", async () => {
		const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), "file-session-artifacts-"));
		tempDirs.push(baseDir);

		const storage = new FileSessionStorage();
		const sessionFile = path.join(baseDir, "test-session.jsonl");
		const artifactsDir = path.join(baseDir, "test-session");
		const artifactFile = path.join(artifactsDir, "blob.txt");

		await fsp.writeFile(sessionFile, "header\n");
		await fsp.mkdir(artifactsDir, { recursive: true });
		await fsp.writeFile(artifactFile, "artifact data");

		expect(storage.existsSync(sessionFile)).toBe(true);
		expect(storage.existsSync(artifactFile)).toBe(true);

		await storage.deleteSessionWithArtifacts(sessionFile);

		expect(storage.existsSync(sessionFile)).toBe(false);
		expect(storage.existsSync(artifactFile)).toBe(false);
	});

	it("IndexedSessionStorage deletes artifacts matching stem via SqlSessionStorage", async () => {
		const storage = await SqlSessionStorage.create({ client: new SQL(":memory:") });
		const sessionFile = "/sessions/my-session.jsonl";
		const artifact1 = "/sessions/my-session/artifact1.txt";
		const artifact2 = "/sessions/my-session/nested/artifact2.txt";

		storage.writeTextSync(sessionFile, "header\n");
		storage.writeTextSync(artifact1, "data1");
		storage.writeTextSync(artifact2, "data2");
		await storage.drain();

		expect(storage.existsSync(sessionFile)).toBe(true);
		expect(storage.existsSync(artifact1)).toBe(true);
		expect(storage.existsSync(artifact2)).toBe(true);

		await storage.deleteSessionWithArtifacts(sessionFile);
		await storage.drain();

		expect(storage.existsSync(sessionFile)).toBe(false);
		expect(storage.existsSync(artifact1)).toBe(false);
		expect(storage.existsSync(artifact2)).toBe(false);
	});
});
