/**
 * WHY: the registry's static-stage snapshot (`resolved-models.json`) originally
 * keyed its fingerprint on file stamps of `models.db` and its `-wal`/`-shm`
 * sidecars. SQLite moves those sidecars on every connection, so the launch
 * after every write — including the writer's own — always missed, rebuilt and
 * rewrote a 12 MB file per launch; and `authoritativeFreshProviders` was
 * serialized as a `Set`, which JSON turns into `{}`, so the reader's
 * `Array.isArray` guard rejected EVERY restore regardless. The class this
 * closes: a persisted snapshot whose validity is decided by anything other
 * than the content it mirrors, or whose parseable payload can change without
 * detection.
 *
 * What it does not catch: a new fingerprint input that remains stable across
 * these launches while changing in production (none known).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeModelCache } from "@veyyon/catalog/model-cache";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

const DAY_MS = 24 * 60 * 60 * 1000;

interface SnapshotHeader {
	fingerprint: string;
	stageDigest: string;
}

interface SnapshotStage {
	createdAt: number;
	builtIn: Array<{ contextWindow: number }>;
}

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
	/**
	 * The snapshot is one header line then the stage payload, so a test that
	 * wants either half reads them apart rather than parsing the whole file.
	 */
	const readSnapshot = (): { header: SnapshotHeader; stage: SnapshotStage } => {
		const bytes = fs.readFileSync(snapshotPath);
		const split = bytes.indexOf(0x0a);
		return {
			header: JSON.parse(bytes.toString("utf8", 0, split)) as SnapshotHeader,
			stage: JSON.parse(bytes.toString("utf8", split + 1)) as SnapshotStage,
		};
	};
	const writeSnapshot = (header: SnapshotHeader, stage: SnapshotStage): void => {
		fs.writeFileSync(snapshotPath, `${JSON.stringify(header)}\n${JSON.stringify(stage)}`);
	};

	afterEach(() => {
		vi.restoreAllMocks();
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

	it("a refresh that re-verifies unchanged content keeps the snapshot", async () => {
		// This is the shape of an ordinary launch: a local-server provider re-probes
		// and writes the same catalog back with a new timestamp. Treating that as a
		// model change meant the stage was rebuilt at every start, which is the
		// whole cost this snapshot exists to remove.
		await coldLaunch();
		const before = mtime();
		const dbPath = path.join(tempDir, "models.db");
		writeModelCache("scratch-provider", Date.now(), [], true, "", dbPath);
		launch();
		const afterFirstWrite = mtime();

		writeModelCache("scratch-provider", Date.now(), [], true, "", dbPath);
		launch();

		expect(afterFirstWrite).not.toBe(before);
		expect(mtime()).toBe(afterFirstWrite);
	});

	it("rebuilds once a cached row crosses the freshness TTL", async () => {
		// The stage persists "this row was fresh and authoritative". No row has to
		// move for that verdict to expire, so a launch a day later must not serve it.
		tempDir = path.join(os.tmpdir(), `pi-reg-snap-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		snapshotPath = path.join(tempDir, "resolved-models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const initialNow = Date.now() + 1_000;
		const now = vi.spyOn(Date, "now").mockReturnValue(initialNow);
		writeModelCache("anthropic", initialNow, [], true, "", path.join(tempDir, "models.db"));

		launch();
		const fresh = mtime();
		launch();
		expect(mtime()).toBe(fresh);

		now.mockReturnValue(initialNow + DAY_MS + 1);
		launch();
		const expired = readSnapshot().stage;

		expect(mtime()).not.toBe(fresh);
		expect(expired.createdAt).toBe(initialNow + DAY_MS + 1);
	});

	it("restores configured-provider discovery state on a snapshot hit", async () => {
		tempDir = path.join(os.tmpdir(), `pi-reg-snap-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		snapshotPath = path.join(tempDir, "resolved-models.json");
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  scratch:",
				"    baseUrl: http://127.0.0.1:12345/v1",
				"    api: openai-completions",
				"    auth: none",
				"    discovery:",
				"      type: openai-models-list",
				"",
			].join("\n"),
		);
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const cachedAt = Date.now() + 1_000;
		vi.spyOn(Date, "now").mockReturnValue(cachedAt);
		writeModelCache("scratch:openai-models-list-context-v2", cachedAt, [], true, "", path.join(tempDir, "models.db"));

		const cold = new ModelRegistry(authStorage, modelsPath, { snapshotIo: true });
		const expected = cold.getProviderDiscoveryState("scratch");
		expect(expected).toMatchObject({ provider: "scratch", status: "cached", stale: false });
		const before = mtime();

		const warm = new ModelRegistry(authStorage, modelsPath, { snapshotIo: true });
		expect(warm.getProviderDiscoveryState("scratch")).toEqual(expected);
		expect(mtime()).toBe(before);
	});

	it("a corrupt snapshot misses and is rewritten valid", async () => {
		await coldLaunch();
		fs.writeFileSync(snapshotPath, "{not json at all");

		launch();

		expect(typeof readSnapshot().header.fingerprint).toBe("string");
	});

	it("a parseable stage whose content does not match its digest is rebuilt", async () => {
		await coldLaunch();
		const { header, stage } = readSnapshot();
		stage.builtIn[0]!.contextWindow = 1;
		writeSnapshot(header, stage);

		launch();

		expect(readSnapshot().stage.builtIn[0]!.contextWindow).not.toBe(1);
	});

	it("a snapshot in the retired single-object format misses rather than serving", async () => {
		await coldLaunch();
		const before = mtime();
		const { header, stage } = readSnapshot();
		fs.writeFileSync(snapshotPath, JSON.stringify({ ...header, stage }));

		launch();

		expect(mtime()).not.toBe(before);
		expect(readSnapshot().stage.builtIn.length).toBeGreaterThan(0);
	});

	it("a snapshot naming another fingerprint misses rather than serving", async () => {
		await coldLaunch();
		const before = mtime();
		const { header, stage } = readSnapshot();
		writeSnapshot({ ...header, fingerprint: "something-else" }, stage);

		launch();

		expect(readSnapshot().header.fingerprint).not.toBe("something-else");
		expect(mtime()).not.toBe(before);
	});
});
