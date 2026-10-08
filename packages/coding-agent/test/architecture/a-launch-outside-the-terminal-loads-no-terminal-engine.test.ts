/**
 * WHY THIS SUITE EXISTS.
 *
 * THE DEFECT IT CLOSES. A print, RPC or ACP launch draws no terminal frame, and it evaluated the terminal
 * renderer anyway, through three edges:
 *
 * - `main.ts` imported `selectSession` from `cli/session-picker.ts` at the top of the file. The picker
 *   imports the engine root and the session selector, so 115 modules (1695 KiB of source: the renderer,
 *   the editor, the markdown, mermaid and LaTeX renderers, the status line) sat on the static launch graph
 *   for a picker only `--resume` without an id opens.
 * - `commands/launch.ts` imported `cli/launch-card.ts` to ask whether to paint the card, and the card
 *   module imports the first-frame paint and with it `core/tui.ts`.
 * - The `ask` tool, which every session builds, took a width query from `chrome/modal-shell.ts` and a pad
 *   constant from `dialogs/hook-editor.ts`, two interactive components that import the engine root. Both
 *   numbers are in `chrome/modal-geometry.ts` now, which imports no renderer.
 *
 * THE CLASS. A module under `hosts/terminal/engine/src/`, or the vendored mermaid renderer, reaches a
 * launch that draws no terminal frame, through the launch graph or through a tool module the session
 * builds. Both directories are read at run time. The headless entries are pinned by exact equality, and the
 * tool modules are swept from the dynamic imports of the tool dispatch table and every per-domain manifest,
 * so a new tool is covered without an edit and turns this red when it reaches the engine. The interactive
 * mode, the picker and the card reaching the engine are asserted too, so the cut cannot pass by the engine
 * going missing from the surfaces that draw.
 *
 * The static walk follows `await import(...)` only out of the tool tables, so an edge through any other
 * dynamic import escapes it. The suite also launches the CLI from source in RPC mode under a hermetic home
 * and reads every module it has evaluated once it reports ready (`require.cache`, through
 * `fixtures/loaded-module-census-preload.ts`). The engine modules that launch evaluates are held to the
 * theme's probe, and its terminal-mode modules are pinned by exact equality.
 *
 * WHAT IT DOES NOT CATCH. A print or ACP launch is walked statically only; the runtime census covers the
 * RPC launch, which builds the same session and the same tools. A module first evaluated after the launch
 * reports ready is outside the census.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { moduleReach } from "@veyyon/utils/module-reach";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";
import { CACHE, lazyToolModules, PACKAGES, RESOLUTION, SRC } from "../helpers/module-reach-gate";

const ENGINE = path.join(PACKAGES, "..", "hosts", "terminal", "engine", "src");
const MERMAID = path.join(PACKAGES, "utils", "src", "vendor", "mermaid-ascii");
const TOOLS = path.join(SRC, "tools");

/** Every module file under `dir`, relative to it, sorted. */
function modulesUnder(dir: string): string[] {
	return fs
		.readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter(name => /\.(ts|tsx|js|json)$/.test(name))
		.sort();
}

function reachedUnder(entry: string, dir: string): string[] {
	const reached = moduleReach(entry, RESOLUTION, CACHE);
	return modulesUnder(dir).filter(name => reached.has(path.join(dir, name)));
}

/**
 * The capability probe the theme reads: which terminal is attached, whether it renders images and
 * hyperlinks, and the desktop notification and focus reporting it supports. It draws nothing.
 */
const THEME_PROBE = ["desktop-notify.ts", "terminal-capabilities.ts", "window-focus.ts"];

/** Engine modules `entry` reaches beyond the theme's capability probe. */
function engineBeyondProbe(entry: string): string[] {
	return reachedUnder(entry, ENGINE).filter(name => !THEME_PROBE.includes(name));
}

/** Launch paths that build a session and draw no terminal frame. */
const HEADLESS_ENTRIES = [
	"main.ts",
	"sdk.ts",
	"commands/launch.ts",
	"cli/launch-card-eligibility.ts",
	"modes/print-mode.ts",
	"modes/rpc/rpc-mode.ts",
	"modes/acp/acp-mode.ts",
];

