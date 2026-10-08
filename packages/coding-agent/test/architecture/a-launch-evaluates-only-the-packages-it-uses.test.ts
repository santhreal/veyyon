/**
 * WHY THIS SUITE EXISTS.
 *
 * THE DEFECT IT CLOSES. A launch evaluated four third-party packages it had no use for yet, three through a
 * static import in a module the launch graph holds:
 *
 * - `yaml` (72 modules): `yaml-sync.ts`, which writes a settings file in place, and the secrets loader, whose
 *   keyword module parsed the bundled keyword list while it evaluated, with secret obfuscation off.
 * - `@opentelemetry/api` (44 modules): the agent loop's telemetry, which reaches a tracer only in a session given
 *   a telemetry config.
 * - `diff` (19 modules): the edit tool's diff helpers, the patcher's stale-tag recovery and the transcript's
 *   word diff, none of which runs before something is edited.
 *
 * and `arktype` with `@ark/schema`, `@ark/util` and `arkregex` (115 modules), because a print or RPC launch
 * took the session's at-rest reading while it created the session, and that reading builds every tool schema.
 *
 * An RPC launch evaluated 1991 modules before it reported ready, and 1876 without the first three. Each of
 * them now loads through a `require` behind its first use: `loadYaml` in `@veyyon/utils/yaml-sync`,
 * `loadOpenTelemetry` in the agent's telemetry module, and a `lazy()` holder beside each `diff` reader. Every
 * top-level session now holds its at-rest reading until its first turn, as the interactive host already did.
 *
 * A launch with secret obfuscation on still evaluated `yaml` (14 ms and 12.5 MiB from source), because the
 * secret runtime it builds parsed the bundled keyword list through `loadYaml`. Bun's YAML parser reads the
 * bundled list now, and `yaml` loads only for a keyword file a user wrote.
 *
 * THE CLASS. A third-party package that a launch evaluates without using. Neither census below names the
 * packages it looks for: each reads every package out of the module cache and pins the set by exact equality,
 * so a new package on a launch, or a deferred one that returns to it, turns this red until the set records a
 * decision. One census launches the CLI from source in RPC mode under a hermetic home with secret obfuscation
 * on, so session creation builds the secret runtime as well, and reads the cache when it reports ready, which
 * covers what session creation evaluates. The other evaluates the interactive launch modules and every tool
 * module the dispatch tables load (swept at run time), which covers the modules a terminal launch evaluates
 * and RPC does not. That process then takes each deferred package's first use through the shipped function
 * (the keyword list's with a keyword file a user wrote) and observes that package, and only that package,
 * arrive, so an empty census is a measurement and not a probe that cannot see the package.
 *
 * WHAT IT DOES NOT CATCH. A package evaluated by a dynamic import outside the tool tables that the RPC launch
 * does not take (extensions, MCP, a command a keystroke opens), and any module first evaluated after the
 * launch reports ready. A first-party module is outside it: the launch graph ratchets cover those.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { ENV_KEYWORDS_FILENAME } from "../../src/secrets/env-keywords";
import { VAULT_KEY_FILENAME } from "../../src/secrets/vault-crypto";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";
import { lazyToolModules, PACKAGES, SRC } from "../helpers/module-reach-gate";

/** Third-party packages an RPC launch evaluates before it reports ready, and why each one is needed then. */
const EVALUATED_BY_AN_RPC_LAUNCH = [
	// Argument parsing and its error output.
	"chalk",
	// The system prompt and the tool descriptions are templates; `source-map` is its dependency.
	"handlebars",
	// Snapshot, read-summary and highlight caches the session builds with its tools.
	"lru-cache",
	// Argot's dictionary parser, which the launch graph evaluates with the codec.
	"smol-toml",
	"source-map",
];

/** Third-party packages the interactive launch modules and every tool module evaluate. */
const EVALUATED_BY_THE_LAUNCH_MODULES = [
	"chalk",
	"handlebars",
	"lru-cache",
	// The terminal transcript's markdown lexer, which the interactive mode's renderer evaluates.
	"marked",
	"smol-toml",
	"source-map",
];

/** Modules an interactive launch evaluates before it draws, beyond the tools its session builds. */
const LAUNCH_MODULES = ["main.ts", "modes/terminal/interactive-mode.ts", "cli/launch-card.ts", "cli/session-picker.ts"];

