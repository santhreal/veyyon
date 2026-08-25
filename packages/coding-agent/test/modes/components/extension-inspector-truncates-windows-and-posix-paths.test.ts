/**
 * WHY: `InspectorPanel` previously truncated origin paths with `shortened.split("/").length > 3`
 * and a bare numeric limit `40`. On Windows, absolute paths outside the home directory (e.g.
 * `D:\Software\Vendors\Extensions\MyCustomExtension\dist\index.js`) retain backslash `\`
 * separators. Splitting by `"/"` yielded an array of length 1, completely skipping truncation
 * and overflowing the panel with an unbounded file path. Furthermore, joining with `/`
 * created mixed-separator paths.
 *
 * This suite closes the class by verifying that:
 * 1. Windows paths with drive letters and backslash separators are split on both `\` and `/`
 *    and truncated to a recognizable tail with `...\` when exceeding TRUNCATE_LENGTHS.SHORT.
 * 2. POSIX paths are truncated with `.../`.
 * 3. Paths under the home directory are shortened to `~` and truncated.
 * 4. Short paths under TRUNCATE_LENGTHS.SHORT remain intact.
 * 5. Tabs in paths are replaced with spaces.
 *
 * GAP: Does not assert on terminal interactive key navigation of the inspector panel.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { InspectorPanel } from "@veyyon/coding-agent/modes/components/extensions/inspector-panel";
import type { ExtensionRow } from "@veyyon/coding-agent/modes/components/extensions/types";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

const WIDTH = 120;

beforeAll(async () => {
	await initTheme();
});

function extensionWithPath(path: string): ExtensionRow {
	return {
		id: "tool:test",
		kind: "tool",
		name: "test-extension",
		displayName: "Test Extension",
		description: "A test extension for path verification",
		path,
		source: { provider: "test", providerName: "test-provider", level: "user" },
		state: "active",
		raw: { parameters: {} },
	} as ExtensionRow;
}

function renderOriginPath(ext: ExtensionRow): string {
	const panel = new InspectorPanel();
	panel.setExtension(ext);
	const rendered = panel.render(WIDTH).map(line => Bun.stripANSI(line));
	const originIdx = rendered.findIndex(line => line.includes("Origin:"));
	if (originIdx < 0 || originIdx + 2 >= rendered.length) {
		throw new Error(`Could not find Origin section in rendered output: ${rendered.join("\n")}`);
	}
	// Origin section: "Origin:", "  via test-provider (User)", "  <displayPath>"
	return rendered[originIdx + 2].trim();
}

describe("InspectorPanel origin path display and truncation", () => {
	const homedir = os.homedir();

	it("truncates long Windows paths with backslash separators and drive letters", () => {
		const winPath = "D:\\Software\\Development\\Workspace\\Plugins\\CustomExtension\\entry.js";
		const ext = extensionWithPath(winPath);
		const displayPath = renderOriginPath(ext);

		// Must truncate to tail segments with backslash
		expect(displayPath).toBe("...\\Plugins\\CustomExtension\\entry.js");
		expect(displayPath.length).toBeLessThan(winPath.length);
	});

	it("truncates long POSIX paths with forward slash separators", () => {
		const posixPath = "/usr/local/share/extensions/vendor/custom-extension/index.js";
		const ext = extensionWithPath(posixPath);
		const displayPath = renderOriginPath(ext);

		// Must truncate to tail segments with forward slash
		expect(displayPath).toBe(".../vendor/custom-extension/index.js");
		expect(displayPath.length).toBeLessThan(posixPath.length);
	});

	it("shortens home directory prefix before applying truncation", () => {
		const homeNestedPath = `${homedir}/projects/deep/nested/folder/structure/my-ext/index.js`;
		const ext = extensionWithPath(homeNestedPath);
		const displayPath = renderOriginPath(ext);

		expect(displayPath).not.toContain(homedir);
		expect(displayPath).toBe(".../structure/my-ext/index.js");
	});

	it("does not truncate short Windows paths", () => {
		const shortWinPath = "D:\\ext\\index.js";
		const ext = extensionWithPath(shortWinPath);
		const displayPath = renderOriginPath(ext);

		expect(displayPath).toBe("D:\\ext\\index.js");
	});

	it("does not truncate short POSIX paths", () => {
		const shortPosixPath = "/opt/ext.js";
		const ext = extensionWithPath(shortPosixPath);
		const displayPath = renderOriginPath(ext);

		expect(displayPath).toBe("/opt/ext.js");
	});

	it("replaces tabs in origin paths", () => {
		const pathWithTabs = "/opt\t/ext\t/index.js";
		const ext = extensionWithPath(pathWithTabs);
		const displayPath = renderOriginPath(ext);

		expect(displayPath).not.toContain("\t");
		expect(displayPath).toContain(" ");
	});
});
