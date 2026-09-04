/**
 * WHY: `packages/coding-agent/src/modes/components/` held 94 modules in one flat
 * directory — every transcript block, every picker, every dialog, the account
 * card and the agent dashboard, side by side in an alphabetical list nobody can
 * read. A flat directory of that size has a specific failure mode: a new
 * component lands wherever the alphabet puts it, so the concern a file belongs
 * to stops being visible, and the next reader has to open a file to find out
 * what it draws.
 *
 * Closes the class of: a component arriving loose in `components/`, and a
 * concern group being emptied back out into the parent.
 *
 * The groups are read from the tree at run time and every module is required to
 * sit in one, so a component added tomorrow is measured by the rule that
 * measured the ones added today. `index.ts` is the package barrel and stays at
 * the root by definition — it is the file whose whole job is to name the others.
 *
 * What it does NOT catch: a module filed under the wrong group (a select-list
 * helper in `transcript/` still passes), and a group that has grown large enough
 * to want splitting again.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { basename } from "node:path";
import { isDirectory, repoPath, subdirectories } from "./helpers/module-graph";

const COMPONENTS = repoPath("packages/coding-agent/src/modes/terminal/components");

/**
 * The concern groups, and what each one owns. Pinned by exact equality: a new
 * group is a decision about how the surface is divided, not a place to put a
 * file that did not fit.
 */
const GROUPS: Readonly<Record<string, string>> = {
	account: "the /providers account card and its rows",
	chrome: "shared overlay chrome and the decorative marks",
	composer: "the input surface: editor, loader, shortcuts, history search",
	dashboard: "the Agent Control Center, the subagent HUD and the todo board",
	dialogs: "surfaces that ask a question or take over the screen",
	extensions: "extension-supplied component surfaces",
	selectors: "pickers and lists the operator chooses from",
	"status-line": "the footline and its segments",
	transcript: "message blocks and the transcript's own chrome",
};

/** The only `.ts` file that may sit directly in `components/`. */
const ROOT_MODULES = ["index.ts"];

/** Not a concern of its own: the layout mirrors the modules it covers. */
const TEST_DIRECTORY = "__tests__";

/** Direct `.ts` children of a directory — never its subtree. */
function directModules(directory: string): string[] {
	return fs
		.readdirSync(directory, { withFileTypes: true })
		.filter(entry => entry.isFile() && entry.name.endsWith(".ts"))
		.map(entry => entry.name)
		.sort();
}

function groupDirectories(): string[] {
	return subdirectories(COMPONENTS)
		.map(directory => basename(directory))
		.filter(name => name !== TEST_DIRECTORY)
		.sort();
}

describe("the component tree is grouped by concern", () => {
	test("every group in the tree is a declared concern, and every declared concern exists", () => {
		expect(groupDirectories()).toEqual(Object.keys(GROUPS).sort());
	});

	test("no component sits loose in the components root", () => {
		const loose = directModules(COMPONENTS).filter(name => !ROOT_MODULES.includes(name));
		expect(loose).toEqual([]);
	});

	test("every group holds at least two modules, so no group is a file with punctuation", () => {
		const thin: string[] = [];
		for (const group of groupDirectories()) {
			const modules = directModules(`${COMPONENTS}/${group}`).filter(name => !name.endsWith(".test.ts"));
			if (modules.length < 2) thin.push(`${group}: ${modules.length}`);
		}
		expect(thin).toEqual([]);
	});

	test("the assets a component reads sit beside the component that reads them", () => {
		// `tips.txt` is imported by `dialogs/welcome.ts` with an import attribute,
		// so the file has to be reachable on a relative path from that module: a
		// grouping that leaves the corpus behind in the parent breaks the import at
		// build time, not at read time.
		expect(fs.existsSync(`${COMPONENTS}/tips.txt`)).toBe(true);
		const welcome = fs.readFileSync(`${COMPONENTS}/dialogs/welcome.ts`, "utf-8");
		expect(welcome).toContain('from "../tips.txt"');
	});

	test("the group directories are directories, not files that happen to be named like one", () => {
		for (const group of Object.keys(GROUPS)) {
			expect(isDirectory(`${COMPONENTS}/${group}`)).toBe(true);
		}
	});
});
