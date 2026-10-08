/**
 * WHY THIS SUITE EXISTS.
 *
 * THE COST IT REMOVES. The binary build compiles every `.md` prompt template ahead of time, and a
 * session revives those instead of compiling them. The default system prompt was the exception: it
 * joined some eighty statement templates into one 13 KB document and rendered that, a text no
 * build had seen, so every session start parsed and compiled it at run time and evaluated the
 * Handlebars compiler to do it (the parser, its tables, the syntax-tree helpers and the JavaScript
 * code generator). `prompt.renderSequence` now renders the templates one by one, and
 * `@veyyon/utils/prompt-handlebars` loads the compiler only for a template no build compiled.
 *
 * THE CLASS. Any render a session start reaches that compiles at run time: a template assembled in
 * code, a template analyzed from text no build registered, a prompt renderer that loads the full
 * `handlebars` entry, or a sequence that falls back to its joined text. Each one evaluates the
 * compiler, and each one is caught whichever stage reaches it: creating a session, building every
 * built-in and hidden tool with every tool-enabling setting on, rendering the default statement
 * sequence at every point of the statement matrix, and building a custom-prompt system prompt. It
 * also closes a sequence rendered one by one that renders anything but what the joined text
 * renders: each stage's text is compared with a run from source, where every template compiles.
 *
 * HOW. The suite builds the module the binary build emits for every `.md` under a workspace
 * member's `src`, with the build's own `precompiledPromptModule`, and runs
 * `fixtures/precompiled-session-compiler.ts` twice: under a preload that loads each `.md` import as
 * that module, which is the binary's loader, and from source. The fixture reads the evaluated
 * compiler modules from `require.cache`, which a binary does not expose. The source arm is the
 * reference, and its compiler modules are the negative control that proves the probe sees a compile.
 *
 * WHAT IT DOES NOT CATCH. A render reached only after the first turn (a compaction prompt, a
 * subagent's prompt), and a render reached only under a setting the sweep leaves at its default.
 * Operator statement and section overrides are text no build compiled, and compile at render by
 * design. Boundary semantics of `renderSequence` for sequences no production caller assembles are
 * `packages/utils/test/a-template-sequence-renders-what-its-joined-text-renders.test.ts`.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { TempDir } from "@veyyon/utils";
import { typeScriptMembers } from "../../../scripts/workspace-layout";
import { precompiledPromptModule } from "../scripts/precompiled-prompts";
import { PROMPT_STATEMENTS } from "../src/system-prompt-builder/statement-registry";
import type { PrecompiledSessionReport } from "./fixtures/precompiled-session-compiler";
import { hermeticSpawnEnv } from "./helpers/hermetic-spawn-env";

const run = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const FIXTURE = path.join(import.meta.dirname, "fixtures", "precompiled-session-compiler.ts");
const PRELOAD = path.join(import.meta.dirname, "fixtures", "precompiled-prompt-modules-preload.ts");

/** The module the binary build emits for every `.md` under a workspace member's `src`, by real path. */
function promptModules(): Record<string, string> {
	const modules: Record<string, string> = {};
	for (const member of typeScriptMembers()) {
		const src = path.join(REPO_ROOT, member, "src");
		if (!fs.existsSync(src)) continue;
		for (const file of fs.readdirSync(src, { recursive: true, encoding: "utf8" })) {
			if (!file.endsWith(".md")) continue;
			const absolute = fs.realpathSync(path.join(src, file));
			modules[absolute] = precompiledPromptModule(fs.readFileSync(absolute, "utf8"));
		}
	}
	return modules;
}

/** Runs the fixture in a fresh process under `scratch`; `modules` loads `.md` imports as the binary does. */
async function runFixture(scratch: string, modules: string | undefined): Promise<PrecompiledSessionReport> {
	fs.mkdirSync(scratch, { recursive: true });
	const { env, cleanup } = hermeticSpawnEnv();
	try {
		const args = modules ? ["--preload", PRELOAD, FIXTURE, scratch] : [FIXTURE, scratch];
		const { stdout, stderr } = await run(process.execPath, args, {
			env: modules ? { ...env, PRECOMPILED_PROMPT_MODULES: modules } : env,
			maxBuffer: 64 * 1024 * 1024,
			timeout: 60_000,
			killSignal: "SIGKILL",
		});
		if (stderr !== "") throw new Error(`fixture wrote to stderr:\n${stderr}`);
		return JSON.parse(stdout) as PrecompiledSessionReport;
	} finally {
		cleanup();
	}
}

let tempDir: TempDir;
let precompiled: PrecompiledSessionReport;
let source: PrecompiledSessionReport;

beforeAll(async () => {
	tempDir = TempDir.createSync("@precompiled-session-");
	const modules = path.join(tempDir.path(), "modules.json");
	fs.writeFileSync(modules, JSON.stringify(promptModules()));
	// Both arms end in the same directory name, which the prompt prints as the active profile.
	[precompiled, source] = await Promise.all([
		runFixture(path.join(tempDir.path(), "precompiled", "arm"), modules),
		runFixture(path.join(tempDir.path(), "source", "arm"), undefined),
	]);
}, 180_000);

describe("a session whose prompt templates the build compiled", () => {
	test("holds a build-time compilation of every statement template, which a run from source does not", () => {
		const mustacheStatements = PROMPT_STATEMENTS.filter(statement => statement.text.includes("{{")).map(
			statement => statement.id,
		);
		expect(mustacheStatements.length).toBeGreaterThan(0);
		expect(precompiled.unregisteredStatements).toEqual([]);
		expect(source.unregisteredStatements).toEqual(mustacheStatements);
	});

	test("evaluates no Handlebars compiler module at any stage", () => {
		expect(precompiled.compilerAfter).toEqual({ session: [], tools: [], matrix: [], customPrompt: [] });
	});

	test("evaluates the compiler when run from source, which is what the probe would see", () => {
		expect(source.compilerAfter.session).toContain("compiler.js");
		expect(source.compilerAfter.session).toContain("parser.js");
	});

	test("sends the system prompt a run from source sends", () => {
		expect(precompiled.sessionPrompt.join("").length).toBeGreaterThan(10_000);
		expect(precompiled.sessionPrompt).toEqual(source.sessionPrompt);
	});

	test("renders the default statement sequence at every matrix point as its joined text renders", () => {
		expect(precompiled.matrixPrompts).toEqual(source.matrixPrompts);
	});

	test("describes every first-party tool as a run from source does", () => {
		expect(Object.keys(precompiled.toolDescriptions).length).toBeGreaterThan(0);
		expect(precompiled.toolDescriptions).toEqual(source.toolDescriptions);
	});

	test("builds a custom-prompt system prompt as a run from source does", () => {
		expect(precompiled.customPrompt.join("")).toContain("A CUSTOM SYSTEM PROMPT BODY");
		expect(precompiled.customPrompt).toEqual(source.customPrompt);
	});
});
