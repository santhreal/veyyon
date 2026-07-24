import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	GALLERY_STATES,
	parseGalleryStates,
	renderGalleryForThemes,
	renderGalleryState,
	resolveFixture,
	themedOutPath,
} from "@veyyon/coding-agent/cli/gallery-cli";
import type { GalleryFixture } from "@veyyon/coding-agent/cli/gallery-fixtures";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getAvailableThemes, initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { toolRenderers } from "@veyyon/coding-agent/tools/renderers";
import { hermeticSpawnEnv } from "./helpers/hermetic-spawn-env";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;

beforeAll(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
	await initTheme(false, undefined, undefined, "dark", "light");
});

afterAll(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

describe("gallery harness", () => {
	it("accepts displayed gallery state labels and legacy tokens", () => {
		expect(parseGalleryStates(["streaming args", "in progress", "done", "failed"])).toEqual([
			"streaming",
			"progress",
			"success",
			"error",
		]);
		expect(parseGalleryStates(["streaming", "progress", "success", "error", "failed"])).toEqual([...GALLERY_STATES]);
	});

	it("rejects unknown gallery state tokens before rendering", () => {
		expect(() => parseGalleryStates(["bogus"])).toThrow(
			/Invalid --state 'bogus'.*streaming args.*in progress.*done.*failed/,
		);
	});

	it("renders every registered tool in every lifecycle state without throwing", async () => {
		for (const name in toolRenderers) {
			const fixture = resolveFixture(name);
			for (const state of GALLERY_STATES) {
				const lines = await renderGalleryState(name, fixture, state, 100);
				// A renderer that produces no lines for a state is a regression: the
				// component should always emit at least the call header or result.
				expect(lines.length, `${name}/${state} rendered nothing`).toBeGreaterThan(0);
			}
		}
	});

	it("routes each state to the matching args/result (streaming args vs result, success vs error)", async () => {
		const fixture: GalleryFixture = {
			label: "Bash",
			streamingArgs: { command: "echo STREAM_MARK" },
			args: { command: "echo PROGRESS_MARK" },
			result: { content: [{ type: "text", text: "SUCCESS_OUT" }], details: { exitCode: 0 } },
			errorResult: { content: [{ type: "text", text: "ERROR_OUT" }], isError: true, details: { exitCode: 1 } },
		};
		const render = async (state: (typeof GALLERY_STATES)[number]) =>
			Bun.stripANSI((await renderGalleryState("bash", fixture, state, 100)).join("\n"));

		const streaming = await render("streaming");
		expect(streaming).toContain("STREAM_MARK");
		expect(streaming).not.toContain("PROGRESS_MARK");
		expect(streaming).not.toContain("SUCCESS_OUT");

		const progress = await render("progress");
		expect(progress).toContain("PROGRESS_MARK");
		expect(progress).not.toContain("SUCCESS_OUT");

		const success = await render("success");
		expect(success).toContain("SUCCESS_OUT");
		expect(success).not.toContain("ERROR_OUT");

		const error = await render("error");
		expect(error).toContain("ERROR_OUT");
		expect(error).not.toContain("SUCCESS_OUT");
	});

	it("routes customRendered tools (task) through the custom-tool branch", async () => {
		// `task` attaches its renderer on the real AgentTool, so the gallery must
		// reproduce that path. With a result present and mergeCallAndResult, the
		// custom branch must NOT emit a redundant tool-name line above the result box
		// (regression guard for tool-execution's custom-branch fallback label).
		const task = resolveFixture("task");
		expect(task.customRendered).toBe(true);
		const lines = await renderGalleryState("task", task, "error", 100);
		const stripped = lines.map(line => Bun.stripANSI(line).trim());
		// The framed result header carries the label inside the box border...
		expect(stripped.some(line => line.startsWith(theme.boxSharp.topLeft) && line.includes("Task"))).toBe(true);
		// ...but no standalone "Task" label line precedes it.
		expect(stripped).not.toContain("Task");
	});

	it("renders curated failed states as failures", async () => {
		const cases = [
			["irc_inbox", "IRC inbox failed: message store unavailable.", "IRC inbox empty"],
			["irc_list", "IRC list failed: agent hub is unavailable.", "no other agents"],
			["job", "Subagent exited 1: Redis connection string is missing.", "cancelled"],
		] as const;

		for (const [name, expected, forbidden] of cases) {
			const output = Bun.stripANSI((await renderGalleryState(name, resolveFixture(name), "error", 100)).join("\n"));
			expect(output).toContain(expected);
			expect(output).not.toContain(forbidden);
		}
	});

	it("renders gallery-only read group fixtures", async () => {
		const fixture = resolveFixture("read_group");
		const success = Bun.stripANSI((await renderGalleryState("read_group", fixture, "success", 140)).join("\n"));
		const renderPathMatches = success.match(/packages\/coding-agent\/src\/task\/render\.ts/g) ?? [];

		expect(success).toContain("Read (4)");
		expect(renderPathMatches).toHaveLength(1);
		expect(success).toContain("packages/coding-agent/src/task/render.ts:507-605,1070-1194,…,1270-1274");
		expect(success).not.toContain("1210-1240");
		expect(success).not.toContain("full file");
	});

	it("falls back to a generic fixture for registry tools without curated sample data", () => {
		// resolveFixture never returns undefined for a registry tool, even one
		// missing from the curated fixtures, so the gallery cannot crash on a newly
		// added renderer.
		const fixture = resolveFixture("a-tool-that-has-no-fixture");
		expect(fixture.args).toBeDefined();
		expect(fixture.result.content.length).toBeGreaterThan(0);
	});

	it("exits 1 with the error on stderr for an unknown --tool", async () => {
		// Scripts must be able to distinguish "tool doesn't exist" from an empty
		// gallery: the refusal goes to stderr and the exit code is non-zero.
		const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");
		const { env, cleanup } = hermeticSpawnEnv();
		let stdout: string;
		let stderr: string;
		let exitCode: number;
		try {
			const proc = Bun.spawn([process.execPath, cliEntry, "gallery", "--tool", "nonexistent-tool"], {
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			[stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
		} finally {
			cleanup();
		}
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Unknown tool 'nonexistent-tool'");
		expect(stderr).toContain("Known tools:");
		expect(stdout).not.toContain("Unknown tool");
	}, 30_000);
});

/**
 * `veyyon gallery --theme <name>` (GALLERY-THEME-FLAG) renders the gallery once
 * per named theme so a UI change can be proven across the theme matrix
 * (`.veyyon/skills/ui`) in a single invocation instead of seeding each theme
 * through `config set`. These tests lock the contract the skill relies on:
 *
 *  - a theme name genuinely changes the rendered ANSI (the SGR bytes differ),
 *    so a two-theme run produces two distinct proofs, not one repeated;
 *  - an unknown theme fails the WHOLE run loudly, naming the offender, rather
 *    than silently falling back to the active theme (Law 10);
 *  - rendering a theme does not mutate the profile's stored `theme.dark`/
 *    `theme.light`, so a matrix capture is a read-only render pass;
 *  - the per-theme output path is suffixed deterministically so the files of a
 *    matrix never collide.
 */
describe("gallery --theme matrix (GALLERY-THEME-FLAG)", () => {
	// setTheme mutates the module theme singleton; restore the test baseline
	// after this block so it cannot leak into later suites in the same process.
	afterAll(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
	});

	it("renders once per theme, and each theme produces genuinely different ANSI bytes", async () => {
		const available = new Set(await getAvailableThemes({ includeHidden: true }));
		// Two brand grounds that must differ: titanium (silver on black) vs light
		// (structure on white). Both are shipped builtins.
		expect(available.has("titanium")).toBe(true);
		expect(available.has("light")).toBe(true);

		const rendered = await renderGalleryForThemes(["titanium", "light"], ["bash"], ["success"], 100, false);
		expect(rendered.map(r => r.theme)).toEqual(["titanium", "light"]);

		const ansiOf = (name: string) =>
			rendered
				.find(r => r.theme === name)!
				.sections.flatMap(s => s.lines)
				.join("\n");
		const titanium = ansiOf("titanium");
		const light = ansiOf("light");

		// Both actually rendered the tool...
		expect(titanium).toContain("bash");
		expect(light).toContain("bash");
		// ...and the two carry different color escapes: the theme changed the pixels,
		// not just the label. A degenerate matrix (two identical shots) is the exact
		// failure the ui-skill differential is meant to catch, so it must fail here.
		expect(titanium).not.toBe(light);
		expect(titanium).toContain("[");
		expect(light).toContain("[");
		// The stripped text is identical (same tool, same state); only styling moved.
		expect(Bun.stripANSI(titanium)).toBe(Bun.stripANSI(light));
	});

	it("preserves order and renders duplicate theme names once each", async () => {
		const rendered = await renderGalleryForThemes(["light", "titanium", "light"], ["bash"], ["success"], 100, false);
		expect(rendered.map(r => r.theme)).toEqual(["light", "titanium", "light"]);
	});

	it("fails the whole run on an unknown theme, naming the offender, with no fallback", async () => {
		await expect(
			renderGalleryForThemes(["titanium", "definitely-not-a-real-theme"], ["bash"], ["success"], 100, false),
		).rejects.toThrow(/Unknown theme 'definitely-not-a-real-theme'\. Known themes: .*titanium/);
	});

	it("does not mutate the profile's stored theme.dark / theme.light", async () => {
		const settings = await Settings.init({ inMemory: true });
		const beforeDark = settings.get("theme.dark");
		const beforeLight = settings.get("theme.light");
		await renderGalleryForThemes(["titanium", "light"], ["bash"], ["success"], 100, false);
		expect(settings.get("theme.dark")).toBe(beforeDark);
		expect(settings.get("theme.light")).toBe(beforeLight);
	});

	it("suffixes the output path per theme so matrix files never collide", () => {
		// Extension preserved, tag inserted before it.
		expect(themedOutPath("shot.png", "light")).toBe("shot-light.png");
		expect(themedOutPath("out/dir/shot.png", "titanium")).toBe("out/dir/shot-titanium.png");
		// Only the final extension is treated as the extension.
		expect(themedOutPath("a.b.png", "light")).toBe("a.b-light.png");
		// No extension: append.
		expect(themedOutPath("shot", "light")).toBe("shot-light");
		// A theme name with path-hostile characters is slugified, never a separator.
		expect(themedOutPath("shot.png", "my/weird theme")).toBe("shot-my-weird-theme.png");
	});

	it("wires --theme through the CLI: a repeated flag prints one labeled block per theme", async () => {
		// End-to-end proof that the multiple `--theme` flag reaches runGalleryCommand
		// and drives the per-theme render path, each block headed by its theme name.
		const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");
		const { env, cleanup } = hermeticSpawnEnv();
		try {
			const proc = Bun.spawn(
				[
					process.execPath,
					cliEntry,
					"gallery",
					"--tool",
					"bash",
					"--theme",
					"titanium",
					"--theme",
					"light",
					"--plain",
				],
				{ env, stdout: "pipe", stderr: "pipe" },
			);
			const [stdout, , exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("# theme: titanium");
			expect(stdout).toContain("# theme: light");
			// Two distinct blocks, in flag order.
			expect(stdout.indexOf("# theme: titanium")).toBeLessThan(stdout.indexOf("# theme: light"));
		} finally {
			cleanup();
		}
	}, 30_000);

	it("exits 1 with the error on stderr for an unknown --theme, printing nothing on stdout", async () => {
		const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");
		const { env, cleanup } = hermeticSpawnEnv();
		try {
			const proc = Bun.spawn(
				[process.execPath, cliEntry, "gallery", "--tool", "bash", "--theme", "definitely-not-a-real-theme"],
				{ env, stdout: "pipe", stderr: "pipe" },
			);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(exitCode).toBe(1);
			expect(stderr).toContain("Unknown theme 'definitely-not-a-real-theme'");
			expect(stderr).toContain("Known themes:");
			expect(stdout).not.toContain("# theme:");
		} finally {
			cleanup();
		}
	}, 30_000);
});
