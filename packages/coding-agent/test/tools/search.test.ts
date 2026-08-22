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

function extractWirePurposes(tool: SearchTool): string[] {
	const wire = toolWireSchema(tool as unknown as AiTool) as {
		anyOf?: Array<{ properties?: { purpose?: { const?: string; enum?: string[] } } }>;
		oneOf?: Array<{ properties?: { purpose?: { const?: string; enum?: string[] } } }>;
		properties?: { purpose?: { const?: string; enum?: string[] } };
	};
	const variants = wire.anyOf ?? wire.oneOf;
	if (variants) {
		const purposes: string[] = [];
		for (const variant of variants) {
			const purpose = variant.properties?.purpose;
			if (purpose?.const) purposes.push(purpose.const);
			else if (purpose?.enum) purposes.push(...purpose.enum);
		}
		return purposes;
	}
	const purpose = wire.properties?.purpose;
	if (purpose?.const) return [purpose.const];
	if (purpose?.enum) return [...purpose.enum];
	return [];
}

describe("SearchTool", () => {
	it("delegates every advertised search purpose through the production tools", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "unified-search-"));
		try {
			await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
			await fs.writeFile(path.join(tempDir, "src", "match.ts"), "export const value = needle();\n", "utf8");
			await fs.writeFile(path.join(tempDir, "src", "ignore.js"), "export const value = other();\n", "utf8");
			const tool = new SearchTool(makeSession(tempDir));

			const files = await tool.execute("locate", { purpose: "locate", path: "src/**/*.ts" });
			expect(files.details?.purpose).toBe("locate");
			expect(files.content.find(item => item.type === "text")?.text).toContain("match.ts");
			expect(files.content.find(item => item.type === "text")?.text).not.toContain("ignore.js");

			const sourceText = await tool.execute("match", {
				purpose: "match",
				pattern: "needle",
				path: "src",
			});
			expect(sourceText.details?.purpose).toBe("match");
			expect(sourceText.content.find(item => item.type === "text")?.text).toContain("needle()");
			expect(sourceText.content.find(item => item.type === "text")?.text).not.toContain("other()");

			const ast = await tool.execute("analyze", {
				purpose: "analyze",
				pattern: "needle()",
				path: "src/**/*.ts",
			});
			expect(ast.details?.purpose).toBe("analyze");
			expect(ast.content.find(item => item.type === "text")?.text).toContain("needle()");
			expect(ast.content.find(item => item.type === "text")?.text).not.toContain("other()");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("advertises exactly the enabled primitive capabilities", () => {
		const capabilities = [
			{ setting: "glob.enabled", purpose: "locate" },
			{ setting: "grep.enabled", purpose: "match" },
			{ setting: "astGrep.enabled", purpose: "analyze" },
		] as const satisfies ReadonlyArray<{ setting: SettingPath; purpose: string }>;

		const defaultTool = new SearchTool(makeSession(process.cwd()));
		expect(extractWirePurposes(defaultTool).sort()).toEqual(capabilities.map(item => item.purpose).sort());

		for (const capability of capabilities) {
			const tool = new SearchTool(makeSession(process.cwd(), { [capability.setting]: false }));
			const purposes = extractWirePurposes(tool);
			expect(purposes).not.toContain(capability.purpose);
			expect(tool.examples.some(example => "call" in example && example.call.purpose === capability.purpose)).toBe(
				false,
			);
		}

		const disabled = new SearchTool(
			makeSession(process.cwd(), {
				"glob.enabled": false,
				"grep.enabled": false,
				"astGrep.enabled": false,
			}),
		);
		expect(extractWirePurposes(disabled)).toEqual(["disabled"]);
		expect(disabled.examples).toEqual([]);
	});

	it("rejects every purpose whose underlying capability is disabled", async () => {
		const cases = [
			{
				settings: { "glob.enabled": false },
				call: { purpose: "locate", path: "src" } as const,
				error: "Path location is disabled",
			},
			{
				settings: { "grep.enabled": false },
				call: { purpose: "match", pattern: "value", path: "src" } as const,
				error: "Content matching is disabled",
			},
			{
				settings: { "astGrep.enabled": false },
				call: { purpose: "analyze", pattern: "value", path: "src" } as const,
				error: "Structural code analysis is disabled",
			},
		];

		for (const testCase of cases) {
			const tool = new SearchTool(makeSession(process.cwd(), testCase.settings));
			await expect(tool.execute("disabled", testCase.call)).rejects.toThrow(testCase.error);
		}
	});
});
