// WHY: a locate query paid for every match line and its trailing context even
// when the answer was a path. The bash interceptor redirects `rg`, `grep`, `ag`
// and `ack` to this tool, so `rg -l` had no expression here at all: searching
// `buildSystemPrompt` under packages/coding-agent/src cost 3,492 tokens as
// match lines against 215 as a file list.
//
// The class this closes: a mode the shell route offered and the unified tool
// could not express, paid for in tokens on every locate. The suite pins the
// file set against the content mode so the projection cannot drop a file, pins
// the size relation the mode exists for, sweeps every search type from the
// schema so a new type must record whether it accepts the field, and pins the
// cap disclosure so a per-file cap is never presented as a total.
//
// What it does not catch: the engine still collects match lines and context
// before the projection discards them, so this is a token saving and not a
// search-time saving beyond the render.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getThemeByName } from "@veyyon/coding-agent/theme/theme";
import { SearchTool, type SearchToolDetails, searchSchema } from "@veyyon/coding-agent/tools/search";
import {
	MULTI_FILE_PER_FILE_MATCHES,
	type TextSearchDetails,
	textSearchRenderer,
} from "@veyyon/coding-agent/tools/text-search";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map(block => block.text)
		.join("\n");
}

/** `path: count` rows, excluding the header and any trailing notes. */
function pathRows(text: string): Array<{ path: string; count: number }> {
	return text
		.split("\n")
		.map(line => /^(\S+): (\d+)$/.exec(line))
		.filter((match): match is RegExpExecArray => match !== null)
		.map(match => ({ path: match[1]!, count: Number(match[2]) }));
}

function textDetailsOf(result: { details?: SearchToolDetails }): TextSearchDetails | undefined {
	const details = result.details;
	return details?.type === "text" ? details.result : undefined;
}

