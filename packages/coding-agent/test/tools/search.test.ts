import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Tool as AiTool } from "@veyyon/ai";
import { toolWireSchema } from "@veyyon/ai/utils/schema";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { SearchTool } from "@veyyon/coding-agent/tools/search";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

function makeSession(cwd: string, overrides: Partial<Record<SettingPath, unknown>> = {}): ToolSession {
	return makeToolSession({
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(overrides),
	});
}

function extractWireModes(tool: SearchTool): string[] {
	const wire = toolWireSchema(tool as unknown as AiTool) as {
		anyOf?: Array<{ properties?: { mode?: { const?: string; enum?: string[] } } }>;
		oneOf?: Array<{ properties?: { mode?: { const?: string; enum?: string[] } } }>;
		properties?: { mode?: { const?: string; enum?: string[] } };
	};
	const variants = wire.anyOf ?? wire.oneOf;
	if (variants) {
		const modes: string[] = [];
		for (const variant of variants) {
			const mode = variant.properties?.mode;
			if (mode?.const) modes.push(mode.const);
			else if (mode?.enum) modes.push(...mode.enum);
		}
		return modes;
	}
	const mode = wire.properties?.mode;
	if (mode?.const) return [mode.const];
	if (mode?.enum) return [...mode.enum];
	return [];
}

describe("SearchTool", () => {
	it("delegates every advertised search mode through the production tools", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "unified-search-"));
		try {
			await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
			await fs.writeFile(path.join(tempDir, "src", "match.ts"), "export const value = needle();\n", "utf8");
			await fs.writeFile(path.join(tempDir, "src", "ignore.js"), "export const value = other();\n", "utf8");
			const tool = new SearchTool(makeSession(tempDir));

			const files = await tool.execute("files", { mode: "files", path: "src/**/*.ts" });
			expect(files.details?.mode).toBe("files");
			expect(files.content.find(item => item.type === "text")?.text).toContain("match.ts");
			expect(files.content.find(item => item.type === "text")?.text).not.toContain("ignore.js");

			const sourceText = await tool.execute("text", {
				mode: "text",
				pattern: "needle",
				path: "src",
			});
			expect(sourceText.details?.mode).toBe("text");
			expect(sourceText.content.find(item => item.type === "text")?.text).toContain("needle()");
			expect(sourceText.content.find(item => item.type === "text")?.text).not.toContain("other()");

			const ast = await tool.execute("ast", {
				mode: "ast",
				pattern: "needle()",
				path: "src/**/*.ts",
			});
			expect(ast.details?.mode).toBe("ast");
			expect(ast.content.find(item => item.type === "text")?.text).toContain("needle()");
			expect(ast.content.find(item => item.type === "text")?.text).not.toContain("other()");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("advertises exactly the enabled primitive capabilities", () => {
		const capabilities = [
			{ setting: "glob.enabled", mode: "files" },
			{ setting: "grep.enabled", mode: "text" },
			{ setting: "astGrep.enabled", mode: "ast" },
		] as const satisfies ReadonlyArray<{ setting: SettingPath; mode: string }>;

		const defaultTool = new SearchTool(makeSession(process.cwd()));
		expect(extractWireModes(defaultTool).sort()).toEqual(capabilities.map(item => item.mode).sort());

		for (const capability of capabilities) {
			const tool = new SearchTool(makeSession(process.cwd(), { [capability.setting]: false }));
			const modes = extractWireModes(tool);
			expect(modes).not.toContain(capability.mode);
			expect(tool.examples.some(example => "call" in example && example.call.mode === capability.mode)).toBe(false);
		}

		const disabled = new SearchTool(
			makeSession(process.cwd(), {
				"glob.enabled": false,
				"grep.enabled": false,
				"astGrep.enabled": false,
			}),
		);
		expect(extractWireModes(disabled)).toEqual(["disabled"]);
		expect(disabled.examples).toEqual([]);
	});

	it("rejects every mode whose underlying capability is disabled", async () => {
		const cases = [
			{
				settings: { "glob.enabled": false },
				call: { mode: "files", path: "src" } as const,
				error: "File search is disabled",
			},
			{
				settings: { "grep.enabled": false },
				call: { mode: "text", pattern: "value", path: "src" } as const,
				error: "Text search is disabled",
			},
			{
				settings: { "astGrep.enabled": false },
				call: { mode: "ast", pattern: "value", path: "src" } as const,
				error: "AST search is disabled",
			},
		];

		for (const testCase of cases) {
			const tool = new SearchTool(makeSession(process.cwd(), testCase.settings));
			await expect(tool.execute("disabled", testCase.call)).rejects.toThrow(testCase.error);
		}
	});
});
