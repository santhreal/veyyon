/**
 * The parsed bundled catalog leaves memory once the burst that read it is over.
 *
 * WHY: `models.ts` memoized the parsed `models.json` for the life of the process. A launch reads it
 * in one burst: the provider list, the providers the registry builds, and the reference lookups for
 * custom models. Past the burst nothing reads it until a provider not yet built is asked for, and
 * `models.json` holds the same bytes for that read. Pinned, the document was 4,406 specs and about
 * 1.2 MiB of the heap of every idle session.
 *
 * Class closed: a release that is never armed, one that fires before its window, a window that does
 * not slide with a read, a release that keeps derived data holding the specs (the model keys and the
 * reference lookup over them), a timer that keeps the process running, a provider list that parses the catalog again
 * after the release, and a re-read that returns a different catalog. Every export of `models.ts` and
 * `identity/bundled.ts` is classified below as a reader or not: the fixture runs every reader inside
 * the first window, and a new export fails the classification until it is placed.
 *
 * Reachability is observed in a fresh process (`fixtures/bundled-catalog-reachability.ts`) on a
 * virtual clock, over a WeakRef to every spec of the first parse.
 *
 * Not caught: a caller outside the catalog that keeps a spec it was handed. The fixture holds none,
 * so it observes holders reachable from catalog state only.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import * as bundled from "../src/identity/bundled";
import * as models from "../src/models";
import type { CatalogReachability } from "./fixtures/bundled-catalog-reachability";

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, "fixtures", "bundled-catalog-reachability.ts");
const MODELS = path.join(import.meta.dirname, "..", "src", "models.ts");
const FIXTURE_TIMEOUT_MS = 60_000;

/** The hold window the catalog documents: 30 s past the last read. */
const HOLD_MS = 30_000;

/** Exports that read the parsed catalog. The fixture runs each one inside the first window. */
const READERS = [
	"getBundledModel",
	"getBundledModelReferenceIndex",
	"getBundledModels",
	"getBundledProviders",
	"iterateBundledModelMetadata",
	"readBundledModelKeys",
	"resolveBundledModelReference",
];

/** Exports that never parse the catalog: cost arithmetic, the byte digest and the hooks. */
const NOT_READERS = [
	"bundledCatalogDigest",
	"calculateCost",
	"discardAttemptUsage",
	"emptyCost",
	"emptyUsage",
	"enrichedRegistryFingerprint",
	"getModelPricing",
	"hasBillableCost",
	"inheritUsageCarryovers",
	"modelsAreEqual",
	"onBundledCatalogRelease",
	"recomputeCostTotal",
	"resolveRequestCost",
	"scaleUsageCost",
	"setEnrichedRegistrySnapshotStore",
];

it("classifies every catalog export as a reader or not", () => {
	const exported = [...Object.keys(models), ...Object.keys(bundled)].sort();
	expect(exported).toEqual([...READERS, ...NOT_READERS].sort());
});

describe("the parsed catalog in a fresh process", () => {
	let reachability: CatalogReachability;

	beforeAll(async () => {
		const { stdout, stderr } = await run(process.execPath, [FIXTURE, String(HOLD_MS)], {
			timeout: FIXTURE_TIMEOUT_MS - 5_000,
			killSignal: "SIGKILL",
		});
		expect(stderr).toBe("");
		reachability = JSON.parse(stdout) as CatalogReachability;
	}, FIXTURE_TIMEOUT_MS);

	it("arms its release for the hold window and no other delay", () => {
		expect(reachability.holdDelaysMs).toEqual([HOLD_MS]);
	});

	it("holds every spec until the window of its read closes", () => {
		expect(reachability.specs).toBeGreaterThan(0);
		expect(reachability.reachableBeforeWindowEnd).toBe(reachability.specs);
	});

	it("starts a new window with each read", () => {
		expect(reachability.reachableAfterSlide).toBe(reachability.specs);
	});

	it("holds no spec once the window of the last read closes", () => {
		expect(reachability.reachableAfterRelease).toBe(0);
	});

	it("lists the providers after a release without parsing the catalog again", () => {
		expect(reachability.providerListParsed).toBe(false);
	});

	it("serves the same catalog and reference lookups after a release", () => {
		expect(reachability.reparsedEqual).toBe(true);
		expect(reachability.referenceBefore).toBe("claude-sonnet-4-5");
		expect(reachability.referenceAfter).toBe(reachability.referenceBefore);
	});
});

it(
	"lets a process that read the catalog exit inside the hold window",
	async () => {
		const script = `const m = await import(${JSON.stringify(MODELS)}); m.getBundledProviders(); m.getBundledModels("anthropic");`;
		const started = performance.now();
		await run(process.execPath, ["-e", script], { timeout: HOLD_MS / 2, killSignal: "SIGKILL" });
		expect(performance.now() - started).toBeLessThan(HOLD_MS / 2);
	},
	HOLD_MS,
);
