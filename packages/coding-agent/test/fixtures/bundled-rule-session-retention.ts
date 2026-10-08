/**
 * Loads the bundled rules and registers them on a new TTSR manager `SESSIONS` times, the way each
 * session's prompt inputs do, keeps every load referenced, and prints, as JSON, the heap and extra
 * memory each load left live and how many rules it registered.
 *
 * Five loads run before the measurement, so the measured loads pay for nothing a first load
 * compiles or caches for the process.
 */
import { heapStats } from "bun:jsc";
import { buildBuiltinRules } from "@veyyon/coding-agent/discovery/builtin-defaults";
import { bucketRules } from "@veyyon/coding-agent/discovery/capability/rule-buckets";
import { TtsrManager } from "@veyyon/coding-agent/export/ttsr";

export const SESSIONS = 200;

export interface BundledRuleRetention {
	/** Rules each load registered on its TTSR manager. */
	registered: number;
	/** Bytes each load left live. */
	perSession: number;
}

function live(): number {
	Bun.gc(true);
	const stats = heapStats();
	return stats.heapSize + stats.extraMemorySize;
}

const loads: unknown[] = [];
function load(): number {
	const manager = new TtsrManager();
	const rules = buildBuiltinRules();
	loads.push(manager, rules, bucketRules(rules, manager, {}));
	return manager.getRules().length;
}

for (let i = 0; i < 5; i++) load();
const before = live();
let registered = 0;
for (let i = 0; i < SESSIONS; i++) registered = load();
const after = live();

const result: BundledRuleRetention = { registered, perSession: (after - before) / SESSIONS };
process.stdout.write(JSON.stringify(result));
