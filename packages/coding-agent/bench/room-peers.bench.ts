/**
 * Room peers bench: what a room costs the conversation on every turn.
 *
 * Two production paths change when a room exists, and both run once per turn
 * in `#buildSessionStateMessage`:
 *
 *   1. `AgentRegistry.peers(id)` scans the process-wide registry, which holds
 *      every spawn of every conversation, for the drivers in `id`'s room.
 *   2. The `<session-state>` block is rendered with those peers and delivered
 *      when it differs from the last one delivered.
 *
 * Off arm: one driver in no room, the pre-rooms process. The block it renders
 * is the pre-rooms block to the byte, since the template's peer line is
 * conditional on `peers.length`; the guard below pins that. On arm: four
 * drivers in one room. Each arm runs over a registry carrying 400 spawns, the
 * population the scan walks either way.
 *
 * The registry scan is also measured against its previous shape, kept here
 * verbatim through the public API (`list().filter(isPeer).sort()`), so the
 * delta of the one-pass `peers()` is read on the same registry and the same
 * inputs. Exact parity: the two produce the same ids in the same order on
 * every call, and the bench fails otherwise.
 */

import { sessionPrompts } from "@veyyon/coding-agent/prompts/session/rows";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import { benchFail, makeBench } from "@veyyon/utils/bench-harness";
import * as prompt from "@veyyon/utils/prompt";

const SPAWNS = 400;
const ITERATIONS = 20_000;
const bench = makeBench(ITERATIONS);

// ─── Registry population ────────────────────────────────────────────────────

function populate(drivers: number, room: string | undefined): AgentRegistry {
	AgentRegistry.resetGlobalForTests();
	const registry = AgentRegistry.global();
	const driverIds: string[] = [];
	for (let d = 0; d < drivers; d++) {
		const id = d === 0 ? MAIN_AGENT_ID : `main:${d}`;
		driverIds.push(id);
		registry.register({
			id,
			displayName: "main",
			kind: "main",
			session: null,
			scope: `scope-${d}`,
			room,
			status: "running",
		});
	}
	for (let s = 0; s < SPAWNS; s++) {
		const parentId = driverIds[s % drivers] ?? MAIN_AGENT_ID;
		registry.register({
			id: `spawn-${s}`,
			displayName: `worker-${s}`,
			kind: "task",
			parentId,
			session: null,
			status: s % 3 === 0 ? "completed" : "running",
		});
	}
	return registry;
}

/** The scan as it was before the one-pass rewrite, through the public API. */
function peersBefore(registry: AgentRegistry, id: string): string[] {
	return registry
		.list()
		.filter(ref => ref.status !== "aborted" && registry.isPeer(id, ref.id))
		.sort((a, b) => a.createdAt - b.createdAt)
		.map(ref => ref.id);
}

// ─── Session-state block ────────────────────────────────────────────────────

const TEMPLATE = sessionPrompts["session/session-state"].text;
const DATE = "2026-01-01";
const CWD = "~/repo";

function renderBlock(peers: { id: string }[]): string {
	return prompt.render(TEMPLATE, { date: DATE, cwd: CWD, peers }).trim();
}

// ─── Run ────────────────────────────────────────────────────────────────────

console.log(`\nBenchmark: room-peers (${SPAWNS} spawns in the registry, ${ITERATIONS} iterations per arm)\n`);

for (const arm of [
	{ label: "off: 1 driver, no room ", drivers: 1, room: undefined },
	{ label: "on:  4 drivers, one room", drivers: 4, room: "room:bench" },
]) {
	const registry = populate(arm.drivers, arm.room);
	const expectedPeers = arm.drivers - 1;

	const before = peersBefore(registry, MAIN_AGENT_ID);
	const after = registry.peers(MAIN_AGENT_ID).map(ref => ref.id);
	if (before.length !== expectedPeers)
		benchFail(`${arm.label}: previous scan found ${before.length} peers, expected ${expectedPeers}`);
	if (before.join("\n") !== after.join("\n"))
		benchFail(`${arm.label}: one-pass peers() disagrees with the previous scan`);

	const scanBefore = bench(`${arm.label}  registry scan [BEFORE list+isPeer]`, () => {
		peersBefore(registry, MAIN_AGENT_ID);
	});
	const scanAfter = bench(`${arm.label}  registry scan [AFTER  one pass]   `, () => {
		registry.peers(MAIN_AGENT_ID);
	});

	const peers = registry.peers(MAIN_AGENT_ID).map(ref => ({ id: ref.id }));
	const block = renderBlock(peers);
	if (arm.drivers === 1) {
		// Pre-rooms parity: with no peers the block is the date and cwd lines alone.
		const baseline = renderBlock([]);
		if (block !== baseline || block.includes("Room peers"))
			benchFail("off arm: the block is not the pre-rooms block");
	} else if (!peers.every(peer => block.includes(`\`${peer.id}\``))) {
		benchFail("on arm: a peer is missing from the block");
	}
	const render = bench(`${arm.label}  session-state render          `, () => {
		renderBlock(peers);
	});

	console.log(
		`  ${arm.label}: block=${block.length} bytes, scan ${(scanBefore / ITERATIONS).toFixed(4)}ms -> ${(scanAfter / ITERATIONS).toFixed(4)}ms ` +
			`(${(((scanBefore - scanAfter) / scanBefore) * 100).toFixed(1)}% less), render ${(render / ITERATIONS).toFixed(4)}ms\n`,
	);
}
AgentRegistry.resetGlobalForTests();
