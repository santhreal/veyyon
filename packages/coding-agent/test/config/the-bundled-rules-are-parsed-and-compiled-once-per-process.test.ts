/**
 * Every session loads the bundled rules from one parse per process and registers them on its TTSR
 * manager from one compiled set of patterns, and no value two loads share can be changed by either.
 *
 * WHY: each session's prompt inputs loaded the bundled rules by parsing all 31 markdown files, and
 * its TTSR manager compiled every condition, scope and glob again: 0.5 ms and 67 KiB per session,
 * held for the session's life, of which a spawned agent's whole session retained 277 KiB. The
 * markdown is parsed once, each load copies the rule and source objects the capability loader marks
 * per load, and the lists the copies share are frozen, which is what the TTSR manager keys its
 * compiled patterns on.
 *
 * THE CLASS THIS CLOSES. A load that parses again, a manager that compiles a bundled rule's patterns
 * again, and a value two loads share that one of them can mutate. Retention is measured per load in
 * a fresh process against the rules registered there, which this process derives at run time, so a
 * load that registers fewer rules cannot pass by holding less. The shared-value sweep walks two
 * loads in parallel and fails on any object both reach that is not frozen, so a field added to
 * `Rule` holding a list or an object is covered when it lands.
 *
 * NOT COVERED: rules read from rule files, which are parsed per session and compile per manager, and
 * the cost of the TTSR manager's per-session state.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { buildBuiltinRules } from "@veyyon/coding-agent/discovery/builtin-defaults";
import { bucketRules } from "@veyyon/coding-agent/discovery/capability/rule-buckets";
import { TtsrManager } from "@veyyon/coding-agent/export/ttsr";
import type { BundledRuleRetention } from "../fixtures/bundled-rule-session-retention";

const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "bundled-rule-session-retention.ts");

/**
 * Bytes a load may leave live: its rule and source copies, its manager's entries and its buckets.
 * Compiling the patterns per manager measured 33 KiB, parsing per load 94 KiB, sharing both 15 KiB.
 */
const PER_SESSION_BOUND = 22 * 1024;

/** Paths of objects `a` and `b` both reach at the same position that are not frozen. */
function sharedMutable(a: unknown, b: unknown, at: string, out: string[]): string[] {
	if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return out;
	if (a === b && !Object.isFrozen(a)) out.push(at);
	for (const key of Reflect.ownKeys(a)) {
		sharedMutable(
			(a as Record<PropertyKey, unknown>)[key],
			(b as Record<PropertyKey, unknown>)[key],
			`${at}.${String(key)}`,
			out,
		);
	}
	return out;
}

describe("the bundled rules", () => {
	it("share no value two loads can change", () => {
		const first = buildBuiltinRules();
		const second = buildBuiltinRules();
		expect(second.map(rule => rule.name)).toEqual(first.map(rule => rule.name));
		expect(sharedMutable(first, second, "rules", [])).toEqual([]);
	});

	it("leave each session only its own copies, not another parse or compile", () => {
		const manager = new TtsrManager();
		bucketRules(buildBuiltinRules(), manager, {});
		const run = spawnSync(process.execPath, [FIXTURE], { encoding: "utf8", timeout: 120_000 });
		if (run.status !== 0) throw new Error(`fixture failed (${run.status}): ${run.stderr}`);
		const retention = JSON.parse(run.stdout) as BundledRuleRetention;
		expect(retention.registered).toBe(manager.getRules().length);
		expect(retention.perSession).toBeLessThan(PER_SESSION_BOUND);
	});
});
