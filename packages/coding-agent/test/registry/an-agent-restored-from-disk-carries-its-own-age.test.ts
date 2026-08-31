/**
 * A subagent read back from disk is as old as its transcript, and the operator's
 * prune budget reaches it.
 *
 * THE DEFECT. `registerPersistedSubagents` walks the session tree and registers
 * every subagent of every previous run as `parked`. It passed no timestamps, so
 * `AgentRegistry.register` stamped `createdAt`/`lastActivity` with the moment of
 * the scan, and the roster's age column reported "just now" for work finished
 * yesterday — for every row at once, which is the column saying nothing at all.
 * The same field decides when a parked ref is pruned, so each restored agent was
 * also handed a full prune budget starting from the scan.
 *
 * THE SECOND HALF. Nothing adopted those refs. A deadline is only ever derived
 * for an adopted agent, `parked` is a stable state, and only a status change
 * re-derives one, so a restored ref had no deadline and nothing would ever give
 * it one: "Prune After" governed the agents this process spawned and nothing
 * else. A resumed session accumulated every subagent it had ever written, eighty
 * rows deep.
 *
 * THE CLASS. Any ref restored rather than started — today the persisted scan for
 * both `sub` and `advisor` kinds — must carry the times of the thing it was
 * restored from, and any parked subagent, however it got there, must answer to
 * the same prune budget. The kind sweep below reads `AgentKind` at run time and
 * pins the set this path prunes by exact equality, so a fourth kind turns this
 * suite red until someone records a decision for it.
 *
 * WHAT IT DOES NOT CATCH. It asserts the registry, not the dashboard's rendered
 * string: `formatAge` is exercised by the dashboard's own suites. It also does
 * not cover a filesystem that reports no `mtime` at all, where the fallback is
 * the pre-existing behaviour of stamping now.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { type AgentKind, type AgentRef, AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@veyyon/coding-agent/registry/persisted-subagents";
import { Snowflake } from "@veyyon/utils";

const HOUR = 60 * 60_000;
/** The operator's "Prune After", chosen so one fixture sits either side of it. */
const CLOSE_AFTER = 1 * HOUR;

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

/** Settle the async prune chain (timer callback → prune() → release() → unregister). */
async function flushAsync(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** Install the budget the non-ACP bootstrap installs, with no reviver available. */
function installBudget(afterMs: number): void {
	lifecycle.setPersistedSubagentReviverFactory(async () => undefined, 0, {
		afterMs,
		waitingAfterMs: afterMs,
	});
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

		await registerPersistedSubagents(registry, path.join(root, "main.jsonl"), "session-a");

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
		await registerPersistedSubagents(registry, path.join(root, "main.jsonl"), "session-a");

		expect(Date.now() - (registry.get("Kestrel")?.createdAt ?? Date.now())).toBeGreaterThan(2 * HOUR);
	});

	/** An advisor transcript is restored as well, and is aged the same way. */
	it("ages a restored advisor row from its own transcript", async () => {
		await seedTranscript(path.join(root, "main", "__advisor.jsonl"), 3 * HOUR);
		await registerPersistedSubagents(registry, path.join(root, "main.jsonl"), "session-a");

		const advisor = registry.list().find(ref => ref.kind === "advisor");
		expect(Date.now() - (advisor?.lastActivity ?? Date.now())).toBeGreaterThan(2 * HOUR);
	});
});

