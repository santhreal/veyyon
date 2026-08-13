/**
 * Discovery of every exported mnemopi function that answers with a location.
 *
 * Shared by the two suites that ask different questions of the same inventory:
 * `home-derived-roots-answer-to-one-lever.test.ts` (a resolver obeys
 * `MNEMOPI_HOME`) and
 * `a-mnemopi-test-process-writes-nothing-into-the-ambient-home.test.ts` (the
 * ambient environment a suite actually runs in already points them out of the
 * home). One owner, because two copies of a discovery rule is two inventories
 * that drift, and a resolver missing from one of them is exactly the gap both
 * suites exist to close.
 */
import * as config from "../../src/config";
import * as sanitizer from "../../src/core/content-sanitizer";
import * as costLog from "../../src/core/cost-log";
import * as plugins from "../../src/core/plugins";
import * as triples from "../../src/core/triples";

/**
 * The modules that own a home-derived path. Namespace imports rather than a name
 * list, so the inventory is whatever the module exports today.
 */
const MODULES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
	["config", config as unknown as Record<string, unknown>],
	["content-sanitizer", sanitizer as unknown as Record<string, unknown>],
	["cost-log", costLog as unknown as Record<string, unknown>],
	["plugins", plugins as unknown as Record<string, unknown>],
	["triples", triples as unknown as Record<string, unknown>],
];

/**
 * A resolver is an exported function whose name says it answers with a location.
 * The name shape is the discovery rule, so adding `blobArchiveDir()` puts it in
 * both sweeps without anyone remembering to list it.
 */
export function pathResolvers(): ReadonlyArray<readonly [string, (env: Record<string, string>) => unknown]> {
	const found: Array<readonly [string, (env: Record<string, string>) => unknown]> = [];
	for (const [moduleName, namespace] of MODULES) {
		for (const [exportName, value] of Object.entries(namespace)) {
			if (typeof value !== "function") continue;
			if (!/(Home|Root|Dir|Db|Path)$/.test(exportName)) continue;
			found.push([`${moduleName}.${exportName}`, value as (env: Record<string, string>) => unknown]);
		}
	}
	return found;
}
