import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { BUILTIN_TOOL_NAMES } from "@veyyon/coding-agent/tools/builtin-names";
import { ResolveTool } from "@veyyon/coding-agent/tools/resolve";

// Every shipped built-in tool that is exposed to the model in normal sessions
// must have a docs/tools/<name>.md root doc served by `veyyon://`. File names use
// underscores or hyphens; the test accepts either form so renaming the on-disk
// page does not require coordinating with the wire name.
const docsToolsDir = path.resolve(import.meta.dir, "../../../../docs/tools");

const expectedDocPaths = (name: string): string[] => [
	path.join(docsToolsDir, `${name}.md`),
	path.join(docsToolsDir, `${name.replace(/_/g, "-")}.md`),
];

// Custom tools injected by the SDK (`packages/coding-agent/src/sdk.ts`) when
// their settings are enabled. Built-in tool factories live in BUILTIN_TOOLS but
// these custom tools are not present there, so the coverage list is explicit.
const CUSTOM_TOOL_NAMES = ["generate_image", "tts"] as const;

// Tools that ship and are documented but are `hidden`, so they never appear in
// BUILTIN_TOOL_NAMES. `resolve` is one: the model reaches it through the
// tool-choice queue rather than the normal tool list, and it still earns a page
// because a reader debugging a pending apply/discard needs the contract. Being
// absent from the coverage list is not the same as being dead, which is the
// distinction the orphan check below would otherwise miss.
const HIDDEN_DOCUMENTED_TOOL_NAMES = ["resolve"] as const;

describe("veyyon:// root docs coverage", () => {
	it.each([...BUILTIN_TOOL_NAMES])("documents builtin tool %s", name => {
		const candidates = expectedDocPaths(name);
		const present = candidates.find(candidate => fs.existsSync(candidate));
		expect(
			present,
			`Missing docs/tools/<name>.md for built-in tool "${name}". Tried: ${candidates.join(", ")}.`,
		).toBeDefined();
	});

	it.each([...CUSTOM_TOOL_NAMES])("documents injected custom tool %s", name => {
		const candidates = expectedDocPaths(name);
		const present = candidates.find(candidate => fs.existsSync(candidate));
		expect(present, `Missing docs/tools/<name>.md for injected custom tool "${name}".`).toBeDefined();
	});

	it("every hidden tool on the exemption list really is a shipped hidden tool", () => {
		// What keeps the exemption below from becoming a dumping ground. An entry
		// only stays valid while the class it names still ships AND is still hidden;
		// un-hide it and this fails, telling you to move it into the coverage list
		// proper rather than leaving it exempt forever.
		const resolve = new ResolveTool({} as never);

		expect(resolve.name).toBe("resolve");
		expect(resolve.hidden).toBe(true);
		expect([...HIDDEN_DOCUMENTED_TOOL_NAMES]).toEqual(["resolve"]);
	});

	/**
	 * The other direction, which the checks above cannot see.
	 *
	 * They ask "does every tool have a page". Nothing asked "does every page have
	 * a tool", so a page could outlive the tool it documents and keep being served
	 * by `veyyon://` — docs that describe something the build no longer has are
	 * worse than no docs, because the reader has no way to tell.
	 *
	 * This is not hypothetical. `argot_load` and `argot_unload` were renamed from
	 * `lexpack_*`, and their pages stayed at the old filenames: the tools read as
	 * undocumented while two orphaned pages sat in the directory. The missing-page
	 * check caught one half of that; this catches the other.
	 */
	it("serves no docs/tools page for a tool that does not ship", () => {
		const shipped = new Set<string>();
		for (const name of [...BUILTIN_TOOL_NAMES, ...CUSTOM_TOOL_NAMES, ...HIDDEN_DOCUMENTED_TOOL_NAMES]) {
			shipped.add(`${name}.md`);
			shipped.add(`${name.replace(/_/g, "-")}.md`);
		}

		// `README.md` is the directory's own index, not a tool page, so it is named here
		// rather than left to match a tool by accident. Asserted to exist so the exemption
		// cannot outlive the file it exempts.
		const indexPage = "README.md";
		expect(fs.existsSync(path.join(docsToolsDir, indexPage))).toBe(true);

		const orphaned = fs
			.readdirSync(docsToolsDir)
			.filter(entry => entry.endsWith(".md") && entry !== indexPage)
			.filter(entry => !shipped.has(entry));

		expect(orphaned, `docs/tools pages with no matching shipped tool: ${orphaned.join(", ")}.`).toEqual([]);
	});
});
