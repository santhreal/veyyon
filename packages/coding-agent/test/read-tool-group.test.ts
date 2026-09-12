import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { Settings, settings } from "@veyyon/coding-agent/config/settings";
import { getDefault } from "@veyyon/coding-agent/config/settings-schema";
import {
	ReadToolGroupComponent,
	readArgsTargetInternalUrl,
} from "@veyyon/coding-agent/modes/terminal/components/transcript/read-tool-group";
import { buildToolExecutionBlock } from "@veyyon/coding-agent/presentation/tool-execution";
import * as themeModule from "@veyyon/coding-agent/theme/theme";
import type { ReadEntryView } from "@veyyon/wire/presentation/transcript";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";
import { useFullColor } from "./helpers/theme-assertions";

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

function extractLinkTexts(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;[^\x1b]+\x1b\\([\s\S]*?)\x1b\]8;;\x1b\\/g)].map(match =>
		Bun.stripANSI(match[1]!),
	);
}

describe("ReadToolGroupComponent", () => {
	useFullColor();

	let settingsState: SettingsTestState | undefined;

	beforeAll(async () => {
		settingsState = beginSettingsTest();
		await Settings.init({ inMemory: true });
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	afterEach(() => {
		settings.clearOverride("tui.hyperlinks");
		vi.restoreAllMocks();
	});

	afterAll(() => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	// Wire snapshots must preserve every grouped-read status and the rendered preview.
	// Existing tests below pin the historical output independently of the shared projector.
	const wireCases: Record<
		ReadEntryView["status"],
		{
			result: { content: Array<{ type: string; text: string }>; details?: unknown; isError?: boolean };
			content?: string;
			path?: string;
		}
	> = {
		pending: { result: { content: [{ type: "text", text: "unfinished preview" }] } },
		success: {
			result: {
				content: [{ type: "text", text: "model excerpt" }],
				details: { displayContent: { text: "display excerpt", startLine: 7, lineNumbers: [7, null, 9] } },
			},
			content: "display excerpt",
		},
		warning: {
			result: {
				content: [{ type: "text", text: "corrected excerpt" }],
				details: { suffixResolution: { from: "input.ts", to: "src/resolved.ts" } },
			},
			content: "corrected excerpt",
			path: "src/resolved.ts:7-9",
		},
		notExecuted: {
			result: {
				content: [{ type: "text", text: "model-only skipped result" }],
				details: { __skipped: true },
			},
		},
		error: {
			result: { content: [{ type: "text", text: "read failed" }], isError: true },
			content: "read failed",
		},
	};

	it.each(Object.entries(wireCases))("preserves %s read rows through a wire round trip", (status, fixture) => {
		const args = { path: "src/input.ts:7-9" };
		const block = buildToolExecutionBlock({
			toolName: "read",
			toolCallId: "read-wire",
			args,
			result: fixture.result,
			isPartial: status === "pending",
		});
		const entry = block.display?.readEntry;
		expect(entry?.status).toBe(status as ReadEntryView["status"]);
		expect(entry?.path).toBe(fixture.path ?? args.path);
		expect(entry?.contentText).toBe(fixture.content);
		if (!entry) throw new Error("Read display metadata is missing");
		if (status === "success") expect(entry.codeLineNumbers).toEqual([7, null, 9]);
		const snapshot = Object.freeze(JSON.parse(JSON.stringify(entry)) as ReadEntryView);
		const wire = new ReadToolGroupComponent({ showContentPreview: true });
		const legacy = new ReadToolGroupComponent({ showContentPreview: true });
		try {
			wire.updateEntry(snapshot);
			legacy.updateArgs(args, "read-wire");
			legacy.updateResult(fixture.result, status === "pending", "read-wire");
			for (const width of [40, 120]) {
				expect(wire.render(width)).toEqual(legacy.render(width));
			}
			wire.updateArgs({ path: "src/next.ts" }, "read-wire");
			expect(snapshot.path).toBe(fixture.path ?? args.path);
		} finally {
			wire.dispose();
			legacy.dispose();
		}
	});

	it("preserves an execution error supplied outside the read result", () => {
		const block = buildToolExecutionBlock({
			toolName: "read",
			toolCallId: "read-error",
			args: { path: "src/input.ts" },
			result: { content: [{ type: "text", text: "read failed" }] },
			isError: true,
			isPartial: false,
		});
		expect(block.display?.readEntry?.status).toBe("error");
	});

	it("keeps inline read previews disabled by default", () => {
		expect(getDefault("read.toolResultPreview")).toBe(false);

		const component = new ReadToolGroupComponent();
		const examplePath = path.resolve("/tmp/example.ts");
		component.updateArgs({ path: examplePath }, "read-0");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4" }],
			},
			false,
			"read-0",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		expect(rendered).toContain(`Read ${examplePath}`);
		expect(rendered).not.toContain("line 1");
		expect(rendered.toLowerCase()).not.toContain("ctrl+o");
	});

	it("uses the enabled dot for completed reads", () => {
		const component = new ReadToolGroupComponent();
		const examplePath = path.resolve("/tmp/example.ts");
		component.updateArgs({ path: examplePath }, "read-success");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 1" }],
			},
			false,
			"read-success",
		);

		const rendered = component.render(120).join("\n");
		const plain = Bun.stripANSI(rendered);

		expect(plain).toContain(themeModule.theme.status.enabled);
		expect(plain).not.toContain(themeModule.theme.status.success);
		expect(rendered).toContain(themeModule.theme.fg("text", themeModule.theme.status.enabled));
		expect(rendered).not.toContain(themeModule.theme.fg("success", themeModule.theme.status.enabled));
	});

	it("omits duplicate success marks from multi-read child rows", () => {
		const component = new ReadToolGroupComponent();
		const onePath = path.resolve("/tmp/one.ts");
		const twoPath = path.resolve("/tmp/two.ts");
		component.updateArgs({ path: onePath }, "read-one");
		component.updateArgs({ path: twoPath }, "read-two");
		component.updateResult({ content: [{ type: "text", text: "one" }] }, false, "read-one");
		component.updateResult({ content: [{ type: "text", text: "two" }] }, false, "read-two");

		const plain = Bun.stripANSI(component.render(120).join("\n"));

		expect(plain).toContain("Read (2)");
		expect(plain).toContain(`${themeModule.theme.tree.branch} ${onePath}`);
		expect(plain).toContain(`${themeModule.theme.tree.last} ${twoPath}`);
		expect(plain).not.toContain(`${themeModule.theme.tree.branch} ${themeModule.theme.status.enabled}`);
		expect(plain).not.toContain(`${themeModule.theme.tree.last} ${themeModule.theme.status.enabled}`);
	});

	it("splits a single selector-delimited read argument into child rows", () => {
		const component = new ReadToolGroupComponent();
		const onePath = path.resolve("/tmp/one.ts");
		const twoPath = path.resolve("/tmp/two.ts");
		const threePath = path.resolve("/tmp/three.ts");
		component.updateArgs({ path: `${onePath}:1-2,${twoPath}:3-4;${threePath}:5-6` }, "read-many");
		component.updateResult({ content: [{ type: "text", text: "combined" }] }, false, "read-many");

		const plain = Bun.stripANSI(component.render(120).join("\n"));

		expect(plain).toContain("Read (3)");
		expect(plain).toContain(`${themeModule.theme.tree.branch} ${onePath}:1-2`);
		expect(plain).toContain(`${themeModule.theme.tree.branch} ${twoPath}:3-4`);
		expect(plain).toContain(`${themeModule.theme.tree.last} ${threePath}:5-6`);
	});

	it("keeps spaces and nested glob commas inside a file while advancing past selector range commas", () => {
		const component = new ReadToolGroupComponent();
		component.updateArgs({ path: "src/a {b,{c,d}}.ts:1-2,5-6,5-6 report.ts:7-8" }, "read-glob-ranges");
		component.updateResult({ content: [{ type: "text", text: "combined" }] }, false, "read-glob-ranges");
		try {
			const plain = Bun.stripANSI(component.render(200).join("\n"));
			expect(plain).toContain("Read (2)");
			expect(plain).toContain(`${themeModule.theme.tree.branch} src/a {b,{c,d}}.ts:1-2,5-6`);
			expect(plain).toContain(`${themeModule.theme.tree.last} 5-6 report.ts:7-8`);
		} finally {
			component.clear();
		}
	});

	it("merges multi-range selectors into one file row", () => {
		const component = new ReadToolGroupComponent();
		const examplePath = path.resolve("/tmp/example.ts");
		component.updateArgs({ path: `${examplePath}:5-10,20-30` }, "read-ranges");
		component.updateResult({ content: [{ type: "text", text: "ranges" }] }, false, "read-ranges");

		const plain = Bun.stripANSI(component.render(120).join("\n"));

		expect(plain).toContain(`Read ${examplePath}:5-10,20-30`);
		expect(plain).not.toContain("Read (2)");
		expect(plain).not.toContain("full file");
	});

	it("merges repeated same-file ranges and truncates long selector lists", () => {
		const component = new ReadToolGroupComponent();
		const renderPath = path.resolve("/tmp/render.ts");
		component.updateArgs({ path: `${renderPath}:507-605` }, "read-one");
		component.updateArgs({ path: `${renderPath}:1070-1194,1210-1240,1270-1274` }, "read-more");
		component.updateResult({ content: [{ type: "text", text: "one" }] }, false, "read-one");
		component.updateResult({ content: [{ type: "text", text: "more" }] }, false, "read-more");

		const plain = Bun.stripANSI(component.render(120).join("\n"));
		const pathMatches = plain.split(renderPath).length - 1;

		expect(pathMatches).toBe(1);
		expect(plain).toContain(`${renderPath}:507-605,1070-1194,…,1270-1274`);
		expect(plain).not.toContain("1210-1240");
	});

	it("uses result-provided recovered targets for delimited reads", () => {
		const component = new ReadToolGroupComponent();
		const onePath = path.resolve("/tmp/one.ts");
		const twoPath = path.resolve("/tmp/two.ts");
		component.updateArgs({ path: `${onePath} ${twoPath}` }, "read-recovered");
		component.updateResult(
			{
				content: [{ type: "text", text: "combined" }],
				details: { displayReadTargets: [onePath, twoPath] },
			},
			false,
			"read-recovered",
		);

		const plain = Bun.stripANSI(component.render(120).join("\n"));

		expect(plain).toContain("Read (2)");
		expect(plain).toContain(`${themeModule.theme.tree.branch} ${onePath}`);
		expect(plain).toContain(`${themeModule.theme.tree.last} ${twoPath}`);
	});

	it("renders warning previews with warning styling instead of success styling", () => {
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		const examplePath = path.resolve("/tmp/example.ts");
		component.updateArgs({ path: examplePath }, "read-1");
		component.updateResult(
			{
				content: [{ type: "text", text: "const a = 1;\nconst b = 2;\nconst c = 3;" }],
				details: { suffixResolution: { from: path.resolve("/tmp/exampl.ts"), to: examplePath } },
			},
			false,
			"read-1",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		expect(rendered).toContain(themeModule.theme.status.warning);
		expect(rendered).not.toContain(themeModule.theme.status.success);
		expect(rendered).toContain("corrected from");
	});

	it("highlights only the collapsed preview lines", () => {
		const highlightSpy = vi.spyOn(themeModule, "highlightCode");
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		const examplePath = path.resolve("/tmp/example.ts");
		component.updateArgs({ path: examplePath }, "read-2");
		component.updateResult(
			{
				content: [
					{
						type: "text",
						text: "line 1\nline 2\nline 3\nline 4\nline 5",
					},
				],
			},
			false,
			"read-2",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		const highlightedInput = highlightSpy.mock.calls[0]?.[0];

		expect(highlightedInput).toBe("line 1\nline 2\nline 3");
		expect(rendered).toContain("line 1");
		expect(rendered).not.toContain("line 4");
		expect(rendered.toLowerCase()).toContain("ctrl+o");
	});

	it("does not render a duplicate summary row when inline previews are enabled", () => {
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		const examplePath = path.resolve("/tmp/example.ts");
		component.updateArgs({ path: `${examplePath}:L10-L20` }, "read-3");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4" }],
			},
			false,
			"read-3",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		const matches = rendered.split(`Read ${examplePath}:L10-L20`).length - 1;

		expect(matches).toBe(1);
	});

	it("links grouped summary paths to resolved filesystem paths and selector lines", () => {
		settings.override("tui.hyperlinks", "always");
		const component = new ReadToolGroupComponent();
		const examplePath = path.resolve("/workspace/src/example.ts");
		component.updateArgs({ path: "src/example.ts:7-9" }, "read-link");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 7" }],
				details: { meta: { source: { type: "path", value: examplePath } } },
			},
			false,
			"read-link",
		);

		const rendered = component.render(120).join("\n");

		const exampleUri = new URL(url.pathToFileURL(path.resolve(examplePath)).href);
		exampleUri.searchParams.set("line", "7");
		expect(Bun.stripANSI(rendered)).toContain("Read src/example.ts:7-9");
		expect(extractLinkUris(rendered)).toContain(exampleUri.href);
		expect(extractLinkTexts(rendered)).toContain("src/example.ts");
		expect(extractLinkTexts(rendered)).not.toContain("src/example.ts:7-9");
	});

	it("links inline preview titles when the summary row is suppressed", () => {
		settings.override("tui.hyperlinks", "always");
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		const previewPath = path.resolve("/workspace/src/preview.ts");
		component.updateArgs({ path: "src/preview.ts:20-22" }, "read-preview-link");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 20\nline 21\nline 22" }],
				details: { resolvedPath: previewPath },
			},
			false,
			"read-preview-link",
		);

		const rendered = component.render(120).join("\n");

		const previewUri = new URL(url.pathToFileURL(path.resolve(previewPath)).href);
		previewUri.searchParams.set("line", "20");
		expect(Bun.stripANSI(rendered)).toContain("Read src/preview.ts:20-22");
		expect(extractLinkUris(rendered)).toContain(previewUri.href);
		expect(extractLinkTexts(rendered)).toContain("src/preview.ts");
		expect(extractLinkTexts(rendered)).not.toContain("src/preview.ts:20-22");
	});
});

