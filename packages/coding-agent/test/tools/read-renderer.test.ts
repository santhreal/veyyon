import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { theme as activeTheme, getThemeByName, initTheme } from "@veyyon/coding-agent/theme/theme";
import { readToolView } from "@veyyon/coding-agent/tools/fs/read-view";
import type { TUI } from "@veyyon/tui";
import { createToolExecution } from "../helpers/tool-execution";

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

function extractLinkTexts(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;[^\x1b]+\x1b\\([\s\S]*?)\x1b\]8;;\x1b\\/g)].map(match =>
		Bun.stripANSI(match[1]!),
	);
}

beforeAll(async () => {
	await initTheme();
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	settings.clearOverride("tui.hyperlinks");
});

afterAll(() => {
	resetSettingsForTest();
});

describe("the read card's hyperlinks", () => {
	it("links a local-style read row to the resolved filesystem path and the line it read at", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const handoffPath = path.resolve("/tmp/veyyon-local/handoff.md");
		const component = drawToolView(
			readToolView.renderResult(
				{
					content: [{ type: "text", text: "second line" }],
					details: {
						resolvedPath: handoffPath,
						displayContent: { text: "second line", startLine: 2 },
						contentType: "text/plain",
					},
				},
				{ expanded: false, partial: false },
				{ path: "local://handoff.md:2" },
			),
			theme!,
		);

		const rendered = component.render(200).join("\n");
		expect(rendered).toContain("local://handoff.md");
		expect(rendered).toContain(":2");
		const handoffUri = new URL(url.pathToFileURL(path.resolve(handoffPath)).href);
		handoffUri.searchParams.set("line", "2");
		expect(extractLinkUris(rendered)).toContain(handoffUri.href);
		// The description a row states IS the window that was read, selector and all, so the whole of
		// it is the reachable run rather than the path with the selector trailing outside the link.
		expect(extractLinkTexts(rendered)).toContain("local://handoff.md:2");
	});

	it("links an absolute read call to a file URI at the selector's first line", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const examplePath = path.resolve("/tmp/veyyon-read/example.ts");
		const component = drawToolView(
			readToolView.renderCall({ path: `${examplePath}:10-12` }, { expanded: false, partial: false }),
			theme!,
		);

		const rendered = component.render(200).join("\n");
		expect(Bun.stripANSI(rendered)).toContain(`${examplePath}:10-12`);
		const exampleUri = new URL(url.pathToFileURL(path.resolve(examplePath)).href);
		exampleUri.searchParams.set("line", "10");
		expect(extractLinkUris(rendered)).toContain(exampleUri.href);
		expect(extractLinkTexts(rendered)).toContain(`${examplePath}:10-12`);
	});

	it("links an HTTP read result to the final URL", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = drawToolView(
			readToolView.renderResult(
				{
					content: [{ type: "text", text: "---\n\nhello" }],
					details: {
						kind: "url",
						url: "http://example.com/start",
						finalUrl: "http://example.com/final",
						contentType: "text/plain",
						method: "fetch",
						truncated: false,
						notes: [],
					},
				} as never,
				{ expanded: false, partial: false },
				{ path: "http://example.com/start" },
			),
			theme!,
		);

		const rendered = component.render(200).join("\n");
		expect(rendered).toContain("example.com /final");
		expect(extractLinkUris(rendered)).toContain("http://example.com/final");
	});
});

describe("read ToolExecutionComponent framing", () => {
	it("renders read results on the rail inside the standard tool container padding", () => {
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const component = createToolExecution("read", { path: "src/example.ts" }, {}, undefined, uiStub);
		component.updateResult(
			{
				content: [{ type: "text", text: "export const x = 1;" }],
				details: {
					displayContent: { text: "export const x = 1;", startLine: 1 },
					contentType: "text/plain",
				},
			},
			false,
		);

		try {
			const rail = activeTheme.symbol("block.rail");
			const lines = component.render(80).map(line => Bun.stripANSI(line));
			// Every row of the block hangs on one rail, the title row included, so the
			// block has a single left edge from its title to its last row of output.
			// Nothing closes it: the last row of output is the last row of the block,
			// which is what the rail replaced two chrome rows with.
			const titleIndex = lines.findIndex(line => line.includes("Read"));
			expect(titleIndex).toBeGreaterThanOrEqual(0);
			expect(lines[titleIndex]).toStartWith(`  ${rail} `);
			expect(lines[titleIndex + 1]).toStartWith(`  ${rail} `);
			expect(lines[titleIndex + 1]).toContain("export const x = 1;");
			for (const line of lines.slice(titleIndex + 2)) expect(line.trim()).toBe("");
		} finally {
			component.stopAnimation();
		}
	});
});
