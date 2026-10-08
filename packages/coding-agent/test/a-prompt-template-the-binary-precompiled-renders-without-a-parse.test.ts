/**
 * WHY THIS SUITE EXISTS.
 *
 * THE COST IT REMOVES. A session renders about a dozen prompt templates before its first request: tool
 * descriptions, the project prompt, the session state. The first render of each parsed the template
 * twice, once to analyze the variables it reads and once to compile it, then generated and evaluated
 * its render function. That was 25 ms of every session start, spent on text fixed at build time. The
 * binary build now loads every `.md` through `scripts/precompiled-prompts.ts`, which registers each
 * template's precompiled specification and analysis, and `prompt.ts` revives those instead.
 *
 * THE CLASS. Either half going wrong for any template: a template the binary still parses on render
 * (the plugin skipped it, the registry key missed, the analysis was not adopted), or a precompiled
 * template that renders or analyzes differently from a runtime compile (compile options drifted, the
 * closing-brace pass was skipped, the analysis assumed the wrong helper set, or a helper registered
 * after load left a precompiled analysis stale).
 *
 * HOW. The variant space is every `.md` under a workspace member's `src` that holds a mustache,
 * derived at run time, so a new template joins without an edit here. One generated entry imports all
 * of them and hands the imported texts to `fixtures/precompiled-prompt-probe.ts`. The entry is compiled
 * to a bytecode binary with the build's plugin, as the release build compiles the product, and is also
 * run from source, where every template compiles at render. The source arm is the reference, and its
 * parse count is the negative control that proves the counter sees a runtime compile.
 *
 * WHAT IT DOES NOT CATCH. A sequence of templates a caller renders together (the default system
 * prompt) is `a-session-of-precompiled-prompts-evaluates-no-handlebars-compiler.test.ts`. Renders are
 * compared under four synthetic contexts, so a divergence reachable only through a block body those
 * contexts leave unrendered would pass.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { prompt, TempDir } from "@veyyon/utils";
import { typeScriptMembers } from "../../../scripts/workspace-layout";
import { createPrecompiledPromptPlugin, precompiledPromptModule } from "../scripts/precompiled-prompts";
import type { ProbeInput, ProbeReport } from "./fixtures/precompiled-prompt-probe";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const PROBE = path.resolve(import.meta.dirname, "fixtures", "precompiled-prompt-probe.ts");

/** Every workspace `.md` template, keyed by its path from the repository root. */
function mustacheTemplates(): Map<string, string> {
	const found = new Map<string, string>();
	for (const member of typeScriptMembers()) {
		const src = path.join(REPO_ROOT, member, "src");
		if (!fs.existsSync(src)) continue;
		for (const file of fs.readdirSync(src, { recursive: true, encoding: "utf8" })) {
			if (!file.endsWith(".md")) continue;
			const absolute = path.join(src, file);
			const text = fs.readFileSync(absolute, "utf8");
			if (text.includes("{{")) found.set(path.relative(REPO_ROOT, absolute), text);
		}
	}
	return new Map([...found].sort(([a], [b]) => a.localeCompare(b)));
}

/** Every context root a template reads. */
function contextNames(template: string): string[] {
	const { required, optional } = prompt.analyzePromptTemplate(template);
	return [...required, ...optional].map(variable => variable.name);
}

/** Each name set to a string holding every character Handlebars' escaping rewrites. */
function stringContext(names: readonly string[]): Record<string, unknown> {
	return Object.fromEntries(names.map(name => [name, `<${name} & "double" 'single' \`tick\` =>`]));
}

/**
 * A template that prints a bare `{{name}}` it requires unconditionally, the name, and a context that
 * supplies everything else. Registering a helper of that name turns the variable into a helper call,
 * which is the case where an analysis precompiled before the registration would be stale.
 */
function lateHelperCase(templates: ReadonlyMap<string, string>): ProbeInput["lateHelper"] {
	for (const [key, template] of templates) {
		const { required } = prompt.analyzePromptTemplate(template);
		for (const variable of required) {
			const bare = variable.paths.length === 1 && variable.paths[0] === variable.name;
			const unconditional = variable.requiredWhen.some(guards => guards.length === 0);
			if (!bare || !unconditional || !template.includes(`{{${variable.name}}}`)) continue;
			const context = stringContext(contextNames(template).filter(name => name !== variable.name));
			return { key, name: variable.name, context };
		}
	}
	throw new Error("No workspace template prints an unconditional bare variable; the late-helper case has no subject.");
}

/**
 * Dialect features no workspace template exercises today, so the sweep covers them before one does:
 * a run of closing braces, which compiles only through the closing-brace pass, and a helper called
 * with no arguments, which the analysis reads as a variable unless it assumed the helper set.
 */
const SYNTHETIC: ReadonlyMap<string, string> = new Map([
	["synthetic/closing-brace-run.md", "A literal brace closes after a mustache: {literal:{{name}}}.\n"],
	["synthetic/zero-argument-helper.md", "A helper with no arguments prints {{not}}; a variable prints {{name}}.\n"],
]);

const workspace = mustacheTemplates();
const templates: ReadonlyMap<string, string> = new Map([...workspace, ...SYNTHETIC]);
let tempDir: TempDir;
let compiled: ProbeReport;
let source: ProbeReport;
let lateHelper: ProbeInput["lateHelper"];

