import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, initTheme, type Theme } from "@veyyon/coding-agent/theme/theme";
import { renderFileList } from "@veyyon/coding-agent/tui/file-list";
import { sanitizeText } from "@veyyon/utils";

let uiTheme: Theme;

beforeAll(async () => {
	await initTheme();
	uiTheme = (await getThemeByName("dark"))!;
});

describe("renderFileList", () => {
	it("renders plain body lines with no tree connectors", () => {
		const files = [{ path: "src/index.ts" }, { path: "src/utils.ts" }];
		const lines = renderFileList({ files, expanded: true }, uiTheme);
		expect(lines.length).toBe(2);
		for (const line of lines) {
			const plain = sanitizeText(line);
			expect(plain).not.toMatch(/[├└│]/);
			// Files are indented by 2 spaces
			expect(plain.startsWith("  ")).toBe(true);
		}
	});

	it("renders directory headers with 0 indent and files with 2 space indent", () => {
		const files = [
			{ path: "src/", isDirectory: true },
			{ path: "src/index.ts", isDirectory: false },
			{ path: "pkg/", isDirectory: true },
			{ path: "pkg/main.go" },
		];
		// With showIcons: false
		const linesNoIcons = renderFileList({ files, expanded: true, showIcons: false }, uiTheme);
		const plainNoIcons = linesNoIcons.map(l => sanitizeText(l));
		expect(plainNoIcons[0]!).toBe("src/");
		expect(plainNoIcons[1]!).toBe("  src/index.ts");
		expect(plainNoIcons[2]!).toBe("pkg/");
		expect(plainNoIcons[3]!).toBe("  pkg/main.go");

		// With showIcons: true
		const linesWithIcons = renderFileList({ files, expanded: true, showIcons: true }, uiTheme);
		const plainWithIcons = linesWithIcons.map(l => sanitizeText(l));
		// Directory lines do not start with the 2-space file indent
		expect(plainWithIcons[0]!.startsWith("  ")).toBe(false);
		expect(plainWithIcons[0]!).toContain("src/");
		expect(plainWithIcons[2]!.startsWith("  ")).toBe(false);
		expect(plainWithIcons[2]!).toContain("pkg/");
		// File lines start with 2-space indent
		expect(plainWithIcons[1]!.startsWith("  ")).toBe(true);
		expect(plainWithIcons[1]!).toContain("src/index.ts");
		expect(plainWithIcons[3]!.startsWith("  ")).toBe(true);
		expect(plainWithIcons[3]!).toContain("pkg/main.go");
	});

	it("respects collapsed budget and emits a plain dim overflow line", () => {
		const files = Array.from({ length: 12 }, (_, i) => ({ path: `file_${i}.ts` }));

		// Collapsed (maxCollapsed = 8)
		const collapsed = renderFileList({ files, expanded: false, maxCollapsed: 8 }, uiTheme);
		const plainCollapsed = collapsed.map(l => sanitizeText(l));
		expect(plainCollapsed.length).toBe(9); // 8 items + 1 overflow
		for (const line of plainCollapsed) {
			expect(line).not.toMatch(/[├└│]/);
		}
		expect(plainCollapsed[8]!).toBe("… 4 more files");

		// Expanded
		const expanded = renderFileList({ files, expanded: true, maxCollapsed: 8 }, uiTheme);
		const plainExpanded = expanded.map(l => sanitizeText(l));
		expect(plainExpanded.length).toBe(12);
		expect(plainExpanded.some(l => l.includes("more file"))).toBe(false);
	});

	it("invokes hyperlinkFn with absolute path when provided", () => {
		const files = [{ path: "src/a.ts", absPath: "/workspace/src/a.ts" }, { path: "src/b.ts" }];
		const linked: string[] = [];
		const hyperlinkFn = (absPath: string, display: string) => {
			linked.push(absPath);
			return `[LINK:${absPath}]${display}`;
		};
		const lines = renderFileList({ files, expanded: true, hyperlinkFn }, uiTheme);
		expect(linked).toEqual(["/workspace/src/a.ts"]);
		expect(lines[0]!).toContain("[LINK:/workspace/src/a.ts]");
	});
});
