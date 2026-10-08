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
 * detection. Discovery snapshots must not duplicate the bundled catalog, and
 * restoring them must preserve every model and configured provider override.
 * Every retired layout, including the SHA-256 frame each installed copy wrote
 * under the current fingerprint, rebuilds instead of being served.
 *
 * The stage stores each distinct compat record once and each model an index
 * into that table; a copy per model was 64% of the file. A payload whose
 * index names no table entry, or one in the per-model layout written under the
 * previous version, rebuilds instead of restoring models with a wrong or
 * missing compat.
 *
 * What it does not catch: a new fingerprint input that remains stable across
 * these launches while changing in production (none known).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { writeModelCache } from "@veyyon/catalog/model-cache";
import { getBundledModels } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { writeJsonSnapshotSync } from "@veyyon/utils/json-snapshot";

const DAY_MS = 24 * 60 * 60 * 1000;

interface SnapshotHeader {
	frame: number;
	fingerprint: string;
	bytes: number;
	crc32: number;
}

interface SnapshotStage {
	createdAt: number;
	compats: Record<string, unknown>[];
	cachedStandard: { models: Array<Record<string, unknown>>; authoritativeFreshProviders: string[] };
	cachedDiscoveries: Array<Record<string, unknown>>;
}

describe("static model stage snapshot", () => {
	let tempDir: string;
	let authStorage: AuthStorage | undefined;
	let modelsPath: string;
	let snapshotPath: string;

	/** Fresh profile state with one cold launch already written. */
	const coldLaunch = async (config?: string): Promise<ModelRegistry> => {
		tempDir = path.join(os.tmpdir(), `pi-reg-snap-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		snapshotPath = path.join(tempDir, "resolved-models.json");
		if (config !== undefined) fs.writeFileSync(modelsPath, config);
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		return new ModelRegistry(authStorage, modelsPath, { snapshotIo: true });
	};
	const launch = (): void => {
		new ModelRegistry(authStorage!, modelsPath, { snapshotIo: true });
	};
	/**
	 * A cold launch over a model cache holding two Anthropic models with one compat record and one
	 * OpenAI model with another, so the stage has models to table and a record two of them share.
	 */
	const seededColdLaunch = async (): Promise<ModelRegistry> => {
		tempDir = path.join(os.tmpdir(), `pi-reg-snap-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		snapshotPath = path.join(tempDir, "resolved-models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const dbPath = path.join(tempDir, "models.db");
		const claude = getBundledModels("anthropic")[0]!;
		const gpt = getBundledModels("openai")[0]!;
		const claudes = ["claude-shared-a", "claude-shared-b"].map(id => ({ ...claude, id }));
		writeModelCache("anthropic", Date.now(), claudes, true, "", dbPath);
		writeModelCache("openai", Date.now(), [{ ...gpt, id: "gpt-shared-c" }], true, "", dbPath);
		return new ModelRegistry(authStorage, modelsPath, { snapshotIo: true });
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

	it("stores discovery layers without duplicating the catalog or losing configured models", async () => {
		const reference = getBundledModels("openai")[0]!;
		const cold = await coldLaunch(
			JSON.stringify({
				providers: {
					anthropic: { baseUrl: "https://example.invalid/anthropic" },
					"snapshot-custom": {
						api: "openai-completions",
						baseUrl: "https://example.invalid/v1",
						auth: "none",
						models: [{ id: reference.id, name: "Custom reference", contextWindow: 64000, maxTokens: 4000 }],
					},
				},
			}),
		);
		expect(cold.getError()).toBeUndefined();
		const expected = cold.getAll();
		const before = mtime();
		expect(Object.keys(readSnapshot().stage).sort()).toEqual([
			"cachedDiscoveries",
			"cachedStandard",
			"compats",
			"createdAt",
			"discoveryStates",
		]);

		const warm = new ModelRegistry(authStorage!, modelsPath, { snapshotIo: true });
		expect(warm.getAll()).toEqual(expected);
		expect(warm.find("snapshot-custom", reference.id)).toMatchObject({
			name: "Custom reference",
			contextWindow: 64000,
			maxTokens: 4000,
		});
		const overridden = warm.getAll().filter(model => model.provider === "anthropic");
		expect(overridden.length).toBeGreaterThan(0);
		expect(overridden.every(model => model.baseUrl === "https://example.invalid/anthropic")).toBe(true);
		expect(mtime()).toBe(before);
	});

	it("a warm launch shares one compat record among restored models that resolve it equal", async () => {
		// The stage stores resolved records, so its restore bypasses `buildModel` and the record
		// sharing it does; `models-with-equal-compat-hold-one-record` covers the catalog's paths.
		tempDir = path.join(os.tmpdir(), `pi-reg-snap-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		snapshotPath = path.join(tempDir, "resolved-models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const reference = getBundledModels("anthropic")[0]!;
		const cached = ["claude-shared-a", "claude-shared-b"].map(id => ({ ...reference, id }));
		writeModelCache("anthropic", Date.now(), cached, true, "", path.join(tempDir, "models.db"));
		launch();
		const before = mtime();

		const warm = new ModelRegistry(authStorage, modelsPath, { snapshotIo: true });

		expect(mtime()).toBe(before);
		const [a, b] = cached.map(model => warm.find("anthropic", model.id)!.compat);
		expect(a).toBe(b!);
		expect(Object.isFrozen(a)).toBe(true);
	});

	it("stores each compat record once and every model by its index", async () => {
		const cold = await seededColdLaunch();
		const { stage } = readSnapshot();
		const staged = [...stage.cachedStandard.models, ...stage.cachedDiscoveries];
		const indexOf = (id: string) => staged.find(model => model.id === id)?.compat;

		expect(staged.map(model => model.id).sort()).toEqual(["claude-shared-a", "claude-shared-b", "gpt-shared-c"]);
		expect(indexOf("claude-shared-a")).toBe(indexOf("claude-shared-b"));
		expect(indexOf("gpt-shared-c")).not.toBe(indexOf("claude-shared-a"));
		const texts = stage.compats.map(record => JSON.stringify(record));
		expect(new Set(texts).size).toBe(texts.length);
		for (const model of staged) {
			const live = cold.find(model.provider as string, model.id as string);
			expect(stage.compats[model.compat as number]).toEqual(JSON.parse(JSON.stringify(live!.compat)));
		}
	});

	const unresolvableIndexes: Array<[string, (stage: SnapshotStage) => unknown]> = [
		["an index past the table", stage => stage.compats.length],
		["a negative index", () => -1],
		["a fractional index", () => 0.5],
		["an index written as a string", () => "0"],
		["an inline compat record from the per-model layout", stage => stage.compats[0]],
	];
	it.each(unresolvableIndexes)("a stage holding %s rebuilds rather than restoring", async (_label, compatOf) => {
		await seededColdLaunch();
		const { header, stage } = readSnapshot();
		const victim = stage.cachedStandard.models[0]!;
		const expected = victim.compat;
		victim.compat = compatOf(stage);
		writeJsonSnapshotSync(snapshotPath, header.fingerprint, stage);
		const before = mtime();

		launch();

		expect(mtime()).not.toBe(before);
		expect(readSnapshot().stage.cachedStandard.models[0]!.compat).toBe(expected);
	});

	const damagedTables: Array<[string, (stage: SnapshotStage) => unknown]> = [
		["no compat table", stage => ({ ...stage, compats: undefined })],
		["a table entry that is not a record", stage => ({ ...stage, compats: [...stage.compats, 7] })],
	];
	it.each(damagedTables)("a stage with %s rebuilds rather than restoring", async (_label, damage) => {
		await seededColdLaunch();
		const { header, stage } = readSnapshot();
		writeJsonSnapshotSync(snapshotPath, header.fingerprint, damage(stage));
		const before = mtime();

		launch();

		expect(mtime()).not.toBe(before);
		expect(readSnapshot().stage.compats).toEqual(stage.compats);
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
		stage.cachedStandard.authoritativeFreshProviders.push("synthetic-corruption");
		writeSnapshot(header, stage);

		launch();

		expect(readSnapshot().stage.cachedStandard.authoritativeFreshProviders).not.toContain("synthetic-corruption");
	});

	it("a snapshot in the retired single-object format misses rather than serving", async () => {
		await coldLaunch();
		const before = mtime();
		const { header, stage } = readSnapshot();
		fs.writeFileSync(snapshotPath, JSON.stringify({ ...header, stage }));

		launch();

		expect(mtime()).not.toBe(before);
		expect(readSnapshot().stage.cachedStandard).toEqual(stage.cachedStandard);
	});

	it.each(["obsolete fingerprint version", "retired SHA-256 frame", "retired stage-digest frame"])(
		"rebuilds a retired stage with %s",
		async variant => {
			await coldLaunch();
			const { header, stage } = readSnapshot();
			const expectedProviders = [...stage.cachedStandard.authoritativeFreshProviders];
			stage.cachedStandard.authoritativeFreshProviders.push("synthetic-corruption");
			const payload = JSON.stringify(stage);
			const digest = createHash("sha256").update(payload).digest("hex");
			if (variant === "obsolete fingerprint version") {
				const retired = header.fingerprint.replace(/^\d+/, version => String(Number(version) - 1));
				writeJsonSnapshotSync(snapshotPath, retired, stage);
			} else {
				const retiredHeader =
					variant === "retired SHA-256 frame"
						? { fingerprint: header.fingerprint, payloadDigest: digest }
						: { fingerprint: header.fingerprint, stageDigest: digest };
				fs.writeFileSync(snapshotPath, `${JSON.stringify(retiredHeader)}\n${payload}`);
			}

			launch();

			expect(readSnapshot().stage.cachedStandard.authoritativeFreshProviders).toEqual(expectedProviders);
			expect(readSnapshot().header).toMatchObject({ frame: 2, fingerprint: header.fingerprint });
		},
	);

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
