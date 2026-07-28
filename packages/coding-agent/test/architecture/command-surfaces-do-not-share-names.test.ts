import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

/**
 * No exported name is declared in more than one of the three command trees.
 *
 * WHY THIS SUITE EXISTS. A user-facing verb can reach the code three ways:
 * `src/cli/` (argv, writes to stdout), `src/slash-commands/` (an in-session
 * `/verb`, writes through a port the TUI owns), and `src/commands/` (the
 * argv-parsing layer that routes into the first). Three trees for one vocabulary
 * is workable while each name says which tree it belongs to, and stops being
 * workable the moment two trees export the same one.
 *
 * `runProfileCommand` was that name. `cli/profile-cli.ts` took a parsed
 * `ProfileCommandArgs` and printed; `slash-commands/profile-command.ts` took a
 * `ProfileIntent` and a `ProfileCommandPort`. The signatures differ enough that
 * importing the wrong one cannot compile, which is the reason it survived: there
 * was no failure to notice. The cost is entirely on the reader.
 * `runProfileCommand(...)` at a call site says nothing about which surface is
 * being driven, `test/profile-command.test.ts` and `test/profile-lifecycle.test.ts`
 * each had a `runProfileCommand` in scope meaning a different function, and a
 * grep for the verb returned two implementations with no way to tell which one
 * `/profile` actually runs. They are `runProfileCliCommand` and
 * `runProfileSlashCommand` now.
 *
 * The rule is deliberately about NAMES, not about merging implementations. Two
 * surfaces for one verb is the right architecture: the CLI writes to a stream
 * and the slash command writes through a port, and collapsing them would put a
 * TUI concept in the CLI. What must not happen is two of them answering to one
 * word.
 */

const SRC = path.resolve(import.meta.dir, "..", "..", "src");
const TREES = ["cli", "commands", "slash-commands"] as const;

/** Every `export function|const|class|type|interface|enum <name>` in a tree. */
async function exportsByTree(): Promise<Map<string, Map<string, string>>> {
	const byName = new Map<string, Map<string, string>>();
	for (const tree of TREES) {
		const stack = [path.join(SRC, tree)];
		while (stack.length > 0) {
			const dir = stack.pop() as string;
			for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					stack.push(full);
					continue;
				}
				if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
				const text = await readFile(full, "utf8");
				const declarations = /^export (?:declare )?(?:async )?(?:function|const|class|type|interface|enum) (\w+)/gm;
				for (const match of text.matchAll(declarations)) {
					const name = match[1];
					if (!byName.has(name)) byName.set(name, new Map());
					byName.get(name)?.set(tree, path.relative(SRC, full));
				}
			}
		}
	}
	return byName;
}

const EXPORTS = await exportsByTree();

describe("the three command trees", () => {
	/**
	 * Guard on the guard.
	 *
	 * The rule asserts an empty clash list, which an empty export map satisfies.
	 * If the walk or the declaration pattern stopped matching, the rule would pass
	 * on a tree full of collisions. The floor and the two named exports are what
	 * make a pass mean something, and they are picked from two different trees so
	 * a walk that silently covered only one still fails here.
	 */
	it("reads the exports it claims to read", () => {
		expect(EXPORTS.size).toBeGreaterThan(100);
		expect(EXPORTS.has("runProfileCliCommand")).toBe(true);
		expect(EXPORTS.has("runProfileSlashCommand")).toBe(true);
	});

	/** And each of the renamed pair still lives in exactly one tree. */
	it("keeps each profile dispatcher in one tree", () => {
		expect([...(EXPORTS.get("runProfileCliCommand")?.keys() ?? [])]).toEqual(["cli"]);
		expect([...(EXPORTS.get("runProfileSlashCommand")?.keys() ?? [])]).toEqual(["slash-commands"]);
	});

	/**
	 * The rule. Reported with every clashing path so the failure says which two
	 * trees collided and on what, rather than only that something did.
	 *
	 * There is no allowlist, on purpose. The tree is at zero, and an allowlist
	 * seeded at zero is an invitation to add the first entry rather than pick a
	 * name that says which surface it serves. If a shared name is ever genuinely
	 * right, the honest form is one owner and a re-export, which this rule allows
	 * because a re-export is not a declaration.
	 */
	it("shares no exported name between cli/, commands/ and slash-commands/", () => {
		const clashes = [...EXPORTS]
			.filter(([, trees]) => trees.size > 1)
			.map(([name, trees]) => `${name}: ${[...trees.values()].sort().join(" and ")}`)
			.sort();
		expect(clashes).toEqual([]);
	});
});
