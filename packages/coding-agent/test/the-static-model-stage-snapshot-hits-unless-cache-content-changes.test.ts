/**
 * WHY: the registry's static-stage snapshot (`resolved-models.json`) originally
 * keyed its fingerprint on file stamps of `models.db` and its `-wal`/`-shm`
 * sidecars. SQLite moves those sidecars on every connection, so the launch
 * after every write — including the writer's own — always missed, rebuilt and
 * rewrote a 12 MB file per launch; and `authoritativeFreshProviders` was
 * serialized as a `Set`, which JSON turns into `{}`, so the reader's
 * `Array.isArray` guard rejected EVERY restore regardless. The class this
 * closes: a persisted snapshot whose validity is decided by anything other
 * than the content it mirrors.
 *
 * What it does not catch: a fingerprint input added outside
 * `#staticModelStageFingerprint`'s parts array in a way that stays stable
 * across these launches while still churning in production (none known).
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeModelCache } from "@veyyon/catalog/model-cache";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

describe("static model stage snapshot", () => {
	let tempDir: string;
	let authStorage: AuthStorage | undefined;
	let modelsPath: string;
	let snapshotPath: string;

	/** Fresh profile state with one cold launch already written. */
	const coldLaunch = async (): Promise<void> => {
		tempDir = path.join(os.tmpdir(), `pi-reg-snap-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		snapshotPath = path.join(tempDir, "resolved-models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		new ModelRegistry(authStorage, modelsPath, { snapshotIo: true });
	};
	const launch = (): void => {
		new ModelRegistry(authStorage!, modelsPath, { snapshotIo: true });
	};
	const mtime = (): number => fs.statSync(snapshotPath).mtimeMs;

	afterEach(() => {
		authStorage?.close();
		authStorage = undefined;
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("a cold launch writes the snapshot beside the relocated database", async () => {
		await coldLaunch();

		expect(fs.existsSync(snapshotPath)).toBe(true);
		expect(fs.statSync(snapshotPath).size).toBeGreaterThan(0);
	});

	it("a warm launch hits the snapshot instead of rewriting it", async () => {
		await coldLaunch();
		const before = mtime();

		launch();

		expect(mtime()).toBe(before);
	});

	it("sqlite sidecar mtime churn does not invalidate the snapshot", async () => {
		await coldLaunch();
		const before = mtime();
		// What an unrelated SQLite connection leaves behind: sidecars whose mtimes
		// moved without any row content changing.
		const dbPath = path.join(tempDir, "models.db");
		for (const suffix of ["-wal", "-shm"]) {
			fs.writeFileSync(dbPath + suffix, "not-a-real-wal");
		}
		fs.utimesSync(dbPath, new Date(), new Date());
		for (const suffix of ["-wal", "-shm"]) {
			fs.utimesSync(dbPath + suffix, new Date(), new Date());
		}

		launch();

		expect(mtime()).toBe(before);
	});

	it("a cache row write invalidates the snapshot", async () => {
		await coldLaunch();
		const before = mtime();

		writeModelCache("scratch-provider", Date.now(), [], true, "", path.join(tempDir, "models.db"));
		launch();

		expect(mtime()).not.toBe(before);
	});

	it("a corrupt snapshot misses and is rewritten valid", async () => {
		await coldLaunch();
		fs.writeFileSync(snapshotPath, "{not json at all");

		launch();

		const parsed = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as unknown;
		expect(typeof parsed === "object" && parsed !== null && "fingerprint" in parsed).toBe(true);
	});

	it("a snapshot naming another fingerprint misses rather than serving", async () => {
		await coldLaunch();
		const before = mtime();
		const parsed = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as { fingerprint: string };
		parsed.fingerprint = "something-else";
		fs.writeFileSync(snapshotPath, JSON.stringify(parsed));

		launch();

		const reread = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as { fingerprint: string };
		expect(reread.fingerprint).not.toBe("something-else");
		expect(mtime()).not.toBe(before);
	});
});
