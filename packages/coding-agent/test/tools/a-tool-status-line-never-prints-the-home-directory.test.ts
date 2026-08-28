/**
 * WHY: four search renderers interpolated their path arguments into the pending
 * status line verbatim — `grep.ts`, `glob.ts`, `ast-grep.ts` and `ast-edit.ts`
 * each built ``in ${paths.join(", ")}``. A model that passed an absolute path
 * printed the operator's home directory into the transcript, and a handful of
 * long paths pushed the row past the terminal width. Both are the display
 * contract every other tool string already follows (`shortenPath`, then
 * `truncateToWidth`).
 *
 * The class is "a call renderer that shows a path the model supplied". It is
 * closed at two levels: `formatScopeMeta` is the single owner of the fragment
 * and is pinned directly, and every renderer in the live `toolRenderers`
 * registry is swept with home-absolute paths under every path-shaped argument
 * key, so a new tool that prints one turns this suite red without anyone
 * remembering to extend a list.
 *
 * Not caught: a renderer that leaks a home path through `renderResult` details
 * rather than through its call arguments, and a leak spelled with a home
 * directory this process does not report as its own.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import os from "node:os";
import type { Theme } from "@veyyon/coding-agent/modes/theme/theme";
import { getThemeByName, initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { sanitizeText } from "@veyyon/utils";
import { astEditToolRenderer } from "../../src/tools/ast-edit";
import { fileSearchRenderer as globToolRenderer } from "../../src/tools/file-search";
import { formatScopeMeta, TRUNCATE_LENGTHS } from "../../src/tools/render-utils";
import { toolRenderers } from "../../src/tools/renderers";
import { astGrepToolRenderer } from "../../src/tools/structure-search";
import { textSearchRenderer as grepToolRenderer } from "../../src/tools/text-search";

const HOME = os.homedir();
const RENDER_WIDTH = 240;

let uiTheme: Theme;

beforeAll(async () => {
	await initTheme();
	const theme = await getThemeByName("dark");
	expect(theme).toBeDefined();
	uiTheme = theme!;
});

function plain(component: { render(width: number): readonly string[] }): string {
	return sanitizeText(component.render(RENDER_WIDTH).join("\n"));
}

describe("formatScopeMeta", () => {
	it("shortens a home-directory path to a tilde", () => {
		expect(formatScopeMeta(`${HOME}/workspace/project/src`)).toBe("in ~/workspace/project/src");
	});

	it("shortens every entry of a list, not only the first", () => {
		expect(formatScopeMeta([`${HOME}/a`, `${HOME}/b`])).toBe("in ~/a, ~/b");
	});

	it("leaves a path outside the home directory alone", () => {
		expect(formatScopeMeta("/etc/hosts")).toBe("in /etc/hosts");
	});

	it("bounds the fragment so a long list cannot dominate the status row", () => {
		const many = Array.from({ length: 40 }, (_, i) => `${HOME}/workspace/project/package-${i}/src`);
		const fragment = formatScopeMeta(many);
		expect(fragment).not.toContain(HOME);
		expect(fragment.length).toBeLessThanOrEqual("in ".length + TRUNCATE_LENGTHS.CONTENT);
	});
});

/**
 * The four renderers reached through their real `renderCall`, with the argument
 * shape each one actually reads. `glob` shows its scope as the status
 * description, the other three as an `in <paths>` meta chip; both spellings
 * must be shortened. A leak here is the reported defect; the sweep below is
 * what closes the class around it.
 */
describe("a search renderer shortens the scope it was given", () => {
	const scope = `${HOME}/workspace/project/src`;
	const cases: ReadonlyArray<
		[string, { renderCall(a: never, o: never, t: Theme): { render(w: number): readonly string[] } }, object, string]
	> = [
		["text search", grepToolRenderer, { input: "needle", path: scope }, "in ~/workspace/project/src"],
		["file search", globToolRenderer, { input: "*.ts" }, "Search files"],
		["structure search", astGrepToolRenderer, { input: "$A()", path: scope }, "in ~/workspace/project/src"],
		[
			"ast_edit",
			astEditToolRenderer,
			{ ops: [{ pat: "$A()", out: "$B()" }], paths: [scope] },
			"in ~/workspace/project/src",
		],
	];

	for (const [name, renderer, args, expected] of cases) {
		it(`renders ~ instead of the home directory for ${name}`, () => {
			const text = plain(
				renderer.renderCall(args as never, { expanded: false, isPartial: false } as never, uiTheme),
			);
			expect(text).not.toContain(HOME);
			expect(text).toContain(expected);
		});
	}
});

/**
 * Every renderer in the live registry, not a list someone maintains. Each is
 * handed home-absolute values under every path-shaped key any tool declares, so
 * a renderer that prints one without shortening it fails here on the day it is
 * added.
 */
describe("no tool call renderer prints an absolute home path", () => {
	const absolute = `${HOME}/workspace/project/src/index.ts`;
	const pathShapedArgs = {
		path: absolute,
		paths: [absolute],
		file: absolute,
		cwd: `${HOME}/workspace/project`,
		program: absolute,
		filePath: absolute,
		target: absolute,
	};

	it("sweeps the registry with home-absolute path arguments", () => {
		const leaked: string[] = [];
		const unrenderable: string[] = [];
		for (const [name, renderer] of Object.entries(toolRenderers)) {
			if (typeof renderer.renderCall !== "function") continue;
			let text: string;
			try {
				text = plain(
					renderer.renderCall(pathShapedArgs as never, { expanded: false, isPartial: false } as never, uiTheme),
				);
			} catch {
				unrenderable.push(name);
				continue;
			}
			if (text.includes(HOME)) leaked.push(name);
		}
		expect(leaked).toEqual([]);
		// A renderer this harness cannot drive is a hole in the sweep, not a pass.
		expect(unrenderable).toEqual([]);
	});
});