/** Options for a probe run. Stderr is captured, not shown: the string context makes Handlebars warn about every `name.property` it reads off a string, and a failed run reports it through the thrown error. */
function probeOptions(): ExecFileSyncOptionsWithStringEncoding {
	return { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, cwd: tempDir.path(), stdio: ["ignore", "pipe", "pipe"] };
}

beforeAll(async () => {
	tempDir = TempDir.createSync("@precompiled-prompts-");
	const fileOf = (key: string): string =>
		SYNTHETIC.has(key) ? path.join(tempDir.path(), key) : path.join(REPO_ROOT, key);
	for (const [key, text] of SYNTHETIC) {
		fs.mkdirSync(path.dirname(fileOf(key)), { recursive: true });
		fs.writeFileSync(fileOf(key), text);
	}
	lateHelper = lateHelperCase(templates);
	const input: ProbeInput = {
		contexts: Object.fromEntries(
			[...templates].map(([key, template]) => {
				const names = contextNames(template);
				return [key, [{}, stringContext(names), Object.fromEntries(names.map(name => [name, true]))]];
			}),
		),
		lateHelper,
	};
	const inputPath = path.join(tempDir.path(), "input.json");
	fs.writeFileSync(inputPath, JSON.stringify(input));

	const keys = [...templates.keys()];
	const entry = path.join(tempDir.path(), "entry.ts");
	fs.writeFileSync(
		entry,
		[
			`import { runProbe } from ${JSON.stringify(PROBE)};`,
			...keys.map((key, index) => `import t${index} from ${JSON.stringify(fileOf(key))} with { type: "text" };`),
			`runProbe({ ${keys.map((key, index) => `${JSON.stringify(key)}: t${index}`).join(", ")} }, process.argv[2]!);`,
			"",
		].join("\n"),
	);

	const binary = path.join(tempDir.path(), "precompiled-prompt-probe");
	const output = await Bun.build({
		entrypoints: [entry],
		format: "esm",
		bytecode: true,
		plugins: [createPrecompiledPromptPlugin()],
		compile: { outfile: binary, autoloadBunfig: false, autoloadDotenv: false },
		throw: false,
	});
	if (!output.success) throw new Error(output.logs.map(log => log.message).join("\n"));

	compiled = JSON.parse(
		execFileSync(path.join(tempDir.path(), "precompiled-prompt-probe"), [inputPath], probeOptions()),
	) as ProbeReport;
	source = JSON.parse(execFileSync(process.execPath, [entry, inputPath], probeOptions())) as ProbeReport;
}, 180_000);

afterAll(() => {
	tempDir?.removeSync();
});

describe("a prompt template the binary build precompiled", () => {
	test("the sweep covers every workspace template and every synthetic one", () => {
		expect(workspace.size).toBeGreaterThan(0);
		expect(Object.keys(compiled.templates)).toEqual([...templates.keys()]);
		expect(Object.keys(source.templates)).toEqual([...templates.keys()]);
	});

	test("is registered in the binary under the text its import yields, and nowhere in a run from source", () => {
		const unregistered = Object.entries(compiled.templates).filter(([, report]) => !report.registered);
		expect(unregistered.map(([key]) => key)).toEqual([]);
		const registered = Object.entries(source.templates).filter(([, report]) => report.registered);
		expect(registered.map(([key]) => key)).toEqual([]);
	});

	test("is analyzed, rendered and rendered again in the binary without one parse", () => {
		const parsed = Object.entries(compiled.templates).filter(([, report]) => report.parses > 0);
		expect(parsed.map(([key]) => key)).toEqual([]);
	});

	test("parses on its first render when run from source, which is what the binary no longer does", () => {
		const unparsed = Object.entries(source.templates).filter(([, report]) => report.parses === 0);
		expect(unparsed.map(([key]) => key)).toEqual([]);
	});

	test("holds the analysis a runtime compile derives", () => {
		for (const key of templates.keys()) {
			expect({ key, analysis: compiled.templates[key]!.analysis }).toEqual({
				key,
				analysis: source.templates[key]!.analysis,
			});
		}
	});

	test("renders what a runtime compile renders, escaping nothing, under every context", () => {
		for (const key of templates.keys()) {
			expect({ key, outcomes: compiled.templates[key]!.outcomes }).toEqual({
				key,
				outcomes: source.templates[key]!.outcomes,
			});
		}
		// The string context reached the output unescaped somewhere, so escaping is under test.
		const printed = Object.values(source.templates).some(report =>
			report.outcomes.some(outcome => outcome.text?.includes(`& "double" 'single'`)),
		);
		expect(printed).toBe(true);
	});

	test("drops its precompiled analysis when a later helper takes the name of a variable it prints", () => {
		// The analysis the build made treats the name as a required variable, so reusing it would
		// demand the caller pass a value the helper now supplies.
		const template = templates.get(lateHelper.key)!;
		expect(() => prompt.render(template, lateHelper.context)).toThrow(prompt.MissingTemplateVariableError);
		expect(source.lateHelper.text).toContain("LATE-HELPER");
		expect(compiled.lateHelper).toEqual(source.lateHelper);
	});

	test("fails the build when a template does not compile", () => {
		expect(() => precompiledPromptModule("{{#if open}}never closed")).toThrow();
	});
});
