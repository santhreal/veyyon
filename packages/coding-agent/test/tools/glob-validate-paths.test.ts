import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import { getThemeByName, initTheme, type Theme } from "@veyyon/coding-agent/theme/theme";
import {
	expandDelimitedPathEntries,
	parseFindPattern,
	splitDelimitedPathEntry,
} from "@veyyon/coding-agent/tools/core/path-utils";
import { toolRenderers } from "@veyyon/coding-agent/tools/renderers";
import type { FileSearchDetails, FileSearchRenderArgs } from "@veyyon/coding-agent/tools/search/file-search";
import type { SearchToolDetails, SearchToolInput } from "@veyyon/coding-agent/tools/search/search";
import { resolveToolSearchScope } from "@veyyon/coding-agent/tools/search/search-scope";
import type { Component } from "@veyyon/tui";
import { removeWithRetries } from "@veyyon/utils";

/**
 * The production `search` entry, which is the card a session draws. `search` is a view the terminal
 * draws rather than a renderer module to import, so the suites below reach it through the registry.
 */
const searchToolRenderer = toolRenderers.search;

let uiTheme: Theme;

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Missing dark theme");
	uiTheme = theme;
});
const renderOptions: RenderResultOptions = {
	expanded: false,
	isPartial: true,
};

function renderText(component: Component): string {
	return Bun.stripANSI(component.render(160).join("\n"));
}

describe("delimited path expansion", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "delimited-paths-"));
		await fs.mkdir(path.join(tempDir, "apps"), { recursive: true });
		await fs.mkdir(path.join(tempDir, "packages"), { recursive: true });
		await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
		await fs.mkdir(path.join(tempDir, "folder with spaces"), { recursive: true });
		await Bun.write(path.join(tempDir, "apps", "a.txt"), "apps\n");
		await Bun.write(path.join(tempDir, "packages", "b.txt"), "packages\n");
		await Bun.write(path.join(tempDir, "folder with spaces", "file.txt"), "spaces\n");
	});

	afterEach(async () => {
		await removeWithRetries(tempDir);
	});

	it("splits comma, semicolon, and space delimited entries when parts resolve", async () => {
		expect(await splitDelimitedPathEntry("apps/a.txt, packages/b.txt", tempDir)).toEqual([
			"apps/a.txt",
			"packages/b.txt",
		]);
		expect(await splitDelimitedPathEntry("apps/a.txt;packages/b.txt", tempDir)).toEqual([
			"apps/a.txt",
			"packages/b.txt",
		]);
		expect(await splitDelimitedPathEntry("apps/a.txt packages/b.txt", tempDir)).toEqual([
			"apps/a.txt",
			"packages/b.txt",
		]);
	});

	it("keeps an existing path with spaces intact", async () => {
		expect(await splitDelimitedPathEntry("folder with spaces/file.txt", tempDir)).toBeNull();
		expect(await expandDelimitedPathEntries(["folder with spaces/file.txt"], tempDir)).toEqual([
			"folder with spaces/file.txt",
		]);
	});

	it("does not split commas inside brace globs", async () => {
		expect(await splitDelimitedPathEntry("src/{a,b}.txt", tempDir)).toBeNull();
		expect(await splitDelimitedPathEntry("src/{a,b}.txt, packages/b.txt", tempDir)).toEqual([
			"src/{a,b}.txt",
			"packages/b.txt",
		]);
	});

	it("does not split backslash-escaped delimiters", async () => {
		expect(await splitDelimitedPathEntry("apps/a.txt\\,packages/b.txt", tempDir)).toBeNull();
		expect(await splitDelimitedPathEntry("apps/a.txt\\;packages/b.txt", tempDir)).toBeNull();
		expect(await splitDelimitedPathEntry("folder\\ with\\ spaces/file.txt packages/b.txt", tempDir)).toBeNull();
	});

	it("uses strong delimiters leniently and whitespace delimiters conservatively", async () => {
		expect(await splitDelimitedPathEntry("missing.txt, packages/b.txt", tempDir)).toEqual([
			"missing.txt",
			"packages/b.txt",
		]);
		expect(await splitDelimitedPathEntry("missing.txt;packages/b.txt", tempDir)).toEqual([
			"missing.txt",
			"packages/b.txt",
		]);
		expect(await splitDelimitedPathEntry("missing.txt packages/b.txt", tempDir)).toBeNull();
	});

	it("cleans trailing strong delimiters and expands glob entries", async () => {
		expect(await expandDelimitedPathEntries(["apps/a.txt,"], tempDir)).toEqual(["apps/a.txt"]);
		expect(
			await expandDelimitedPathEntries(["apps/**/*.txt, packages/**/*.txt"], tempDir, {
				splitter: parseFindPattern,
			}),
		).toEqual(["apps/**/*.txt", "packages/**/*.txt"]);
	});

	it("normalizes Windows path separators before parsing find globs", async () => {
		expect(parseFindPattern("apps\\**\\*.txt")).toEqual({
			basePath: "apps",
			globPattern: "**/*.txt",
			hasGlob: true,
		});

		expect(await splitDelimitedPathEntry("apps/a.txt\\,packages/b.txt", tempDir)).toBeNull();
		const parsed = parseFindPattern("C:\\work\\repo\\src\\**\\*.ts");
		expect(parsed).toEqual({
			basePath: "C:/work/repo/src",
			globPattern: "**/*.ts",
			hasGlob: true,
		});
	});

	it("normalizes Windows separators for search scope globs", async () => {
		const scope = await resolveToolSearchScope({
			rawPaths: ["apps\\**\\*.txt"],
			cwd: tempDir,
			internalUrlAction: "search",
		});

		expect(scope.searchPath).toBe(path.join(tempDir, "apps"));
		expect(scope.globFilter).toBe("**/*.txt");
	});
});

