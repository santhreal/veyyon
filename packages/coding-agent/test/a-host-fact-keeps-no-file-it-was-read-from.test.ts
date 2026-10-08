/**
 * A host fact the system prompt shows keeps no file it was read from alive.
 *
 * THE DEFECT. The CPU model was a regex capture from `/proc/cpuinfo`, cached for the process life. A
 * JSC regex capture is a substring that references its parent, so 35 characters of model name kept
 * the whole file alive: 60 KB on a 32-thread host, in every process, for as long as it ran.
 *
 * THE CLASS. Any `<workstation>` fact cut out of a larger text (a file, a command's output) and cached
 * keeps that text alive. The suite builds a system prompt in a fresh process, reads every fact the
 * workstation block shows at run time, and measures each string cell in the heap that holds a fact:
 * a new fact is measured without a change here, and a fact the snapshot cannot show whole fails the
 * suite instead of passing unmeasured.
 *
 * WHAT IT DOES NOT CATCH. A fact held only as a rope (a concatenation not yet flattened) has no cell
 * whose value is the fact; a substring among the rope's parts that pins its parent is not seen. A fact
 * the host does not have (no `/proc/cpuinfo` model line, no `lspci`) is not read, so its source is not
 * exercised on that host.
 */
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { HostFact } from "./fixtures/prompt-build-pinned-strings";
import { hermeticSpawnEnv } from "./helpers/hermetic-spawn-env";

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, "fixtures", "prompt-build-pinned-strings.ts");
/** A fresh process loads the prompt builder and snapshots its own heap. */
const MEASURED_TIMEOUT_MS = 60_000;
/**
 * Bytes a fact's cell may hold beyond its own characters. A flat copy holds none; the smallest
 * `/proc/cpuinfo`, one core, is over 1 KB.
 */
const PINNED_LIMIT = 512;

function cpuinfoHasModelName(): boolean {
	try {
		return /^model name\s*:\s*\S/m.test(fs.readFileSync("/proc/cpuinfo", "utf8"));
	} catch {
		return false;
	}
}

async function measureHostFacts(): Promise<HostFact[]> {
	const { env, cleanup } = hermeticSpawnEnv();
	try {
		const { stdout, stderr } = await run(process.execPath, [FIXTURE], {
			env,
			timeout: MEASURED_TIMEOUT_MS - 5_000,
			killSignal: "SIGKILL",
		});
		expect(stderr).toBe("");
		return JSON.parse(stdout) as HostFact[];
	} finally {
		cleanup();
	}
}

describe("a host fact the system prompt shows", () => {
	it(
		"keeps no file it was read from alive",
		async () => {
			const facts = await measureHostFacts();
			const labels = facts.map(fact => fact.label);
			expect(labels).toContain("OS");
			expect(labels).toContain("Arch");
			expect(facts.filter(fact => !fact.measurable).map(fact => fact.label)).toEqual([]);
			// The measurement sees a cached fact, so a clean result is not a snapshot that matched nothing.
			expect(facts.filter(fact => fact.cells > 0).length).toBeGreaterThan(0);
			if (cpuinfoHasModelName()) {
				expect(facts.find(fact => fact.label === "CPU")?.cells ?? 0).toBeGreaterThan(0);
			}
			const pinning = facts
				.filter(fact => fact.pinned >= PINNED_LIMIT)
				.map(fact => ({ label: fact.label, pinned: fact.pinned }));
			expect(pinning).toEqual([]);
		},
		MEASURED_TIMEOUT_MS,
	);
});