/**
 * One shipped function per deferred package whose first call evaluates it. The other readers of each package
 * are held to the at-rest pin, and their output is defended by their own suites.
 */
const FIRST_USES = {
	keywords: path.join(SRC, "secrets", "env-keywords.ts"),
	telemetry: path.join(PACKAGES, "agent", "src", "telemetry.ts"),
	editDiff: path.join(SRC, "edit", "diff.ts"),
};

/** The package a module path belongs to, from its last `node_modules` segment. */
const PACKAGE_OF = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/](?!.*[\\/]node_modules[\\/])/;

/** The sorted packages `files` belong to. */
function packagesOf(files: Iterable<string>): string[] {
	const names = new Set<string>();
	for (const file of files) {
		const match = PACKAGE_OF.exec(file);
		if (match?.[1]) names.add(match[1].replace(/\\/g, "/"));
	}
	return [...names].sort();
}

/** What the launch-module census prints. */
interface ModuleCensus {
	readonly evaluated: number;
	/** Every module path in the cache once the modules under test have evaluated and nothing has been called. */
	readonly atRest: string[];
	/** Module paths that arrived with each first use, in the order the uses ran. */
	readonly arrived: Record<keyof typeof FIRST_USES, string[]>;
	readonly keywords: string[];
	readonly tracerResolved: boolean;
	readonly statusError: number;
	readonly editDiff: string;
}

/**
 * An entry that statically imports every module under test, then reports. ES module imports evaluate before
 * the importing body runs, so the first reading is taken with every module evaluated and nothing called.
 * `keywordDir` holds a keyword file a user wrote, which is what makes the keyword list load `yaml`.
 */
function censusEntry(modules: readonly string[], keywordDir: string): string {
	const imports = modules.map(file => `import ${JSON.stringify(file)};`).join("\n");
	const use = (name: keyof typeof FIRST_USES): string => JSON.stringify(FIRST_USES[name]);
	const dir = JSON.stringify(keywordDir);
	return `${imports}
import { loadEnvSecretKeywords } from ${use("keywords")};
import { resolveTelemetry, SpanStatusCode } from ${use("telemetry")};
import { generateDiffString } from ${use("editDiff")};
const atRest = Object.keys(require.cache);
const arrived = {};
let before = new Set(atRest);
const step = async (name, fn) => {
	const value = await fn();
	const after = Object.keys(require.cache);
	arrived[name] = after.filter(file => !before.has(file));
	before = new Set(after);
	return value;
};
const keywords = await step("keywords", () => loadEnvSecretKeywords({ cwd: ${dir}, agentDir: ${dir} }));
const tracerResolved = await step("telemetry", () => resolveTelemetry({}, "census")?.tracer !== undefined);
const statusError = SpanStatusCode.ERROR;
const editDiff = await step("editDiff", () => generateDiffString("one\\ntwo\\n", "one\\nthree\\n").diff);
process.stdout.write(JSON.stringify({
	evaluated: Object.keys(require.cache).length,
	atRest,
	arrived,
	keywords,
	tracerResolved,
	statusError,
	editDiff,
}));
process.exit(0);
`;
}

/** Run `args` under a hermetic home in `cwd` and collect its output. */
async function runToExit(args: string[], cwd: string, extraEnv: Record<string, string>): Promise<string> {
	const { env, cleanup } = hermeticSpawnEnv(extraEnv);
	try {
		const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", chunk => {
			stdout += String(chunk);
		});
		child.stderr.on("data", chunk => {
			stderr += String(chunk);
		});
		const exited = Promise.withResolvers<number | null>();
		child.on("exit", code => exited.resolve(code));
		const code = await exited.promise;
		if (code !== 0) throw new Error(`census process exited ${code}:\n${stderr}`);
		return stdout;
	} finally {
		cleanup();
	}
}