describe("readArgsTargetInternalUrl", () => {
	it.each([
		["skill://my-skill"],
		["skill://my-skill/file.md"],
		["veyyon://docs/tools/read.md"],
		["issue://123"],
		["pr://santhreal/veyyon/456"],
		["agent://abc"],
		["artifact://abc"],
		["memory://root"],
		["rule://name"],
		["mcp://server/resource"],
		["local://PLAN.md"],
	])("treats %s as an internal URL read", target => {
		expect(readArgsTargetInternalUrl({ path: target })).toBe(true);
		expect(readArgsTargetInternalUrl({ file_path: target })).toBe(true);
	});

	it.each([[path.resolve("/tmp/example.ts")], ["./relative/path.md"], ["https://example.com/file"], [""]])(
		"treats %s as a filesystem/external target",
		target => {
			expect(readArgsTargetInternalUrl({ path: target })).toBe(false);
		},
	);

	it("returns false for non-record / missing arguments", () => {
		expect(readArgsTargetInternalUrl(undefined)).toBe(false);
		expect(readArgsTargetInternalUrl(null)).toBe(false);
		expect(readArgsTargetInternalUrl("skill://x")).toBe(false);
		expect(readArgsTargetInternalUrl(["skill://x"])).toBe(false);
		expect(readArgsTargetInternalUrl({})).toBe(false);
		expect(readArgsTargetInternalUrl({ path: 42 })).toBe(false);
	});
});
