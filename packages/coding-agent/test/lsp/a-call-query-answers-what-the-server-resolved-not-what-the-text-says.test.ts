/**
 * `incoming_calls` and `outgoing_calls` driven through the tool against a real TypeScript language
 * server: vtsls, a devDependency that bundles its own tsserver, so the suite runs wherever the
 * workspace is installed.
 *
 * WHY. "Who calls this" was answered with a text search, which cannot tell a call from a declaration
 * or a comment and cannot follow a name that changed on the way. The fixture holds the three shapes a
 * text search gets wrong: an overloaded function, whose signatures all read as calls to a search for
 * `format(`; a method declared by an interface and implemented twice, whose declarations read as calls;
 * and a function reached only through a renaming re-export, whose calls a search for its name misses.
 * Each is asked of the real server, and the answer is pinned: the caller functions with their call
 * sites, and never a declaration or the comment.
 *
 * WHAT THIS DOES NOT CATCH. The server is vtsls, not typescript-language-server, the default for
 * `.ts`; both answer call hierarchy from tsserver, and the tool sends each the same requests. The
 * report shape, the empty answers and the request sequence are pinned against an in-process server
 * by `test/tools/every-file-bound-lsp-action-reports-what-the-server-answered.test.ts`. Which
 * implementations tsserver attributes an interface call to is the server's decision; only the call
 * through the interface itself is asserted for the second implementation.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { LspTool } from "@veyyon/coding-agent/lsp";
import * as lspClient from "@veyyon/coding-agent/lsp/client";
import * as lspConfig from "@veyyon/coding-agent/lsp/config";
import type { LspParams, ServerConfig } from "@veyyon/coding-agent/lsp/types";
import { TempDir } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

const VTSLS_ENTRY = path.join(
	path.dirname(createRequire(import.meta.url).resolve("@vtsls/language-server/package.json")),
	"bin",
	"vtsls.js",
);

const SERVER_NAME = "vtsls";
const SERVER: ServerConfig = {
	command: SERVER_NAME,
	resolvedCommand: process.execPath,
	args: [VTSLS_ENTRY, "--stdio"],
	fileTypes: [".ts"],
	rootMarkers: ["tsconfig.json"],
};

const FILES: Readonly<Record<string, string>> = {
	"package.json": '{ "name": "call-fixture", "private": true }\n',
	"tsconfig.json":
		'{ "compilerOptions": { "strict": true, "target": "es2022", "module": "esnext", "moduleResolution": "bundler" }, "include": ["src"] }\n',
	"src/format.ts": [
		"export function format(value: number): string;",
		"export function format(value: string): string;",
		"export function format(value: number | string): string {",
		"\treturn String(value);",
		"}",
		"",
	].join("\n"),
	"src/shapes.ts": [
		"export interface Shape {",
		"\tarea(): number;",
		"}",
		"export class Square implements Shape {",
		"\tconstructor(readonly side: number) {}",
		"\tarea(): number {",
		"\t\treturn this.side * this.side;",
		"\t}",
		"}",
		"export class Circle implements Shape {",
		"\tconstructor(readonly radius: number) {}",
		"\tarea(): number {",
		"\t\treturn Math.PI * this.radius * this.radius;",
		"\t}",
		"}",
		"",
	].join("\n"),
	"src/index.ts": 'export { format as render } from "./format";\n',
	"src/report.ts": [
		'import { render } from "./index";',
		'import { Square, type Shape } from "./shapes";',
		"export function describe(shape: Shape): string {",
		"\treturn render(shape.area());",
		"}",
		"// format(1) is named here and is not a call",
		"export function sized(): string {",
		"\treturn render(new Square(2).area());",
		"}",
		"",
	].join("\n"),
};

const DESCRIBE_CALLS_FORMAT = ["  describe (Function) at src/report.ts:3:17", "    4:9: return render(shape.area());"];
const SIZED_CALLS_FORMAT = [
	"  sized (Function) at src/report.ts:7:17",
	"    8:9: return render(new Square(2).area());",
];
const DESCRIBE_CALLS_AREA = ["  describe (Function) at src/report.ts:3:17", "    4:22: return render(shape.area());"];
const SIZED_CALLS_AREA = ["  sized (Function) at src/report.ts:7:17", "    8:30: return render(new Square(2).area());"];

describe("a call query against a TypeScript language server", () => {
	const temp = TempDir.createSync("@veyyon-lsp-calls-");
	const dir = temp.path();
	for (const [name, text] of Object.entries(FILES)) {
		fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
		fs.writeFileSync(path.join(dir, name), text);
	}
	const tool = new LspTool(makeToolSession({ cwd: dir }));

	beforeAll(() => {
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
			servers: { [SERVER_NAME]: SERVER },
			idleTimeoutMs: undefined,
			missingServers: [],
		});
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([[SERVER_NAME, SERVER]]);
	});

	afterAll(async () => {
		await lspClient.shutdownAll();
		vi.restoreAllMocks();
		temp.removeSync();
	});

	async function ask(action: LspParams["action"], file: string, line: number, symbol: string): Promise<string> {
		const result = await tool.execute(`lsp-${action}`, {
			action,
			file: path.join(dir, file),
			line,
			symbol,
			timeout: 60,
		});
		expect(result.details?.success).toBe(true);
		return result.content.map(block => (block.type === "text" ? block.text : "")).join("");
	}

	/** Every `file:line` whose text holds `name(`, which is what a text search for a call finds. */
	function textSearchFor(name: string): string[] {
		const hits: string[] = [];
		for (const [file, text] of Object.entries(FILES)) {
			text.split("\n").forEach((line, index) => {
				if (line.includes(`${name}(`)) hits.push(`${file}:${index + 1}`);
			});
		}
		return hits;
	}

	it("lists the callers of an overloaded function reached only through a renaming re-export", async () => {
		const answer = await ask("incoming_calls", "src/format.ts", 3, "format");

		expect(answer).toBe(
			[
				"Found 2 caller(s) of format (Function) at src/format.ts:3:17:",
				...DESCRIBE_CALLS_FORMAT,
				...SIZED_CALLS_FORMAT,
			].join("\n"),
		);
		// The search finds the three signatures and the comment, and neither call.
		expect(textSearchFor("format")).toEqual([
			"src/format.ts:1",
			"src/format.ts:2",
			"src/format.ts:3",
			"src/report.ts:6",
		]);
	}, 60_000);

	it("answers the same callers from an overload signature", async () => {
		const answer = await ask("incoming_calls", "src/format.ts", 1, "format");

		expect(answer).toBe(
			[
				"Found 2 caller(s) of format (Function) at src/format.ts:1:17:",
				...DESCRIBE_CALLS_FORMAT,
				...SIZED_CALLS_FORMAT,
			].join("\n"),
		);
	}, 60_000);

	it("lists the callers of an interface method and none of its declarations", async () => {
		const answer = await ask("incoming_calls", "src/shapes.ts", 2, "area");

		expect(answer).toBe(
			["Found 2 caller(s) of area (Method) at src/shapes.ts:2:2:", ...DESCRIBE_CALLS_AREA, ...SIZED_CALLS_AREA].join(
				"\n",
			),
		);
		// The search reads the interface member and both implementations as calls.
		expect(textSearchFor("area").filter(hit => hit.startsWith("src/shapes.ts"))).toEqual([
			"src/shapes.ts:2",
			"src/shapes.ts:6",
			"src/shapes.ts:12",
		]);
	}, 60_000);

	it("prepares each implementation of the interface method as its own item", async () => {
		const square = await ask("incoming_calls", "src/shapes.ts", 6, "area");
		expect(square).toBe(
			["Found 2 caller(s) of area (Method) at src/shapes.ts:6:2:", ...DESCRIBE_CALLS_AREA, ...SIZED_CALLS_AREA].join(
				"\n",
			),
		);

		const circle = await ask("incoming_calls", "src/shapes.ts", 12, "area");
		expect(circle).toStartWith("Found ");
		expect(circle.split("\n")[0]).toEndWith(" of area (Method) at src/shapes.ts:12:2:");
		expect(circle).toContain(DESCRIBE_CALLS_AREA.join("\n"));
	}, 60_000);

	it("names the function a re-exported alias reaches as the callee", async () => {
		const answer = await ask("outgoing_calls", "src/report.ts", 3, "describe");

		expect(answer).toBe(
			[
				"Found 2 callee(s) from describe (Function) at src/report.ts:3:17:",
				"  format (Function) at src/format.ts:1:17",
				"    4:9: return render(shape.area());",
				"  area (Method) at src/shapes.ts:2:2",
				"    4:16: return render(shape.area());",
			].join("\n"),
		);
	}, 60_000);
});