async function withWorkspace<T>(prefix: string, body: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	try {
		return await body(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

function toolFor(dir: string): SearchTool {
	return new SearchTool(
		makeToolSession({
			cwd: dir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(dir, "artifacts"),
			settings: Settings.isolated(),
		}),
	);
}

const NEEDLE = "loadWidget";

async function seedWorkspace(dir: string): Promise<void> {
	await fs.writeFile(path.join(dir, "one.ts"), `export function ${NEEDLE}() {\n\treturn 1;\n}\n`);
	await fs.writeFile(path.join(dir, "two.ts"), `import { ${NEEDLE} } from "./one";\nexport const w = ${NEEDLE}();\n`);
	await fs.mkdir(path.join(dir, "nested"));
	await fs.writeFile(path.join(dir, "nested", "three.ts"), `// ${NEEDLE} is used here\n`);
}

describe("a locate query can ask for paths instead of match lines", () => {
	it("lists every matching file with its count and no match lines", async () => {
		await withWorkspace("paths-only-", async dir => {
			await seedWorkspace(dir);
			const tool = toolFor(dir);

			const contentResult = await tool.execute("content", { type: "text", input: NEEDLE, path: dir });
			const lines = textOf(contentResult);
			const paths = textOf(await tool.execute("paths", { type: "text", input: NEEDLE, path: dir, paths: true }));
			const contentFiles = textDetailsOf(contentResult)?.fileMatches ?? [];

			const rows = pathRows(paths);
			expect(rows.map(row => row.path).sort()).toEqual(["nested/three.ts", "one.ts", "two.ts"]);
			expect(rows.find(row => row.path === "two.ts")?.count).toBe(2);
			expect(paths).toStartWith("3 files matched (4 matches):");
			// No match row, no context row, no file content.
			expect(paths).not.toContain("export function");
			expect(paths.split("\n").some(line => line.startsWith("*"))).toBe(false);
			// The projection drops no file and no count the content mode reported.
			expect(rows).toEqual(contentFiles);
			expect(paths.length).toBeLessThan(lines.length);
		});
	});

	it("costs a fraction of the match lines once a scope holds many files", async () => {
		await withWorkspace("paths-scale-", async dir => {
			for (let index = 0; index < 25; index++) {
				await fs.writeFile(
					path.join(dir, `mod-${index}.ts`),
					`export function ${NEEDLE}${index}() {\n\treturn ${NEEDLE};\n}\nconst also = ${NEEDLE};\n`,
				);
			}
			const tool = toolFor(dir);
			const lines = textOf(await tool.execute("content", { type: "text", input: NEEDLE, path: dir }));
			const paths = textOf(await tool.execute("paths", { type: "text", input: NEEDLE, path: dir, paths: true }));

			expect(pathRows(paths).length).toBeGreaterThanOrEqual(20);
			expect(paths.length * 4).toBeLessThan(lines.length);
		});
	});

	it("counts the rows it withheld in files, not in matches", async () => {
		await withWorkspace("paths-frame-", async dir => {
			for (let index = 0; index < 25; index++) {
				await fs.writeFile(path.join(dir, `mod-${index}.ts`), `const x = ${NEEDLE};\nconst y = ${NEEDLE};\n`);
			}
			const result = await toolFor(dir).execute("paths", {
				type: "text",
				input: NEEDLE,
				path: dir,
				paths: true,
			});
			const textResult = textDetailsOf(result);
			const theme = await getThemeByName("dark");
			expect(theme).toBeDefined();
			const frame = textSearchRenderer
				.renderResult(
					{ content: result.content, details: textResult },
					{ expanded: false, isPartial: false },
					theme!,
					{
						input: NEEDLE,
					},
				)
				.render(100);
			const plain = (Array.isArray(frame) ? frame : [frame]).join("\n").replaceAll(/\u001b\[[\d;]*m/g, "");

			expect(plain).toContain("more files");
			expect(plain).not.toContain("more matches");
		});
	});

	it("keeps the display frame and the model text identical", async () => {
		await withWorkspace("paths-display-", async dir => {
			await seedWorkspace(dir);
			const result = await toolFor(dir).execute("paths", {
				type: "text",
				input: NEEDLE,
				path: dir,
				paths: true,
			});
			expect(textDetailsOf(result)?.displayContent).toBe(textOf(result));
		});
	});

	it("reports absence as absence", async () => {
		await withWorkspace("paths-absent-", async dir => {
			await seedWorkspace(dir);
			const paths = textOf(
				await toolFor(dir).execute("paths", { type: "text", input: "nothingMatchesThis", path: dir, paths: true }),
			);
			expect(paths).not.toContain("0 files matched");
			expect(paths.toLowerCase()).toContain("no matches");
		});
	});

	it("states that a count at the per-file cap is a floor", async () => {
		await withWorkspace("paths-cap-", async dir => {
			const hot = `${`${NEEDLE}();\n`.repeat(MULTI_FILE_PER_FILE_MATCHES + 5)}`;
			await fs.writeFile(path.join(dir, "hot.ts"), hot);
			await fs.writeFile(path.join(dir, "cold.ts"), `${NEEDLE}();\n`);
			const paths = textOf(
				await toolFor(dir).execute("paths", { type: "text", input: NEEDLE, path: dir, paths: true }),
			);
			expect(pathRows(paths).find(row => row.path === "hot.ts")?.count).toBe(MULTI_FILE_PER_FILE_MATCHES);
			expect(paths).toContain("A count at the per-file cap is a floor, not a total.");
		});
	});

	it("accepts the field for text search and rejects it for every other type", async () => {
		const types = searchSchema.shape.type.options;
		expect(types.length).toBeGreaterThan(1);
		await withWorkspace("paths-types-", async dir => {
			await seedWorkspace(dir);
			const tool = toolFor(dir);
			const accepted: string[] = [];
			for (const type of types) {
				try {
					await tool.execute("type-sweep", { type, input: NEEDLE, paths: true });
					accepted.push(type);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					expect(message).toContain("does not accept: paths");
				}
			}
			expect(accepted).toEqual(["text"]);
		});
	});
});
