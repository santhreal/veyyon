/**
 * A models config the validator accepted once loads again, in a later process, from a snapshot of
 * the accepted value, without building the validator; anything that could change the answer
 * validates again.
 *
 * WHY: every launch with a models.yml built the whole models-config ArkType schema to validate a file
 * that had not changed since the last launch: 29 ms, 495 schema nodes and 4.3 MiB of heap, held for
 * the life of the process by ArkType's process-global node registry, so releasing the schema object
 * frees none of it. `ConfigFile` keeps the value a deferred schema accepted, keyed by the
 * validator's fingerprint, the read path and the content, and serves it while all three match.
 *
 * THE CLASS THIS CLOSES. A served value that differs from what validation returns, and a served
 * value validation would not have returned:
 * - every models.yml example in the handbook the schema accepts, swept from the handbook at run
 *   time, and every branch of the thinking pipe, served and compared with direct validation;
 * - a value JSON does not reproduce (`Infinity`, `-0`, an `undefined` property, a `Date`), which is
 *   never kept, so it validates on every load;
 * - a changed byte, the same bytes at another path, another validator fingerprint, and a damaged
 *   snapshot, each of which validates again;
 * - the file's own checks after the schema (a retired key), which still run on a served value;
 * - a rejected file, which is reported on every load;
 * - a validator fingerprint that depends on whether the process evaluated ArkType before the
 *   first read, which the deferred ArkType facade makes possible.
 * Serving is observed by making the validator's builder throw: a load that builds it fails. The
 * production path is measured in fresh processes through ArkType's node registry and the heap.
 *
 * NOT COVERED: that `modelsConfigSchemaFingerprint` moves when the builder's source, the effort
 * ladder, the product version or the ArkType release moves. The digest reads all four, and none
 * of them can change inside one test process.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ConfigFile, deferSchema, type LoadResult } from "@veyyon/coding-agent/config/config-file";
import { ModelsConfigFile } from "@veyyon/coding-agent/config/models-config";
import * as schemaModule from "@veyyon/coding-agent/config/models-config-schema";
import { getModelDbPath, TempDir } from "@veyyon/utils";
import { type } from "arktype";
import { YAML } from "bun";
import type { ModelsConfigLoad } from "../fixtures/models-config-load";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir();

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const HANDBOOK = path.join(REPO_ROOT, "docs", "handbook", "src");
const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "models-config-load.ts");

/**
 * Handbook `providers:` blocks the models-config schema rejects: settings-file `providers:` maps
 * and a placeholder. Pinned by exact equality, so a new rejected example names itself.
 */
const REJECTED_HANDBOOK_EXAMPLES = ["features/web-search.md#0", "reference/models-yml.md#0", "reference/settings.md#0"];

interface HandbookExample {
	id: string;
	content: string;
}

function handbookExamples(): HandbookExample[] {
	const examples: HandbookExample[] = [];
	for (const relative of fs.readdirSync(HANDBOOK, { recursive: true, encoding: "utf8" }).sort()) {
		if (!relative.endsWith(".md")) continue;
		const source = fs.readFileSync(path.join(HANDBOOK, relative), "utf8");
		let index = 0;
		for (const match of source.matchAll(/```ya?ml\n([\s\S]*?)```/g)) {
			if (!/^providers:/m.test(match[1])) continue;
			examples.push({ id: `${relative.split(path.sep).join("/")}#${index}`, content: match[1] });
			index++;
		}
	}
	return examples;
}

/** Every branch of the thinking pipe, plus overrides, compat, discovery and headers. */
const THINKING_PIPE_CONFIG = `providers:
  ladder:
    baseUrl: https://ladder.example.com/v1
    api: openai-completions
    apiKey: literal:TEST_KEY
    headers: { x-team: core }
    discovery: { type: ollama }
    compat:
      supportsStore: false
      reasoningEffortMap: { xhigh: high }
      whenThinking: { supportsSamplingParams: false }
    models:
      - id: efforts
        thinking: { mode: effort, efforts: [low, high], defaultLevel: high, effortMap: { low: low }, supportsDisplay: true }
      - id: levels
        thinking: { mode: budget, levels: [minimal, medium] }
      - id: range
        thinking: { mode: anthropic-adaptive, minLevel: low, maxLevel: max }
        cost: { input: 1.5, output: 3, cacheRead: 0.1, cacheWrite: 0 }
        input: [text, image]
    modelOverrides:
      some-model:
        thinking: { mode: google-level, minLevel: minimal, maxLevel: high }
        cost: { input: 1 }
`;

/** A provider with one model `m`, with `modelLines` under the model and `providerLines` under the provider. */
function oneModelConfig(modelLines: string, providerLines = ""): string {
	return `providers:\n  p:\n    baseUrl: https://p.example.com/v1\n    api: openai-completions\n    apiKey: literal:TEST_KEY\n${providerLines}    models:\n      - id: m\n${modelLines}`;
}

let fileCounter = 0;