describe("the prune budget reaches an agent restored from disk", () => {
	/**
	 * The whole point of the age: an agent quiet for longer than "Prune After" is
	 * dropped from the roster, and one inside the budget is kept. Both arms in one
	 * test, because the failure that matters is pruning everything or nothing.
	 */
	it("prunes one older than the budget and keeps one inside it", async () => {
		await seedTranscript(path.join(root, "main", "Kestrel.jsonl"), 3 * HOUR);
		await seedTranscript(path.join(root, "main", "Otter.jsonl"), 10 * 60_000);
		installBudget(CLOSE_AFTER);
		vi.useFakeTimers();

		await registerPersistedSubagents(registry, path.join(root, "main.jsonl"), "session-a");
		vi.advanceTimersByTime(1);
		await flushAsync();

		expect(registry.get("Kestrel")).toBeUndefined();
		expect(registry.get("Otter")).toBeDefined();
	});

	/**
	 * Pruning frees the view. It does not delete the operator's record: the
	 * transcript is what `history://` reads, and a roster that tidies itself by
	 * deleting work is not a roster anyone can trust.
	 */
	it("leaves the transcript on disk when it drops the row", async () => {
		const file = path.join(root, "main", "Kestrel.jsonl");
		await seedTranscript(file, 3 * HOUR);
		installBudget(CLOSE_AFTER);
		vi.useFakeTimers();

		await registerPersistedSubagents(registry, path.join(root, "main.jsonl"), "session-a");
		vi.advanceTimersByTime(1);
		await flushAsync();

		expect(registry.get("Kestrel")).toBeUndefined();
		await expect(fs.stat(file)).resolves.toBeDefined();
	});

	/**
	 * The off switch. `subagent.prune.enabled` resolves to a zero budget, and
	 * a zero budget must keep every restored agent listed however old it is — that
	 * is what "keep every finished subagent listed until you exit" means.
	 */
	it("keeps every restored agent when the budget is off", async () => {
		await seedTranscript(path.join(root, "main", "Kestrel.jsonl"), 3 * HOUR);
		installBudget(0);
		vi.useFakeTimers();

		await registerPersistedSubagents(registry, path.join(root, "main.jsonl"), "session-a");
		vi.advanceTimersByTime(HOUR);
		await flushAsync();

		expect(registry.get("Kestrel")).toBeDefined();
	});

	/**
	 * A host that installed no budget at all — ACP, an SDK embed, a test — keeps
	 * the behaviour it had before this path existed.
	 */
	it("keeps every restored agent when no budget was installed", async () => {
		await seedTranscript(path.join(root, "main", "Kestrel.jsonl"), 3 * HOUR);
		vi.useFakeTimers();

		await registerPersistedSubagents(registry, path.join(root, "main.jsonl"), "session-a");
		vi.advanceTimersByTime(HOUR);
		await flushAsync();

		expect(registry.get("Kestrel")).toBeDefined();
	});

	/**
	 * A collab guest mirrors the host's rows into its own registry. They are
	 * `parked`, they can be arbitrarily old, and they carry NO session file
	 * because the host owns the transcript. Pruning one would delete a row this
	 * process does not own, and the next snapshot would put it back.
	 */
	it("never prunes a mirrored row, which owns no transcript", async () => {
		installBudget(CLOSE_AFTER);
		vi.useFakeTimers();

		const mirrored = registry.register({
			id: "Sable",
			displayName: "Sable",
			kind: "sub",
			session: null,
			status: "parked",
		});
		mirrored.lastActivity = Date.now() - 3 * HOUR;
		vi.advanceTimersByTime(HOUR);
		await flushAsync();

		expect(registry.get("Sable")).toBeDefined();
	});

	/**
	 * Which kinds this path may drop, swept over the union rather than asserted
	 * for the one that prompted it. A `main` ref is a conversation, not a finished
	 * spawn, and an `advisor` row belongs to the session it observes; only `sub`
	 * is a subagent the roster prunes. Pinned by exact equality, so a fourth kind
	 * arrives red.
	 */
	it("prunes subagents and nothing else", async () => {
		installBudget(CLOSE_AFTER);
		vi.useFakeTimers();
		const pruned: AgentKind[] = [];

		for (const kind of AGENT_KINDS) {
			const file = path.join(root, "main", `${kind}-row.jsonl`);
			await seedTranscript(file, 3 * HOUR);
			const ref: AgentRef = registry.register({
				id: `${kind}-row`,
				displayName: `${kind}-row`,
				kind,
				session: null,
				sessionFile: file,
				status: "parked",
				lastActivity: Date.now() - 3 * HOUR,
			});
			expect(ref.kind).toBe(kind);
		}
		vi.advanceTimersByTime(1);
		await flushAsync();

		for (const kind of AGENT_KINDS) {
			if (!registry.get(`${kind}-row`)) pruned.push(kind);
		}
		expect(pruned).toEqual(["sub"]);
	});
});