/**
 * The `files` branch of the production search renderer, which is the path a session draws: the card
 * is a view the terminal draws rather than a renderer module to import, so the type-bearing arguments
 * and the nested details are assembled here and every assertion below stays on the real bytes.
 */
const fileSearchRenderer = {
	renderCall: (args: FileSearchRenderArgs, options: RenderResultOptions, theme: Theme): Component =>
		searchToolRenderer.renderCall({ ...args, type: "files" } as unknown as SearchToolInput, options, theme),
	renderResult: (
		result: { content: Array<{ type: string; text?: string }>; details?: FileSearchDetails; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: FileSearchRenderArgs,
	): Component =>
		searchToolRenderer.renderResult(
			{
				content: result.content,
				details: { type: "files", result: result.details } as unknown as SearchToolDetails,
				...(result.isError === undefined ? {} : { isError: result.isError }),
			},
			options,
			theme,
			args === undefined ? undefined : ({ ...args, type: "files" } as unknown as SearchToolInput),
		),
};

describe("the files search card", () => {
	it("accepts a single string paths value before validation", async () => {
		const args = { input: "src/**/*.ts" };
		const renderings = [
			fileSearchRenderer.renderCall(args, renderOptions, uiTheme),
			fileSearchRenderer.renderResult(
				{ content: [{ type: "text", text: "src/index.ts\n" }] },
				renderOptions,
				uiTheme,
				args,
			),
			fileSearchRenderer.renderResult(
				{ content: [{ type: "text", text: "" }], details: { fileCount: 0, files: [] } },
				renderOptions,
				uiTheme,
				args,
			),
			fileSearchRenderer.renderResult(
				{ content: [{ type: "text", text: "src/index.ts" }], details: { fileCount: 1, files: ["src/index.ts"] } },
				renderOptions,
				uiTheme,
				args,
			),
		];

		for (const component of renderings) {
			expect(renderText(component)).toContain("src/**/*.ts");
		}
	});
});
