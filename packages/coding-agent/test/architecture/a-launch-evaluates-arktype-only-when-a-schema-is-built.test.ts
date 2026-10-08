/**
 * WHY THIS SUITE EXISTS.
 *
 * THE DEFECT IT CLOSES. Every schema in the product is built inside a `lazy()` thunk, and a session holds
 * its at-rest reading until it leaves rest, so the launch builds no schema. It
 * evaluated arktype anyway: 76 shipped modules imported `type` (or `scope`, `Type`) from the package, and
 * a static import evaluates the package with the module graph. That is 115 modules, about 30ms of a
 * compiled binary's launch and 6 MiB of heap, ahead of the first frame, for a library no schema had
 * asked for yet. Shipped source now imports those values from `@veyyon/ai/utils/schema/arktype`, whose
 * stand-ins evaluate the package on the first call or property read. The CLI entry's `configureArktype`
 * call then still evaluated the configuration entry, 32 modules of `arktype` and `@ark/*`; the facade
 * now holds each configuration and applies it, in call order, before the first load evaluates the package.
 *
 * THE CLASS. Any module an interactive launch evaluates that evaluates arktype: a value import of the
 * package outside the deferred module, a schema built while a module evaluates rather than inside a
 * thunk, or the launch's configuration call. The suite evaluates, in a separate process, the launch
 * entry, the interactive mode, the launch card, the session picker and every tool module the dispatch
 * tables load (swept at run time, so a new tool is covered without an edit), configures ArkType as the
 * CLI entry does, and reads the module cache. A new tool or launch module that evaluates arktype turns
 * it red. The positive control builds one schema through the deferred module in the same process and
 * observes the package arrive with every held configuration in its `ark` scope, so an empty census is a
 * measurement and not a probe that cannot see the package.
 *
 * The value-import half is also swept statically across every workspace member, launch path or not, in
 * `scripts/arktype-values-load-through-the-deferred-module.test.ts`.
 *
 * WHAT IT DOES NOT CATCH. Modules loaded by a dynamic import outside the tool tables (extensions, MCP,
 * commands a keystroke opens), and a schema built by code that runs at launch rather than while a module
 * evaluates: the held at-rest reading is defended by
 * `session/a-held-at-rest-reading-builds-no-tool-schema-until-the-session-leaves-rest.test.ts`, and an
 * RPC launch's packages by `a-launch-evaluates-only-the-packages-it-uses.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";
import { lazyToolModules, PACKAGES, SRC } from "../helpers/module-reach-gate";

const DEFERRED_ARKTYPE = path.join(PACKAGES, "ai", "src", "utils", "schema", "arktype.ts");

/** Modules an interactive launch evaluates before it draws, beyond the tools its session builds. */
const LAUNCH_MODULES = ["main.ts", "modes/terminal/interactive-mode.ts", "cli/launch-card.ts", "cli/session-picker.ts"];

/** What the census process prints: the arktype modules it held before and after the first schema. */
interface Census {
	readonly evaluated: number;
	readonly atRest: string[];
	/** ArkType modules held once the launch's configuration call returned, before any schema. */
	readonly afterConfigure: string[];
	readonly afterFirstSchema: string[];
	readonly accepts: boolean;
	readonly rejects: boolean;
	/** The configuration the package read when the first schema evaluated it: its `ark` scope's snapshot. */
	readonly jitlessAtFirstSchema: unknown;
	readonly onUndeclaredKeyAtFirstSchema: unknown;
	/** A configuration applied after the package evaluated, as the registry holds it. */
	readonly exactOptionalAfterLoad: unknown;
}

/**
 * An entry that statically imports every module under test, then reports. ES module imports evaluate
 * before the importing body runs, so the first reading is taken with every module evaluated. It then
 * configures ArkType as the CLI entry does, in two calls, before building the first schema.
 */
function censusEntry(modules: readonly string[]): string {
	const imports = modules.map(file => `import ${JSON.stringify(file)};`).join("\n");
	return `${imports}
import { configureArktype, loadArktype, type } from ${JSON.stringify(DEFERRED_ARKTYPE)};
const ARKTYPE = /[\\\\/]node_modules[\\\\/](?:arktype|@ark[\\\\/][^\\\\/]+)[\\\\/]/;
const arktypeModules = () => Object.keys(require.cache).filter(file => ARKTYPE.test(file));
const atRest = arktypeModules();
configureArktype({ jitless: true });
configureArktype({ onUndeclaredKey: "delete" });
const afterConfigure = arktypeModules();
const schema = type({ name: "string" });
const afterFirstSchema = arktypeModules();
// The \`ark\` scope copies the configuration when the package evaluates, so it states what evaluation read.
const { config } = loadArktype().ark;
const jitlessAtFirstSchema = config.jitless;
const onUndeclaredKeyAtFirstSchema = config.onUndeclaredKey;
configureArktype({ exactOptionalPropertyTypes: false });
process.stdout.write(JSON.stringify({
	evaluated: Object.keys(require.cache).length,
	atRest,
	afterConfigure,
	afterFirstSchema,
	accepts: !(schema({ name: "x" }) instanceof type.errors),
	rejects: schema({ name: 1 }) instanceof type.errors,
	jitlessAtFirstSchema,
	onUndeclaredKeyAtFirstSchema,
	exactOptionalAfterLoad: globalThis.$ark.config.exactOptionalPropertyTypes,
}));
process.exit(0);
`;
}

describe("a launch evaluates arktype only when a schema is built", () => {
	const tools = lazyToolModules();
	const modules = [...LAUNCH_MODULES.map(file => path.join(SRC, file)), ...tools.modules];
	let tempDir: TempDir;
	let census: Census;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@arktype-census-");
		const entry = path.join(tempDir.path(), "census.ts");
		fs.writeFileSync(entry, censusEntry(modules));
		const { env, cleanup } = hermeticSpawnEnv();
		try {
			const child = spawn(process.execPath, [entry], {
				cwd: tempDir.path(),
				env,
				stdio: ["ignore", "pipe", "pipe"],
			});
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
			census = JSON.parse(stdout) as Census;
		} finally {
			cleanup();
		}
	}, 120_000);

	afterAll(() => {
		tempDir?.removeSync();
	});

	it("sweeps the launch modules and every tool module the dispatch tables load", () => {
		expect(tools.unresolved).toEqual([]);
		expect(tools.modules.length).toBeGreaterThan(30);
		expect(tools.modules).toContain(path.join(SRC, "tools", "agent", "todo.ts"));
		expect(census.evaluated).toBeGreaterThan(1500);
	});

	it("evaluates no arktype module while every launch and tool module is loaded", () => {
		expect(census.atRest).toEqual([]);
	});

	it("evaluates arktype for the first schema, and the schema validates", () => {
		expect(census.afterFirstSchema.length).toBeGreaterThan(50);
		expect(census.accepts).toBe(true);
		expect(census.rejects).toBe(true);
	});

	it("holds the launch's configuration without evaluating arktype, and the first schema reads every call of it", () => {
		expect(census.afterConfigure).toEqual([]);
		expect(census.jitlessAtFirstSchema).toBe(true);
		expect(census.onUndeclaredKeyAtFirstSchema).toBe("delete");
	});

	it("applies a configuration given after arktype evaluated at once", () => {
		expect(census.exactOptionalAfterLoad).toBe(false);
	});
});
