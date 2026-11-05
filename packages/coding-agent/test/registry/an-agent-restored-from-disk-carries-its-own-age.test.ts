/**
 * An agent read back from disk is as old as its transcript, it is never dropped,
 * and its age decides where the roster's fold puts it.
 *
 * THE DEFECT. `registerPersistedAgents` walks the session tree and registers
 * every agent of every previous run as `asleep`. It passed no timestamps, so
 * `AgentRegistry.register` stamped `createdAt`/`lastActivity` with the moment of
 * the scan, and the roster's age column reported "just now" for work finished
 * yesterday — for every row at once, which is the column saying nothing at all.
 * The same field decides which asleep rows a roster names and which it folds
 * into "+ N older asleep agents", so every restored agent also competed with the
 * agents this process spawned as if it had just finished.
 *
 * THE CLASS. Any ref restored rather than started — today the persisted scan for
 * both `sub` and `advisor` kinds — must carry the times of the thing it was
 * restored from, and no restored row of any kind is ever dropped: an agent with a
 * transcript wakes for the rest of the session. The kind sweep below reads every
 * `AgentKind`, so a new kind is held to the same rule.
 *
 * WHAT IT DOES NOT CATCH. It asserts the registry, not the dashboard's rendered
 * string: `formatAge` is exercised by the dashboard's own suites. It also does
 * not cover a filesystem that reports no `mtime` at all, where the fallback is
 * the pre-existing behaviour of stamping now. The fold case cannot pin the
 * defect in every scan order, because `readdir` order is the filesystem's; the
 * direct age assertions above it can.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import {
	type AgentKind,
	type AgentRef,
	AgentRegistry,
	foldOlderAsleep,
	ROSTER_ASLEEP_LIMIT,
} from "@veyyon/coding-agent/registry/agent-registry";
import { registerPersistedAgents } from "@veyyon/coding-agent/registry/persisted-agents";
import { Snowflake } from "@veyyon/utils";
import { drainMicrotasks } from "../../../utils/test/helpers/drain-microtasks";

const HOUR = 60 * 60_000;
/** The idle timer a restored agent gets when woken, far shorter than any fixture's age. */
const SLEEP_AFTER = 5 * 60_000;

/** Every kind the registry knows, read from the union's own inhabitants. */
const AGENT_KINDS: readonly AgentKind[] = ["main", "sub", "advisor"];

let root: string;
let registry: AgentRegistry;
let lifecycle: AgentLifecycleManager;

/** Write a transcript and backdate it, so the scan reads a real history. */
async function seedTranscript(file: string, ageMs: number): Promise<number> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, "");
	const at = new Date(Date.now() - ageMs);
	await fs.utimes(file, at, at);
	return at.getTime();
}

/** Settle any timer callback chain the lifecycle could have started. */
async function flushAsync(): Promise<void> {
	await drainMicrotasks(8);
}

/** Install what the non-ACP bootstrap installs, with no reviver available. */
function installPersistedReviver(): void {
	lifecycle.setPersistedAgentReviverFactory(async () => undefined, SLEEP_AFTER);
}

beforeEach(async () => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registry = AgentRegistry.global();
	lifecycle = AgentLifecycleManager.global();
	root = await fs.mkdtemp(path.join(os.tmpdir(), `restored-age-${Snowflake.next()}-`));
	await fs.writeFile(path.join(root, "main.jsonl"), "");
});

afterEach(async () => {
	vi.useRealTimers();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	await fs.rm(root, { recursive: true, force: true });
});

