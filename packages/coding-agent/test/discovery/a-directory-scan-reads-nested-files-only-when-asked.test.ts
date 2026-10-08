/**
 * WHY: `loadFilesFromDir` documents `recursive` as off by default and builds a `*.<ext>` pattern
 * for it, but the native glob matches a simple pattern at every depth unless `recursive: false`
 * reaches it. Every non-recursive scan therefore read nested files: a tool's own helper module
 * under `tools/<name>/` became a tool, `rules/archive/old.md` became an active rule and
 * `commands/drafts/x.md` a slash command. Every discovery provider scans through this one
 * function, so the depth contract is asserted here, for each pattern shape it builds.
 *
 * Not caught: a provider that bypasses `loadFilesFromDir` and globs on its own.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache } from "@veyyon/coding-agent/discovery/capability/fs";
import { loadFilesFromDir } from "@veyyon/coding-agent/discovery/helpers";
import { removeSyncWithRetries } from "@veyyon/utils";

let dir: string;

function writeFile(relative: string): void {
	const filePath = path.join(dir, relative);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, relative);
}

beforeEach(() => {
	clearCache();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-depth-"));
	writeFile("top.md");
	writeFile("top.sh");
	writeFile("nested/inner.md");
	writeFile("nested/deeper/leaf.md");
});

afterEach(() => {
	clearCache();
	removeSyncWithRetries(dir);
});

async function scan(options: { extensions?: string[]; recursive?: boolean }): Promise<string[]> {
	const result = await loadFilesFromDir<string>(dir, "test-provider", "user", {
		...options,
		transform: (_name, _content, filePath) => path.relative(dir, filePath),
	});
	return result.items.sort();
}

interface ScanCase {
	shape: string;
	extensions: string[] | undefined;
	files: string[];
}

test.each<ScanCase>([
	{ shape: "one extension", extensions: ["md"], files: ["top.md"] },
	{ shape: "an extension set", extensions: ["md", "sh"], files: ["top.md", "top.sh"] },
	{ shape: "no extension filter", extensions: undefined, files: ["top.md", "top.sh"] },
])("a scan with $shape reads only the directory's own files by default", async ({ extensions, files }) => {
	expect(await scan({ extensions })).toEqual(files);
	expect(await scan({ extensions, recursive: false })).toEqual(files);
});

test.each<ScanCase>([
	{
		shape: "one extension",
		extensions: ["md"],
		files: ["nested/deeper/leaf.md", "nested/inner.md", "top.md"],
	},
	{
		shape: "no extension filter",
		extensions: undefined,
		files: ["nested/deeper/leaf.md", "nested/inner.md", "top.md", "top.sh"],
	},
])("a recursive scan with $shape reads every depth", async ({ extensions, files }) => {
	expect(await scan({ extensions, recursive: true })).toEqual(files);
});
