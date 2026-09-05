/**
 * WHY: disposal and the optional Python command imported evaluator implementations
 * before any session requested them. Sweep the backend directories and check the
 * session/CLI entry graphs so an additional backend cannot silently become eager.
 * This is a static boundary check; execution and shutdown use behavioral suites.
 */
import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createModuleReachCache, type ModuleReachResolution, moduleReach } from "@veyyon/utils/module-reach";

const src = path.resolve(import.meta.dirname, "../../src");
const resolution: ModuleReachResolution = {
	aliases: [["@veyyon/coding-agent/", `${src}/`]],
	packages: [["@veyyon/coding-agent", path.join(src, "index.ts")]],
};

it("loads evaluator implementations only through execution dispatch", () => {
	const evalRoot = path.join(src, "eval");
	const backends = fs
		.readdirSync(evalRoot, { withFileTypes: true })
		.filter(entry => entry.isDirectory() && fs.existsSync(path.join(evalRoot, entry.name, "index.ts")));
	const implementations = backends.flatMap(backend => {
		const candidates = ["executor.ts", "context-manager.ts"]
			.map(file => path.join(evalRoot, backend.name, file))
			.filter(file => fs.existsSync(file));
		expect(candidates, `Record the execution boundary for backend ${backend.name}`).not.toEqual([]);
		return candidates;
	});
	const cache = createModuleReachCache();
	const eager: string[] = [];
	for (const entry of ["sdk.ts", "session/agent-session.ts", "main.ts", "tools/shell/eval.ts"]) {
		const reachable = moduleReach(path.join(src, entry), resolution, cache);
		for (const implementation of implementations) {
			if (reachable.has(implementation)) eager.push(`${entry} -> ${path.relative(src, implementation)}`);
		}
	}
	expect(eager).toEqual([]);
});