describe("a launch outside the terminal loads no terminal engine", () => {
	it("reads engine and renderer directories worth judging", () => {
		expect(modulesUnder(ENGINE)).toEqual(expect.arrayContaining(["core/tui.ts", "components/markdown.ts"]));
		expect(modulesUnder(ENGINE).length).toBeGreaterThan(30);
		expect(modulesUnder(MERMAID)).toContain("index.ts");
	});

	for (const entry of HEADLESS_ENTRIES) {
		it(`${entry} reaches no engine module beyond the theme's capability probe`, () => {
			expect(engineBeyondProbe(path.join(SRC, entry))).toEqual([]);
		});

		it(`${entry} reaches no mermaid renderer`, () => {
			expect(reachedUnder(path.join(SRC, entry), MERMAID)).toEqual([]);
		});
	}

	it("sweeps every tool module the dispatch tables load, and resolves each one", () => {
		const { modules, unresolved } = lazyToolModules();
		expect(unresolved).toEqual([]);
		expect(modules.length).toBeGreaterThan(30);
		expect(modules).toContain(path.join(TOOLS, "agent", "ask.ts"));
	});

	it("builds no tool that reaches the engine beyond the theme's capability probe", () => {
		const reaching = lazyToolModules()
			.modules.map(file => [path.relative(SRC, file), engineBeyondProbe(file)] as const)
			.filter(([, engine]) => engine.length > 0);
		expect(reaching).toEqual([]);
	});

	it("builds no tool that reaches the mermaid renderer", () => {
		const reaching = lazyToolModules()
			.modules.filter(file => reachedUnder(file, MERMAID).length > 0)
			.map(file => path.relative(SRC, file));
		expect(reaching).toEqual([]);
	});

	for (const entry of ["modes/terminal/interactive-mode.ts", "cli/session-picker.ts", "cli/launch-card.ts"]) {
		it(`${entry} still reaches the renderer`, () => {
			expect(reachedUnder(path.join(SRC, entry), ENGINE)).toEqual(
				expect.arrayContaining(["core/tui.ts", "terminal.ts"]),
			);
		});
	}

	for (const entry of ["modes/terminal/interactive-mode.ts", "cli/session-picker.ts"]) {
		it(`${entry} still reaches the markdown component and the mermaid renderer`, () => {
			expect(reachedUnder(path.join(SRC, entry), ENGINE)).toContain("components/markdown.ts");
			expect(reachedUnder(path.join(SRC, entry), MERMAID)).toContain("index.ts");
		});
	}
});

/** Terminal-mode modules an RPC launch evaluates, relative to `src/modes/terminal/`, and why each draws nothing. */
const RPC_TERMINAL_MODE_MODULES = [
	// The ask tool's card width and title pad: arithmetic, no renderer.
	"components/chrome/modal-geometry.ts",
	// The welcome tip `main.ts` forces after an update: one string and one template.
	"components/dialogs/launch-tip.ts",
	// The styling the interactive bash tool applies to rows a PTY program drew; imports no component.
	"draw/terminal-row.ts",
];

describe("an RPC launch evaluates no terminal engine", () => {
	let tempDir: TempDir;
	let child: ChildProcess | undefined;
	let loaded: string[] = [];

	beforeAll(async () => {
		tempDir = TempDir.createSync("@rpc-module-census-");
		const census = path.join(tempDir.path(), "census.txt");
		// RPC resolves a model before it reports ready; a key of the right shape that reaches nothing is enough.
		const { env, cleanup } = hermeticSpawnEnv({
			LOADED_MODULE_CENSUS: census,
			ANTHROPIC_API_KEY: "sk-ant-api03-not-a-real-key",
			VEYYON_NO_TITLE: "1",
		});
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
			loaded = fs.readFileSync(census, "utf8").split("\n").filter(Boolean);
		} finally {
			cleanup();
		}
	}, 120_000);

	afterAll(() => {
		child?.kill("SIGKILL");
		tempDir?.removeSync();
	});

	it("read a census worth judging: the session, its tools and the theme's probe", () => {
		expect(loaded.length).toBeGreaterThan(500);
		expect(loaded).toContain(path.join(SRC, "session", "agent-session.ts"));
		expect(loaded).toContain(path.join(TOOLS, "agent", "ask.ts"));
		expect(loaded).toContain(path.join(ENGINE, "terminal-capabilities.ts"));
	});

	it("evaluates no engine module beyond the theme's capability probe", () => {
		const engine = loaded
			.filter(file => file.startsWith(`${ENGINE}${path.sep}`))
			.map(file => path.relative(ENGINE, file))
			.filter(name => !THEME_PROBE.includes(name));
		expect(engine).toEqual([]);
	});

	it("evaluates no mermaid renderer", () => {
		expect(loaded.filter(file => file.startsWith(`${MERMAID}${path.sep}`))).toEqual([]);
	});

	it("evaluates only the terminal-mode modules that draw nothing", () => {
		const terminalMode = path.join(SRC, "modes", "terminal");
		const evaluated = loaded
			.filter(file => file.startsWith(`${terminalMode}${path.sep}`))
			.map(file => path.relative(terminalMode, file))
			.sort();
		expect(evaluated).toEqual(RPC_TERMINAL_MODE_MODULES);
	});
});
