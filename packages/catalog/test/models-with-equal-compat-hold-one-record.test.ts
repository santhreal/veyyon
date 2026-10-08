/**
 * Models whose resolved compat is equal hold one record between them.
 *
 * WHY: `buildCompat` allocates a record per model, and the bundled catalog resolves 4,406 models
 * over 164 distinct records. Each copy held about 430 bytes of fields plus a `reasoningEffortMap`
 * of its own, so a process that materialized the catalog retained 1.7 MiB of duplicates. The
 * class this closes: a path that brings a model into the process holding a compat record equal to
 * a live one without being that record. `buildModel` shares every record it builds, and the
 * snapshot restores that bypass it share every record they parse; the registry's static-stage
 * restore is covered in `the-static-model-stage-snapshot-hits-unless-cache-content-changes`.
 *
 * A shared record is frozen through every nested value, so a write through one model throws
 * instead of reaching every model that holds the record. The table that finds a record holds it
 * weakly: a record no model holds is released.
 *
 * NOT COVERED: a path that constructs a `Model` with neither `buildModel` nor a snapshot restore,
 * and two records that differ only in the key order of an own `undefined` field, which strict
 * deep equality treats as equal.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// Relative imports, not `@veyyon/catalog/...`: the workspace `node_modules` link resolves to the
// primary checkout rather than to a worktree, so the package specifier would test other source.
import { shareCompat } from "../src/compat/share";
import { getBundledModels, getBundledProviders } from "../src/models";
import { createEnrichedRegistrySnapshotStore } from "../src/registry-snapshot";
import type { Api, Model } from "../src/types";
import type { SharedGrowth } from "./fixtures/shared-compat-growth";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "shared-compat-growth.ts");

function bundledModels(): Model<Api>[] {
	return getBundledProviders().flatMap(provider => getBundledModels(provider));
}

/** Partitions records into classes of strict deep equality. */
function equalityClasses(records: readonly object[]): object[][] {
	const byJson = new Map<string, object[][]>();
	for (const record of records) {
		const json = JSON.stringify(record);
		let classes = byJson.get(json);
		if (!classes) {
			classes = [];
			byJson.set(json, classes);
		}
		const match = classes.find(members => Bun.deepEquals(members[0], record, true));
		if (match) match.push(record);
		else classes.push([record]);
	}
	return [...byJson.values()].flat();
}

function nestedObjects(value: object): object[] {
	const out = [value];
	for (const item of Object.values(value)) {
		if (item !== null && typeof item === "object") out.push(...nestedObjects(item));
	}
	return out;
}

/** Runs the fixture over `records` distinct records in a fresh process. */
function shareInChild(records: number): SharedGrowth {
	const run = spawnSync(process.execPath, [FIXTURE, String(records)], { encoding: "utf8" });
	expect(run.stderr).toBe("");
	return JSON.parse(run.stdout) as SharedGrowth;
}

/** JSON of every equality class whose members are more than one object. */
function splitClasses(records: readonly object[]): string[] {
	return equalityClasses(records)
		.filter(members => new Set(members).size !== 1)
		.map(members => JSON.stringify(members[0]));
}

function compatRecords(models: Iterable<Model<Api>>): object[] {
	const out: object[] = [];
	for (const model of models) if (model.compat !== undefined) out.push(model.compat);
	return out;
}

describe("models with equal compat", () => {
	it("hold one record across the bundled catalog", () => {
		const records = compatRecords(bundledModels());
		expect(splitClasses(records)).toEqual([]);
		// The catalog does repeat records; a sweep over one model per record would prove nothing.
		expect(equalityClasses(records).length).toBeLessThan(records.length / 10);
	});

	it("hold a record frozen through every nested value", () => {
		const records = new Set(compatRecords(bundledModels()));
		const unfrozen = [...records].flatMap(record => nestedObjects(record).filter(value => !Object.isFrozen(value)));
		expect(unfrozen).toEqual([]);
		const model = bundledModels().find(candidate => candidate.compat !== undefined)!;
		expect(() => {
			(model.compat as unknown as Record<string, unknown>).supportsStore = "written through one model";
		}).toThrow(TypeError);
	});

	it("hold one record when restored from the catalog snapshot", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-shared-compat-"));
		try {
			const store = createEnrichedRegistrySnapshotStore(path.join(dir, "models.db"));
			const built = new Map<string, Map<string, Model<Api>>>();
			for (const provider of getBundledProviders()) {
				built.set(provider, new Map(getBundledModels(provider).map(model => [model.id, model])));
			}
			store.write(built, "v-test:shared-compat");
			const restored = [...store.read("v-test:shared-compat")!.values()].flatMap(models => [...models.values()]);
			expect(restored).toHaveLength(bundledModels().length);
			// JSON drops a built record's own `undefined` fields, so a restored record equals another
			// restored record, and a built one only when the built one had no such field.
			const restoredRecords = compatRecords(restored);
			expect(splitClasses([...restoredRecords, ...compatRecords(bundledModels())])).toEqual([]);
			expect(restoredRecords.filter(record => !Object.isFrozen(record))).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("shareCompat", () => {
	/** A field no record from another test holds, so each test starts from an empty class. */
	let tags = 0;
	const nextTag = (): string => `probe-${++tags}`;
	/** `[<hole>, 1]`: index 0 is absent, not `undefined`. */
	const holeThenOne = (): number[] => {
		const list: number[] = [];
		list[1] = 1;
		return list;
	};

	it("returns the live record equal to a fresh copy", () => {
		const tag = nextTag();
		const make = () => ({ probe: tag, map: { low: "low", high: "high" }, list: [1, 2] });
		const first = shareCompat(make());
		expect(shareCompat(make())).toBe(first);
	});

	it.each([
		["an own undefined field", () => ({ extra: undefined }), () => ({})],
		["negative zero", () => ({ value: -0 }), () => ({ value: 0 })],
		["NaN", () => ({ value: Number.NaN }), () => ({ value: null })],
		["Infinity", () => ({ value: Number.POSITIVE_INFINITY }), () => ({ value: null })],
		["an array hole", () => ({ list: holeThenOne() }), () => ({ list: [undefined, 1] })],
		["a nested undefined field", () => ({ map: { low: undefined } }), () => ({ map: {} })],
	])("keeps records that JSON prints alike apart when they differ by %s", (_name, left, right) => {
		const tag = nextTag();
		const a = shareCompat({ probe: tag, ...left() });
		const b = shareCompat({ probe: tag, ...right() });
		expect(b).not.toBe(a);
		expect(shareCompat({ probe: tag, ...left() })).toBe(a);
		expect(shareCompat({ probe: tag, ...right() })).toBe(b);
	});

	it("passes a missing record through", () => {
		expect(shareCompat(undefined)).toBeUndefined();
		expect(shareCompat(null)).toBeNull();
	});

	it("retains no record once nothing holds it", () => {
		const small = shareInChild(1_000);
		const large = shareInChild(20_000);
		expect(large.records - small.records).toBe(19_000);
		// A strong table holds each 256-character record: about 10 MiB for the extra 19,000. A weak table
		// that never drops its collected entries holds about 2.5 MiB of references and keys.
		expect(large.grown - small.grown).toBeLessThan(512 * 1024);
	});
});
