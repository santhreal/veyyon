/**
 * A launch builds the bundled models of the providers it holds a credential for, and of no other.
 *
 * WHY: every launch ran the discovery refresh, collected usage reports and constructed its `Agent`,
 * and two of those built providers the session could not use. A discovery manager created its
 * reference resolver by indexing every bundled provider, so one keyed provider with such a manager
 * built all 4,400 catalog models, and `Agent` read its fallback Google model before the caller's model
 * replaced it, so every session built the Google provider.
 *
 * THE CLASS THIS CLOSES. Any launch step that builds a provider other than the one it serves: a
 * cross-provider index, a fallback read before the caller's value, a base URL or cache id read off a
 * built model list. The fixture runs the launch in a fresh process, so the catalog's per-provider memo
 * starts empty, and observes `buildModel`, the one function every catalog spec passes through. The
 * providers are swept from the catalog at run time and keyed in a bit partition: run `b` keys the
 * providers whose sweep index has bit `b` set, its twin keys the rest, so every ordered pair of
 * providers is keyed and unkeyed in one run and a provider built on behalf of another is seen unkeyed.
 * The providers a launch discovers without a credential are pinned by exact equality, so a new one
 * fails the suite until it is recorded here.
 *
 * NOT COVERED: which of its keyed providers a launch builds (building none would pass), and launch
 * steps outside the refresh, the usage reports and the `Agent` constructor, such as the model picker.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { getBundledProviders } from "@veyyon/catalog/models";
import { CATALOG_PROVIDERS } from "@veyyon/catalog/provider-models";
import { TempDir } from "@veyyon/utils";
import type { LaunchProviderBuilds } from "../fixtures/launch-provider-builds";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "launch-provider-builds.ts");
const CONFIG_PROVIDER = "launch-config";
const MODELS_CONFIG = `providers:
  ${CONFIG_PROVIDER}:
    baseUrl: http://127.0.0.1:0/v1
    api: openai-completions
    auth: none
    models:
      - id: launch-model
        name: Launch Model
        reasoning: false
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 8192
        maxTokens: 4096
`;

/**
 * Providers whose runtime descriptor discovers without a credential and that have bundled models:
 * the discovery manager builds the bundled list as the base it merges discovered models into.
 */
const DISCOVERED_WITHOUT_CREDENTIAL = ["google-vertex", "zenmux"];

const PROVIDERS = [...new Set([...getBundledProviders(), ...CATALOG_PROVIDERS.map(provider => provider.id)])].sort();
const BITS = Math.ceil(Math.log2(PROVIDERS.length));
const CONCURRENCY = 4;

const run = promisify(execFile);
const spawnEnv = hermeticSpawnEnv();
let tmp: TempDir;

async function launch(name: string, keyed: readonly string[]): Promise<string[]> {
	const dir = path.join(tmp.path(), name);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "models.yml"), MODELS_CONFIG);
	const { stdout, stderr } = await run(process.execPath, [FIXTURE, dir, CONFIG_PROVIDER, keyed.join(",")], {
		env: spawnEnv.env,
		maxBuffer: 16 * 1024 * 1024,
	});
	expect(stderr).toBe("");
	return (JSON.parse(stdout) as LaunchProviderBuilds).built;
}

/** Keyed sets whose runs key and unkey every ordered pair of providers at least once. */
function partitions(): Array<{ name: string; keyed: string[] }> {
	const sets: Array<{ name: string; keyed: string[] }> = [];
	for (let bit = 0; bit < BITS; bit++) {
		const on = PROVIDERS.filter((_, index) => ((index >> bit) & 1) === 1);
		const off = PROVIDERS.filter((_, index) => ((index >> bit) & 1) === 0);
		sets.push({ name: `bit-${bit}-on`, keyed: on }, { name: `bit-${bit}-off`, keyed: off });
	}
	return sets;
}

async function pooled<T, R>(items: readonly T[], worker: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const lanes = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await worker(items[index]!);
		}
	});
	await Promise.all(lanes);
	return results;
}

beforeAll(async () => {
	tmp = await TempDir.create("@launch-provider-builds-");
});

afterAll(async () => {
	await tmp.remove();
	spawnEnv.cleanup();
});

describe("an interactive launch", () => {
	it("builds only the providers it discovers without a credential when it holds none", async () => {
		expect(await launch("unkeyed", [])).toEqual(DISCOVERED_WITHOUT_CREDENTIAL);
	});

	it("builds no provider on behalf of a provider it holds a credential for", async () => {
		const sets = partitions();
		const builds = await pooled(sets, set => launch(set.name, set.keyed));
		const unexpected = sets.flatMap((set, index) => {
			const allowed = new Set([...set.keyed, ...DISCOVERED_WITHOUT_CREDENTIAL]);
			return builds[index]!.filter(provider => !allowed.has(provider)).map(provider => `${set.name}: ${provider}`);
		});
		expect(unexpected).toEqual([]);
		// Every pair is covered only if every provider was keyed in some run and unkeyed in another.
		for (const provider of PROVIDERS) {
			expect(sets.filter(set => set.keyed.includes(provider)).length).toBe(BITS);
		}
	}, 120_000);
});
