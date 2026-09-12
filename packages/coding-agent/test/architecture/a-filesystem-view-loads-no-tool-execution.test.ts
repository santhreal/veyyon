/**
 * Filesystem cards must not evaluate tool implementations to read presentation helpers.
 * Enumerating the view/implementation pairs also covers newly added filesystem cards.
 * This checks static dependencies, not allocations or modules loaded on tool invocation.
 */
import { expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import * as path from "node:path";
import { createModuleReachCache, type ModuleReachResolution, moduleReach } from "@veyyon/utils/module-reach";

const src = path.resolve(import.meta.dirname, "../../src");
const directory = path.join(src, "tools/fs");
const files = readdirSync(directory);
const views = files.filter(file => file.endsWith("-view.ts")).sort();
const implementations = views.map(file => file.replace(/-view\.ts$/, ".ts"));
const resolution: ModuleReachResolution = {
	aliases: [["@veyyon/coding-agent/", `${src}/`]],
	packages: [["@veyyon/coding-agent", path.join(src, "index.ts")]],
};
const cache = createModuleReachCache();

it("checks every filesystem card against the corresponding execution modules", () => {
	expect(views).toEqual(["inspect-image-view.ts", "read-view.ts", "set-cwd-view.ts", "write-view.ts"]);
	expect(implementations.filter(file => !files.includes(file))).toEqual([]);
});

for (const view of views) {
	it(`${view} imports no filesystem execution module`, () => {
		const reached = moduleReach(path.join(directory, view), resolution, cache);
		expect(implementations.filter(file => reached.has(path.join(directory, file)))).toEqual([]);
	});
}
