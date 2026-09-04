import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "../src/load.js";
import { ArgotParseError } from "../src/parse.js";

const roots: string[] = [];

/** Create a throwaway project root, optionally with an AGENTS.dict in it. */
async function projectWith(dict?: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "argot-load-"));
	roots.push(root);
	if (dict !== undefined) {
		await writeFile(join(root, "AGENTS.dict"), dict, "utf8");
	}
	return root;
}

afterAll(async () => {
	await Promise.all(roots.map(r => rm(r, { recursive: true, force: true })));
});

describe("load", () => {
	test("returns an inert codec when there is no AGENTS.dict", async () => {
		const dict = await load(await projectWith());
		expect(dict.promptFragment()).toBe("");
		expect(dict.expand("§dbconn stays")).toBe("§dbconn stays");
	});

	test("returns a live codec for a valid AGENTS.dict", async () => {
		const root = await projectWith(
			`version = 1
[handles]
dbconn = "packages/server/src/database/connection.ts"
`,
		);
		const dict = await load(root);
		expect(dict.expand("open §dbconn")).toBe("open packages/server/src/database/connection.ts");
		expect(dict.promptFragment()).toContain("§dbconn");
	});

	test("throws on a malformed AGENTS.dict rather than degrading to empty", async () => {
		const root = await projectWith(`version = 1\n[handles]\n`);
		// Degrading to empty would look identical to "no dict here", so the error
		// has to name the file and say what is wrong with it.
		const error = await load(root).then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(error).toBeInstanceOf(ArgotParseError);
		expect((error as ArgotParseError).source).toBe(join(root, "AGENTS.dict"));
		expect((error as ArgotParseError).message).toEndWith("`[handles]` defines no handles");
	});

	test("throws when the dict path is a directory, not a silent fallback", async () => {
		const root = await projectWith();
		// Put a directory where the file should be: reading it fails with EISDIR,
		// which is not ENOENT, so load must surface it rather than swallow it.
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(root, "AGENTS.dict"));
		await expect(load(root)).rejects.toBeDefined();
		// And specifically not the inert codec: prove it threw, not returned empty.
		let threw = false;
		try {
			await load(root);
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});
});