/** Write `content` to a fresh models file under the isolated agent dir. */
function modelsFile(content: string, name = "models.yml"): string {
	const dir = path.join(path.dirname(getModelDbPath()), "models-files", String(fileCounter++));
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, content);
	return file;
}

function load(file: string): LoadResult<unknown> {
	return ModelsConfigFile.relocate(file).tryLoad();
}

/** Load `file` while building the validator throws, so only a served value loads. */
function loadWithoutValidator(file: string): LoadResult<unknown> {
	const build = spyOn(schemaModule, "modelsConfigSchemas").mockImplementation(() => {
		throw new Error("the models-config validator was built");
	});
	try {
		return load(file);
	} finally {
		build.mockRestore();
	}
}

function validatorBuildFailure(result: LoadResult<unknown>): string | undefined {
	if (result.status !== "error") return undefined;
	const cause = result.error.other?.err;
	return cause instanceof Error ? cause.message : undefined;
}

function snapshotPath(): string {
	return path.join(path.dirname(getModelDbPath()), "accepted-models-config.json");
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a models config accepted once is served without building its validator", () => {
	const examples = handbookExamples();
	const accepted = examples.filter(example => {
		const checked = schemaModule.modelsConfigSchemas().ModelsConfigSchema(YAML.parse(example.content));
		return !(checked instanceof type.errors);
	});

	it("sweeps every models.yml example in the handbook", () => {
		expect(examples.length).toBeGreaterThan(REJECTED_HANDBOOK_EXAMPLES.length);
		expect(examples.filter(example => !accepted.includes(example)).map(example => example.id)).toEqual(
			REJECTED_HANDBOOK_EXAMPLES,
		);
	});

	for (const [id, content] of [
		...accepted.map(example => [example.id, example.content] as const),
		["the thinking pipe", THINKING_PIPE_CONFIG] as const,
	]) {
		it(`serves ${id} as validation returns it`, () => {
			const expected = schemaModule.modelsConfigSchemas().ModelsConfigSchema(YAML.parse(content));
			const file = modelsFile(content);

			const first = load(file);
			const served = loadWithoutValidator(file);

			expect(first).toEqual({ status: "ok", value: expected });
			expect(served).toEqual({ status: "ok", value: expected });
		});
	}
});

describe("anything that could change the answer validates again", () => {
	it("a changed byte", () => {
		const file = modelsFile(THINKING_PIPE_CONFIG);
		expect(load(file).status).toBe("ok");

		fs.writeFileSync(file, THINKING_PIPE_CONFIG.replace("id: efforts", "id: effortz"));

		expect(validatorBuildFailure(loadWithoutValidator(file))).toBe("the models-config validator was built");
		const reloaded = load(file);
		expect(reloaded.status === "ok" && JSON.stringify(reloaded.value)).toContain('"id":"effortz"');
	});

	it("the same bytes at another path", () => {
		expect(load(modelsFile(THINKING_PIPE_CONFIG)).status).toBe("ok");

		const elsewhere = modelsFile(THINKING_PIPE_CONFIG);

		expect(validatorBuildFailure(loadWithoutValidator(elsewhere))).toBe("the models-config validator was built");
	});

	it("another validator fingerprint", () => {
		const file = modelsFile(THINKING_PIPE_CONFIG);
		expect(load(file).status).toBe("ok");

		spyOn(schemaModule, "modelsConfigSchemaFingerprint").mockReturnValue("another validator");

		expect(validatorBuildFailure(loadWithoutValidator(file))).toBe("the models-config validator was built");
	});

	for (const [label, damage] of [
		["a truncated snapshot", (bytes: Buffer) => bytes.subarray(0, bytes.length - 5)],
		["a flipped payload byte", (bytes: Buffer) => Buffer.from(bytes).fill(0x20, bytes.length - 3, bytes.length - 2)],
		["an empty snapshot", () => Buffer.alloc(0)],
	] as const) {
		it(label, () => {
			const file = modelsFile(THINKING_PIPE_CONFIG);
			const expected = load(file);
			expect(expected.status).toBe("ok");

			fs.writeFileSync(snapshotPath(), damage(fs.readFileSync(snapshotPath())));

			expect(validatorBuildFailure(loadWithoutValidator(file))).toBe("the models-config validator was built");
			expect(load(file)).toEqual(expected);
		});
	}
});