describe("an agent restored from disk carries the age of its transcript", () => {
	/**
	 * The reported defect, replayed: one transcript last written three hours ago,
	 * one written ten minutes ago, both scanned in the same pass. Their ages must
	 * differ by the same interval their files do. Asserted as an ORDERING and a
	 * span rather than an exact stamp, because a filesystem may hold `mtime` at a
	 * coarser resolution than a millisecond.
	 */
	it("reads each row's age from its own file, not from the scan", async () => {
		const oldAt = await seedTranscript(path.join(root, "main", "Kestrel.jsonl"), 3 * HOUR);
		const freshAt = await seedTranscript(path.join(root, "main", "Otter.jsonl"), 10 * 60_000);
		const scanAt = Date.now();

		await registerPersistedAgents(registry, path.join(root, "main.jsonl"), "session-a");

		const kestrel = registry.get("Kestrel");
		const otter = registry.get("Otter");
		expect(kestrel?.lastActivity).toBeCloseTo(oldAt, -3);
		expect(otter?.lastActivity).toBeCloseTo(freshAt, -3);
		// The defect made both of these zero: every row stamped with the scan.
		expect(scanAt - (kestrel?.lastActivity ?? scanAt)).toBeGreaterThan(2 * HOUR);
		expect(scanAt - (otter?.lastActivity ?? scanAt)).toBeLessThan(HOUR);
	});

	/** `createdAt` orders the roster, so it is restored for the same reason. */
	it("restores the creation stamp too, so the roster orders by real history", async () => {
		await seedTranscript(path.join(root, "main", "Kestrel.jsonl"), 3 * HOUR);
		await registerPersistedAgents(registry, path.join(root, "main.jsonl"), "session-a");

		expect(Date.now() - (registry.get("Kestrel")?.createdAt ?? Date.now())).toBeGreaterThan(2 * HOUR);
	});

	/** An advisor transcript is restored as well, and is aged the same way. */
	it("ages a restored advisor row from its own transcript", async () => {
		await seedTranscript(path.join(root, "main", "__advisor.jsonl"), 3 * HOUR);
		await registerPersistedAgents(registry, path.join(root, "main.jsonl"), "session-a");

		const advisor = registry.list().find(ref => ref.kind === "advisor");
		expect(Date.now() - (advisor?.lastActivity ?? Date.now())).toBeGreaterThan(2 * HOUR);
	});
});

describe("an agent restored from disk is never dropped", () => {
	/**
	 * However old, a restored agent stays registered, so it wakes by name, and
	 * its transcript stays on disk, so `history://` can read it.
	 */
	it("keeps a restored agent of any age, and its transcript", async () => {
		const file = path.join(root, "main", "Kestrel.jsonl");
		await seedTranscript(file, 30 * 24 * HOUR);
		installPersistedReviver();
		vi.useFakeTimers();

		await registerPersistedAgents(registry, path.join(root, "main.jsonl"), "session-a");
		vi.advanceTimersByTime(24 * HOUR);
		await flushAsync();

		expect(registry.get("Kestrel")?.status).toBe("asleep");
		await expect(fs.stat(file)).resolves.toBeDefined();
	});

	/**
	 * Swept over every kind, including the ones the scan never restores: no
	 * timer, however long, removes an asleep row with a transcript.
	 */
	it("drops no asleep row of any kind as time passes", async () => {
		installPersistedReviver();
		vi.useFakeTimers();

		for (const kind of AGENT_KINDS) {
			const file = path.join(root, "main", `${kind}-row.jsonl`);
			await seedTranscript(file, 3 * HOUR);
			const ref: AgentRef = registry.register({
				id: `${kind}-row`,
				displayName: `${kind}-row`,
				kind,
				session: null,
				sessionFile: file,
				status: "asleep",
				lastActivity: Date.now() - 3 * HOUR,
			});
			expect(ref.kind).toBe(kind);
		}
		vi.advanceTimersByTime(24 * HOUR);
		await flushAsync();

		const kept = AGENT_KINDS.filter(kind => registry.get(`${kind}-row`) !== undefined);
		expect(kept).toEqual([...AGENT_KINDS]);
	});
});

describe("the roster fold reads a restored agent's own age", () => {
	/**
	 * Two more restored agents than a roster names, with the two OLDEST in the
	 * middle of the alphabet, so neither the first nor the last ten by name is
	 * the right answer. The fold must name the ten most recently written and
	 * count the other two.
	 */
	it("names the most recently active restored agents and counts the rest", async () => {
		const names = "ABCDEFGHIJKL".split("").map(letter => `Agent${letter}`);
		expect(names).toHaveLength(ROSTER_ASLEEP_LIMIT + 2);
		const oldest = new Set(["AgentF", "AgentG"]);
		for (const [index, name] of names.entries()) {
			const ageMs = oldest.has(name) ? 48 * HOUR + index * 60_000 : HOUR + index * 60_000;
			await seedTranscript(path.join(root, "main", `${name}.jsonl`), ageMs);
		}

		await registerPersistedAgents(registry, path.join(root, "main.jsonl"), "session-a");
		const folded = foldOlderAsleep(registry.list().filter(ref => ref.kind === "sub"));

		expect(folded.olderAsleep).toBe(2);
		expect(folded.rows.map(ref => ref.id).sort()).toEqual(names.filter(name => !oldest.has(name)));
	});
});
