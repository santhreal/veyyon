/**
 * WHY: a kit suite's provenance hashed its source directory alone. The MiniWoB++ suite serves pages
 * from `datasets/miniwob/html`, outside that directory, so a run resumed after the pages were
 * relinked to another upstream checkout carried the same provenance hash, passed the plan-identity
 * check, and mixed trials of two page versions in one run. A suite's `datasetDir` now joins the
 * hash; an absent one hashes as absent instead of failing the plan, which the preflight refuses.
 *
 * The hash also took each file's relative path as the host listed it, so a tree listed on Windows
 * (`apps\shop\site.ts`, and sorted by `\`) hashed differently from the same tree on Linux, and one
 * run's resume on the other host was refused as another plan. Paths are hashed with `/`, in that
 * order. The test lists a Windows-style name on Linux as a file whose name holds a backslash.
 *
 * Not caught: a suite that reads files outside both directories without declaring them.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@veyyon/utils";
import { kitTask } from "../../engine/kit/catalog";
import { defineSuite } from "../../engine/kit/suite";
import miniwobSuite, { miniwobRoot } from "../../suites/miniwob/main";

const task = kitTask<null>({
	id: "noop",
	title: "noop",
	capabilities: ["pages"],
	difficulty: "easy",
	start: async () => ({ instruction: "noop", solve: async () => "", finish: async () => null }),
	checks: [{ id: "never", description: "never", pass: () => false }],
});

describe("a kit suite's provenance", () => {
	it("changes with the pages it serves, and names a missing page directory without failing", async () => {
		await using source = await TempDir.create("@evals-kit-source-");
		await using pages = await TempDir.create("@evals-kit-pages-");
		await fs.writeFile(source.join("main.ts"), "export {};\n");
		await fs.mkdir(pages.join("miniwob"));
		await fs.writeFile(pages.join("miniwob", "enter-text.html"), "<body>v1</body>");
		const suite = defineSuite({
			id: "pages",
			version: "1.0.0",
			displayName: "Pages",
			description: "serves pages",
			sourceDir: source.path(),
			datasetDir: pages.path(),
			capabilities: { pages: "pages" },
			tasks: [task],
			tools: [],
			defaultTimeBudgetSec: 30,
		});
		const first = (await suite.provenance({})).sha;
		expect((await suite.provenance({})).sha).toBe(first);

		await fs.writeFile(pages.join("miniwob", "enter-text.html"), "<body>v2</body>");
		const changed = (await suite.provenance({})).sha;
		expect(changed).not.toBe(first);

		await fs.rm(pages.path(), { recursive: true, force: true });
		const absent = (await suite.provenance({})).sha;
		expect([absent === first, absent === changed]).toEqual([false, false]);
	});

	it("is the same for one tree whichever separator its listing uses", async () => {
		const shaOf = async (dir: string) =>
			(
				await defineSuite({
					id: "tree",
					version: "1.0.0",
					displayName: "Tree",
					description: "a tree",
					sourceDir: dir,
					capabilities: { pages: "pages" },
					tasks: [task],
					tools: [],
					defaultTimeBudgetSec: 30,
				}).provenance({})
			).sha;
		await using linux = await TempDir.create("@evals-kit-tree-");
		await using windows = await TempDir.create("@evals-kit-tree-");
		// `sub0.ts` sorts after `sub/a.ts` and before `sub\a.ts`, so the order is part of what is compared.
		for (const root of [linux, windows]) {
			await fs.mkdir(root.join("sub"));
			await fs.writeFile(root.join("sub0.ts"), "export const zero = 0;\n");
		}
		await fs.writeFile(linux.join("sub", "a.ts"), "export const a = 1;\n");
		// On Linux a file named `sub\a.ts`, which is what a Windows listing returns for `sub/a.ts`.
		await fs.writeFile(`${windows.join("sub")}\\a.ts`, "export const a = 1;\n");
		expect(await shaOf(windows.path())).toBe(await shaOf(linux.path()));
	});

	it("of the MiniWoB++ suite covers the MiniWoB++ pages", () => {
		// The pages are that suite's task code: a page's own script scores the trial.
		expect(miniwobSuite.spec.datasetDir).toBe(miniwobRoot());
	});
});
