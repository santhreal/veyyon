/**
 * WHY: parsing a URL used to instantiate the network reader and its scraper dependencies
 * while rendering tool previews or constructing local filesystem/search tools.
 * Sweep both local tool directories and the complete renderer registry so a new local
 * tool or preview cannot restore that eager dependency. This checks static imports;
 * URL execution and response behavior are covered by the fetch and search URL suites.
 */
import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createModuleReachCache, type ModuleReachResolution, moduleReach } from "@veyyon/utils/module-reach";

const src = path.resolve(import.meta.dirname, "../../src");
const reader = path.join(src, "tools/web/fetch.ts");
const resolution: ModuleReachResolution = {
	aliases: [["@veyyon/coding-agent/", `${src}/`]],
	packages: [["@veyyon/coding-agent", path.join(src, "index.ts")]],
};

it("keeps URL execution outside every local tool and registered preview's static imports", () => {
	const cache = createModuleReachCache();
	const entries = [path.join(src, "tools/renderers.ts")];
	for (const domain of ["fs", "search"]) {
		const root = path.join(src, "tools", domain);
		for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(".ts")) entries.push(path.join(entry.parentPath, entry.name));
		}
	}
	const eagerReaders = entries
		.filter(entry => moduleReach(entry, resolution, cache).has(reader))
		.map(entry => path.relative(src, entry))
		.sort();
	expect(eagerReaders).toEqual([]);
});