describe("a launch evaluates only the third-party packages it uses", () => {
	const tools = lazyToolModules();
	const modules = [...LAUNCH_MODULES.map(file => path.join(SRC, file)), ...tools.modules];
	let tempDir: TempDir;
	let census: ModuleCensus;
	let rpcPackages: string[] = [];
	let rpcEvaluated = 0;
	let secretRuntimeBuilt = false;
	let child: ChildProcess | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@package-census-");
		const entry = path.join(tempDir.path(), "census.ts");
		const keywordDir = path.join(tempDir.path(), "keywords");
		fs.mkdirSync(keywordDir);
		fs.writeFileSync(path.join(keywordDir, ENV_KEYWORDS_FILENAME), "keywords:\n  - CENSUSWORD\n");
		fs.writeFileSync(entry, censusEntry(modules, keywordDir));
		census = JSON.parse(await runToExit([entry], tempDir.path(), {})) as ModuleCensus;

		const rpcCensus = path.join(tempDir.path(), "rpc-census.txt");
		// RPC resolves a model before it reports ready; a key of the right shape that reaches nothing is enough.
		// Secret obfuscation on makes session creation build the secret runtime and read the keyword list.
		const { env, home, cleanup } = hermeticSpawnEnv({
			LOADED_MODULE_CENSUS: rpcCensus,
			ANTHROPIC_API_KEY: "sk-ant-api03-not-a-real-key",
			VEYYON_NO_TITLE: "1",
		});
		const agentDir = path.join(home, ".veyyon", "profiles", "default", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "config.yml"), "secrets:\n  enabled: true\n");
		try {
			const launched = spawn(
				process.execPath,
				[
					"--preload",
					path.join(import.meta.dirname, "..", "fixtures", "loaded-module-census-preload.ts"),
					path.join(SRC, "cli.ts"),
					"--mode",
					"rpc",
					"--no-session",
				],
				{ cwd: tempDir.path(), env, stdio: ["pipe", "pipe", "pipe"] },
			);
			child = launched;
			const ready = Promise.withResolvers<void>();
			let stdout = "";
			let stderr = "";
			launched.stdout.on("data", chunk => {
				stdout += String(chunk);
				if (stdout.includes('"type":"ready"')) ready.resolve();
			});
			launched.stderr.on("data", chunk => {
				stderr += String(chunk);
			});
			const exited = Promise.withResolvers<number | null>();
			launched.on("exit", code => {
				exited.resolve(code);
				ready.reject(new Error(`RPC launch exited ${code} before ready:\n${stderr}`));
			});
			await ready.promise;
			launched.kill("SIGUSR2");
			expect(await exited.promise).toBe(0);
			const loaded = fs.readFileSync(rpcCensus, "utf8").split("\n").filter(Boolean);
			rpcEvaluated = loaded.length;
			rpcPackages = packagesOf(loaded);
			// The secret runtime creates the vault key; a launch with secret obfuscation off creates none.
			secretRuntimeBuilt = fs.existsSync(path.join(home, ".veyyon", VAULT_KEY_FILENAME));
		} finally {
			cleanup();
		}
	}, 180_000);

	afterAll(() => {
		child?.kill("SIGKILL");
		tempDir?.removeSync();
	});

	it("reads censuses worth judging", () => {
		expect(tools.unresolved).toEqual([]);
		expect(tools.modules).toContain(path.join(SRC, "edit", "index.ts"));
		expect(census.evaluated).toBeGreaterThan(1500);
		expect(rpcEvaluated).toBeGreaterThan(1500);
		expect(secretRuntimeBuilt).toBe(true);
	});

	it("an RPC launch evaluates exactly the packages recorded for it", () => {
		expect(rpcPackages).toEqual(EVALUATED_BY_AN_RPC_LAUNCH);
	});

	it("the interactive launch modules and every tool module evaluate exactly the packages recorded for them", () => {
		expect(packagesOf(census.atRest)).toEqual(EVALUATED_BY_THE_LAUNCH_MODULES);
	});

	it("each first use evaluates its own package and nothing else", () => {
		const arrivedPackages = Object.fromEntries(
			Object.entries(census.arrived).map(([use, files]) => [use, packagesOf(files)]),
		);
		expect(arrivedPackages).toEqual({ keywords: ["yaml"], telemetry: ["@opentelemetry/api"], editDiff: ["diff"] });
		const firstParty = Object.values(census.arrived)
			.flat()
			.filter(file => !PACKAGE_OF.test(file));
		expect(firstParty).toEqual([]);
	});

	it("each first use answers from the package it loaded", () => {
		expect(census.keywords).toEqual(expect.arrayContaining(["TOKEN", "CENSUSWORD"]));
		expect(census.tracerResolved).toBe(true);
		expect(census.statusError).toBe(2);
		expect(census.editDiff).toContain("three");
	});
});