describe("a value JSON does not reproduce is validated on every load", () => {
	for (const [label, content] of [
		["an infinite token limit", oneModelConfig("        maxTokens: .inf\n")],
		[
			"a negative zero cost",
			oneModelConfig("        cost: { input: -0.0, output: 0, cacheRead: 0, cacheWrite: 0 }\n"),
		],
	] as const) {
		it(`in a models config: ${label}`, () => {
			const file = modelsFile(content);
			expect(load(file).status).toBe("ok");

			expect(validatorBuildFailure(loadWithoutValidator(file))).toBe("the models-config validator was built");
		});
	}

	for (const [label, output] of [
		["an undefined property", (value: object) => ({ ...value, absent: undefined })],
		["a date", (value: object) => ({ ...value, at: new Date(0) })],
	] as const) {
		it(`in any deferred schema: ${label}`, () => {
			using dir = TempDir.createSync("@accepted-value-");
			const accepted = { path: () => path.join(dir.path(), "snapshot.json"), fingerprint: () => "probe" };
			const file = path.join(dir.path(), "probe.yml");
			fs.writeFileSync(file, "name: probe\n");
			const schema = () => type({ name: "string" }).pipe(value => output(value));

			const first = new ConfigFile<object>("probe", deferSchema(schema, accepted), file).tryLoad();
			const second = new ConfigFile<object>(
				"probe",
				deferSchema(() => {
					throw new Error("the probe validator was built");
				}, accepted),
				file,
			).tryLoad();

			expect(first.status).toBe("ok");
			expect(validatorBuildFailure(second)).toBe("the probe validator was built");
		});
	}

	it("while a value JSON reproduces is served by any deferred schema", () => {
		using dir = TempDir.createSync("@accepted-value-");
		const accepted = { path: () => path.join(dir.path(), "snapshot.json"), fingerprint: () => "probe" };
		const file = path.join(dir.path(), "probe.yml");
		fs.writeFileSync(file, "name: probe\n");

		new ConfigFile<object>(
			"probe",
			deferSchema(() => type({ name: "string" }), accepted),
			file,
		).tryLoad();
		const second = new ConfigFile<object>(
			"probe",
			deferSchema(() => {
				throw new Error("the probe validator was built");
			}, accepted),
			file,
		).tryLoad();

		expect(second).toEqual({ status: "ok", value: { name: "probe" } });
	});
});

describe("what the schema does not decide is decided on every load", () => {
	it("a retired key the schema accepts is refused on a served load", () => {
		const content = oneModelConfig("", "    remoteCompaction: true\n");
		const file = modelsFile(content);

		const first = load(file);
		const second = loadWithoutValidator(file);

		expect(first.status === "error" && first.error.other?.stage).toBe("Validate(models)");
		expect(second.status === "error" && second.error.other?.stage).toBe("Validate(models)");
		expect(second.status === "error" && second.error.message).toContain("remoteCompaction");
		expect(second.status === "error" && second.error.message).toBe(
			first.status === "error" ? first.error.message : "",
		);
	});

	it("a rejected file is reported on every load", () => {
		const content = "providers:\n  p:\n    baseUrl: ''\n";
		const file = modelsFile(content);

		const first = load(file);
		const second = load(file);

		expect(first.status === "error" && first.error.schemaErrors?.map(error => error.instancePath)).toEqual([
			"providers.p",
		]);
		expect(second.status === "error" && second.error.schemaErrors).toEqual(
			first.status === "error" ? first.error.schemaErrors : null,
		);
	});
});

describe("a later launch builds no validator for an unchanged models config", () => {
	it("evaluates no ArkType module, registers no schema node and retains a fraction of the first launch", () => {
		const spawn = hermeticSpawnEnv();
		try {
			const file = path.join(spawn.home, "models.yml");
			fs.writeFileSync(file, THINKING_PIPE_CONFIG);
			const run = (): ModelsConfigLoad => {
				const result = spawnSync(process.execPath, [FIXTURE, file], { env: spawn.env, encoding: "utf8" });
				if (result.status !== 0) throw new Error(`fixture failed: ${result.stderr}`);
				return JSON.parse(result.stdout) as ModelsConfigLoad;
			};

			const first = run();
			const later = run();

			expect(first.status).toBe("ok");
			expect(first.arktypeEvaluated).toBe(true);
			expect(first.registeredNodes).toBeGreaterThan(100);
			expect(first.retained).toBeGreaterThan(2 * 1024 * 1024);
			expect(later).toEqual({ ...first, arktypeEvaluated: false, registeredNodes: 0, retained: later.retained });
			expect(later.retained).toBeLessThan(256 * 1024);
		} finally {
			spawn.cleanup();
		}
	});
});

describe("the validator fingerprint", () => {
	it("is the same whether or not the process has evaluated arktype", () => {
		const fingerprint = (prelude: string): string => {
			const code = `${prelude}
const { modelsConfigSchemaFingerprint } = await import("./packages/coding-agent/src/config/models-config-schema.ts");
process.stdout.write(modelsConfigSchemaFingerprint());`;
			const result = spawnSync(process.execPath, ["-e", code], { cwd: REPO_ROOT, encoding: "utf8" });
			if (result.status !== 0) throw new Error(`fingerprint probe failed: ${result.stderr}`);
			return result.stdout;
		};

		const deferred = fingerprint("");
		const evaluated = fingerprint('(await import("arktype")).type("string");');

		expect(deferred).toMatch(/^[0-9a-f]{64}$/);
		expect(evaluated).toBe(deferred);
	});
});
