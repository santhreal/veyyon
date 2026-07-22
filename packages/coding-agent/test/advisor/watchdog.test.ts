import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	collectConfigCandidates,
	discoverWatchdogFiles,
	formatAdvisorContextPrompt,
} from "@veyyon/coding-agent/advisor/watchdog";
import { removeWithRetries } from "@veyyon/utils";

/**
 * The advisor/watchdog config discovery walks a search path (the user agent dir plus
 * every directory from cwd up to the repo root, probing both `<F>` and `.veyyon/<F>`)
 * and orders the hits user-first then project ancestor->leaf. None of it was tested.
 * The ordering and the hidden-directory filter are load-bearing: the advisor injects
 * these files into its system prompt as the user's standing instructions, so a wrong
 * order would let an ancestor's rule shadow a more specific leaf rule, and a broken
 * filter would either leak an unrelated dotfile directory's config or drop the
 * intended `.veyyon/` config.
 *
 * These build a real temp directory tree (isolated under the OS temp dir, so the
 * upward walk finds nothing above it) and pin:
 *  - user candidates sort before project candidates, and project candidates sort by
 *    depth descending so the leaf directory (depth 0) comes last / most specific;
 *  - within one directory the `.veyyon/<F>` copy precedes the bare `<F>` copy;
 *  - a config owned by a hidden directory (name starting with ".") is excluded, while
 *    `.veyyon/` is the one dotted exception that is kept;
 *  - discoverWatchdogFiles wraps each hit in an <attention> block in the same order;
 *  - formatAdvisorContextPrompt returns undefined for no files and renders a
 *    <project-context> block naming each file otherwise.
 */

async function withTree<T>(layout: Record<string, string>, run: (root: string) => Promise<T>): Promise<T> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-watchdog-"));
	try {
		for (const [rel, content] of Object.entries(layout)) {
			const abs = path.join(root, rel);
			await fs.mkdir(path.dirname(abs), { recursive: true });
			await fs.writeFile(abs, content);
		}
		return await run(root);
	} finally {
		await removeWithRetries(root);
	}
}

describe("collectConfigCandidates ordering", () => {
	it("sorts user first, then project ancestor->leaf, with .veyyon before the bare file", async () => {
		await withTree(
			{
				"WATCHDOG.md": "ROOT",
				"sub/WATCHDOG.md": "SUB",
				"sub/.veyyon/WATCHDOG.md": "VEYYON",
				"agent/WATCHDOG.md": "USER",
			},
			async root => {
				const items = await collectConfigCandidates(path.join(root, "sub"), path.join(root, "agent"), [
					"WATCHDOG.md",
				]);
				expect(items.map(i => [i.level, i.content])).toEqual([
					["user", "USER"],
					["project", "ROOT"],
					["project", "VEYYON"],
					["project", "SUB"],
				]);
				// The ancestor (ROOT) is one level up from cwd; the leaf hits are depth 0.
				const project = items.filter(i => i.level === "project");
				expect(project.map(i => i.depth)).toEqual([1, 0, 0]);
			},
		);
	});
});

describe("collectConfigCandidates hidden-directory filter", () => {
	it("excludes a config owned by a hidden directory but keeps .veyyon and plain files", async () => {
		await withTree(
			{
				".hidden/WATCHDOG.md": "HIDDEN",
				".veyyon/WATCHDOG.md": "VEYYON",
				"WATCHDOG.md": "PLAIN",
			},
			async root => {
				// Walk up starting inside the hidden directory: its own bare file is owned
				// by ".hidden" and dropped; the repo-level .veyyon and plain files survive.
				const items = await collectConfigCandidates(path.join(root, ".hidden"), undefined, ["WATCHDOG.md"]);
				expect(items.map(i => i.content)).toEqual(["VEYYON", "PLAIN"]);
				expect(items.map(i => i.content)).not.toContain("HIDDEN");
			},
		);
	});

	it("returns [] when no config files exist on the search path", async () => {
		await withTree({ "notes.txt": "unrelated" }, async root => {
			expect(await collectConfigCandidates(root, undefined, ["WATCHDOG.md"])).toEqual([]);
		});
	});
});

describe("discoverWatchdogFiles", () => {
	it("wraps each discovered file in an <attention> block in search-path order", async () => {
		await withTree(
			{
				"WATCHDOG.md": "ROOT",
				"sub/WATCHDOG.md": "SUB",
			},
			async root => {
				const blocks = await discoverWatchdogFiles(path.join(root, "sub"));
				expect(blocks).toEqual([
					"Especially pay attention to:\n<attention>\nROOT\n</attention>",
					"Especially pay attention to:\n<attention>\nSUB\n</attention>",
				]);
			},
		);
	});
});

describe("formatAdvisorContextPrompt", () => {
	it("returns undefined when there are no context files", () => {
		expect(formatAdvisorContextPrompt([])).toBeUndefined();
	});

	it("renders a project-context block that names each file and carries its content", () => {
		const rendered = formatAdvisorContextPrompt([{ path: "AGENTS.md", content: "be nice" }]);
		expect(rendered).toBeDefined();
		expect(rendered?.startsWith("<project-context>")).toBe(true);
		expect(rendered).toContain('<file path="AGENTS.md">\nbe nice\n</file>');
		expect(rendered?.endsWith("</project-context>")).toBe(true);
	});
});
