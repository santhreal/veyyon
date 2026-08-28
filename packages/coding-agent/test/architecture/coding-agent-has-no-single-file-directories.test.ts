/**
 * WHY: `packages/coding-agent/src/` had grown 59 top-level directories, eleven of
 * which held a single module. A directory with one file in it is not a concern,
 * it is a file with extra punctuation: it costs an exports-map entry, a tsconfig
 * path, an import prefix everyone has to type, and it hides the concern the file
 * actually belongs to. Four groups of them were also the same concern split
 * apart -- memories/memory-backend/mnemopi/hindsight were all memory,
 * discovery/tool-discovery/capability were all discovery, tts/stt were both
 * speech, dap/debug were both debugging.
 *
 * Closes the class of: a new subsystem arriving as its own top-level directory
 * with one file in it, and a merged concern being split back apart.
 *
 * The rule is derived from the tree at run time, so a directory added tomorrow
 * is measured by the same rule as one added today. `__tests__` directories are
 * exempt: their layout mirrors the module they cover, not a concern of its own.
 * A directory whose single module sits beside non-TypeScript assets is also
 * exempt, because there the directory groups the assets (`prompts/tools/` is 50
 * markdown files and one table that names them).
 *
 * What it does NOT catch: a directory with two modules that should be one file,
 * and a merged concern whose files are in one directory but still do not talk to
 * each other.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDirectory, repoPath, repoRelative, subdirectories } from "./helpers/module-graph";

const SRC = repoPath("packages/coding-agent/src");

/**
 * Directory count measured after the consolidation. A ceiling rather than an
 * exact set: the point is that the count does not grow back, and a lane adding
 * a genuinely new concern should not have to edit this file to do it.
 */
const TOP_LEVEL_DIRECTORY_CEILING = 42;

/** Concerns that were merged, and the directories they were merged out of. */
const MERGED: ReadonlyArray<{ readonly into: string; readonly from: readonly string[] }> = [
	{ into: "memory", from: ["memories", "memory-backend", "mnemopi", "hindsight"] },
	{ into: "discovery", from: ["tool-discovery", "capability"] },
	{ into: "speech", from: ["tts", "stt"] },
	{ into: "debug", from: ["dap"] },
	{ into: "thinking", from: ["auto-thinking"] },
	{ into: "config", from: ["security", "personality"] },
	{ into: "cli", from: ["startup"] },
	{ into: "registry", from: ["harness"] },
	{ into: "session", from: ["vibe"] },
	{ into: "tools", from: ["lib"] },
	{ into: "task", from: ["irc"] },
	{ into: "utils", from: ["jsonrpc"] },
	{ into: "export", from: ["markit"] },
];

interface DirectoryShape {
	readonly relative: string;
	readonly modules: readonly string[];
	readonly assets: readonly string[];
	readonly subdirectories: readonly string[];
}

function walk(directory: string, out: DirectoryShape[]): void {
	const entries = fs.readdirSync(directory, { withFileTypes: true });
	const modules: string[] = [];
	const assets: string[] = [];
	const children: string[] = [];
	for (const entry of entries) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			children.push(entry.name);
			if (entry.name !== "__tests__") walk(full, out);
			continue;
		}
		if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) modules.push(entry.name);
		else assets.push(entry.name);
	}
	if (directory !== SRC) {
		out.push({ relative: repoRelative(directory), modules, assets, subdirectories: children });
	}
}

function shapes(): DirectoryShape[] {
	const out: DirectoryShape[] = [];
	walk(SRC, out);
	return out;
}

describe("coding-agent has no single-file directories", () => {
	test("reads a real source tree", () => {
		const all = shapes();
		// A rule derived from nothing measures nothing: prove the walk found the tree.
		expect(all.length).toBeGreaterThan(50);
		expect(all.some(shape => shape.relative.endsWith("/src/memory"))).toBe(true);
	});

	test("has no directory holding one module and nothing else", () => {
		const offenders = shapes()
			.filter(shape => shape.modules.length === 1 && shape.assets.length === 0)
			.filter(shape => shape.subdirectories.length === 0)
			.map(shape => `${shape.relative} (only ${shape.modules[0]})`);
		expect(offenders).toEqual([]);
	});

	test("keeps the top-level directory count at or below what the consolidation measured", () => {
		const top = subdirectories(SRC);
		expect(top.length).toBeLessThanOrEqual(TOP_LEVEL_DIRECTORY_CEILING);
	});

	test("has not split a merged concern back apart", () => {
		const resurrected: string[] = [];
		const missing: string[] = [];
		for (const group of MERGED) {
			if (!isDirectory(path.join(SRC, group.into))) missing.push(group.into);
			for (const old of group.from) {
				if (isDirectory(path.join(SRC, old))) resurrected.push(old);
			}
		}
		expect(missing).toEqual([]);
		expect(resurrected).toEqual([]);
	});
});
