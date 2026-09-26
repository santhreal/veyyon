/**
 * WHY: the prune and shake passes run after every assistant turn and at every
 * compaction, and each one walked the whole branch although it acts only on
 * the entries from the compaction boundary on. A session that had compacted
 * 390 times held a 238k-entry branch with an 880-entry live tail, and the two
 * per-turn prunes spent 420ms re-reading summarized history on every turn.
 *
 * The class: a boundary-aware maintenance pass whose cost grows with the
 * history a compaction already summarized away. Every exported function of the
 * prune and shake modules is swept at run time; each one either runs against a
 * branch whose summarized entries record every property read and must leave
 * that record empty while still acting on the tail, or is pinned by name as not
 * a boundary-aware pass. A new export fails until it is placed in one list.
 *
 * The one read across the boundary that stays legal is the call behind a live
 * tool result whose call precedes the boundary: its protection must hold, and
 * the map that resolves it must agree with a whole-branch walk for every live
 * result, duplicated call ids included.
 *
 * Not caught: cost that grows within the live tail, and whole-path readers that
 * are not maintenance passes (a context rebuild still walks the path for model
 * and thinking-level changes).
 */
import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	type CompactionEntry,
	KEEP_NOTHING_ENTRY_ID,
	type SessionEntry,
	type SessionMessageEntry,
} from "@veyyon/agent-core/compaction/entries";
import * as pruning from "@veyyon/agent-core/compaction/pruning";
import * as shake from "@veyyon/agent-core/compaction/shake";
import {
	collectToolCallsById,
	isSkillReadToolResult,
	type ProtectedToolMatcher,
} from "@veyyon/agent-core/compaction/tool-protection";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";

const T = 1_700_000_000_000;
const PROTECTED: ProtectedToolMatcher[] = ["skill", isSkillReadToolResult];

let nextId = 0;
const id = (prefix: string) => `${prefix}-${nextId++}`;

function entry(message: AgentMessage): SessionMessageEntry {
	return { type: "message", id: id("e"), parentId: null, timestamp: new Date(T).toISOString(), message };
}

function assistant(content: AssistantMessage["content"]): SessionMessageEntry {
	return entry({
		role: "assistant",
		content,
		timestamp: T,
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	});
}

function result(toolName: string, toolCallId: string, text: string, extra: Partial<ToolResultMessage> = {}) {
	return entry({
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: T,
		...extra,
	});
}

function pair(name: string, args: Record<string, unknown>, text: string, extra: Partial<ToolResultMessage> = {}) {
	const callId = id("call");
	return [assistant([{ type: "toolCall", id: callId, name, arguments: args }]), result(name, callId, text, extra)];
}

const words = (count: number, seed: string) => Array.from({ length: count }, (_, i) => `${seed}${i}`).join(" ");

/** One of every shape a prune or shake pass acts on. */
function candidates(): SessionEntry[] {
	const listing = words(400, "listing");
	return [
		assistant([{ type: "text", text: "Reading the module." }]),
		...pair("read", { path: "src/a.ts" }, words(600, "first")),
		...pair("read", { path: "src/a.ts" }, words(600, "second")),
		...pair("grep", { pattern: "zzz" }, `No matches. ${words(80, "none")}`, { useless: true }),
		...pair("bash", { command: "ls" }, listing),
		...pair("bash", { command: "ls" }, listing),
		assistant([
			{ type: "text", text: `Plan:\n\n\`\`\`ts\n${words(500, "fence")}\n\`\`\`\n\n${words(900, "prose")}` },
		]),
	];
}

function compaction(firstKeptEntryId: string): CompactionEntry {
	return {
		type: "compaction",
		id: id("compaction"),
		parentId: null,
		timestamp: new Date(T).toISOString(),
		summary: "Earlier work.",
		firstKeptEntryId,
		tokensBefore: 100_000,
	};
}

/** Records the id of every summarized entry a pass reads a property of. */
function watched(entries: SessionEntry[], reads: Set<string>): SessionEntry[] {
	return entries.map(
		target =>
			new Proxy(target, {
				get(object, key, receiver) {
					reads.add(object.id);
					return Reflect.get(object, key, receiver);
				},
			}),
	);
}

/**
 * History a compaction summarized away, then the live tail. `kept` places the
 * candidates before the compaction under an ordinary keep marker; `nothing`
 * places them after a compaction that kept nothing.
 */
function branch(marker: "kept" | "nothing", reads: Set<string>) {
	const history = watched([...candidates(), ...candidates()], reads);
	const live = candidates();
	if (marker === "kept") {
		const entries = [...history, ...live, compaction(live[0].id), assistant([{ type: "text", text: "Resumed." }])];
		return { entries, keepBoundaryId: live[0].id };
	}
	return { entries: [...history, compaction(KEEP_NOTHING_ENTRY_ID), ...live], keepBoundaryId: KEEP_NOTHING_ENTRY_ID };
}

type Pass = (entries: SessionEntry[], keepBoundaryId: string) => number;

const supersede =
	(now: number): Pass =>
	(entries, keepBoundaryId) =>
		pruning.pruneSupersededToolResults(entries, {
			supersedeKey: pruning.readToolSupersedeKey,
			pruneUseless: true,
			protectedTools: PROTECTED,
			keepBoundaryId,
			now,
		}).prunedCount;

/** Every boundary-aware pass, with the invocations that reach each of its walks. */
const PASSES: Record<string, Pass[]> = {
	// Warm reaches the suffix-token walk, idle reaches the flush.
	pruneSupersededToolResults: [supersede(T + 60_000), supersede(T + 10 * 60 * 60_000)],
	pruneToolOutputs: [
		(entries, keepBoundaryId) =>
			pruning.pruneToolOutputs(entries, {
				protectTokens: 0,
				minimumSavings: 0,
				protectedTools: PROTECTED,
				supersedeKey: pruning.readToolSupersedeKey,
				pruneUseless: true,
				keepBoundaryId,
				cacheWarmSuffixTokens: 1_000_000,
			}).prunedCount,
	],
	collectShakeRegions: [
		(entries, keepBoundaryId) =>
			shake.collectShakeRegions(entries, { ...shake.AGGRESSIVE_SHAKE_CONFIG, keepBoundaryId }).length,
	],
	collectRedundantToolResultRegions: [
		(entries, keepBoundaryId) =>
			shake.collectRedundantToolResultRegions(entries, { ...shake.AGGRESSIVE_SHAKE_CONFIG, keepBoundaryId }).length,
	],
	collectOversizedTextRegions: [
		(entries, keepBoundaryId) =>
			shake.collectOversizedTextRegions(entries, {
				excessTokens: 1_000_000,
				keepEdgeTokens: 20,
				minTextTokens: 200,
				protectedTools: PROTECTED,
				keepBoundaryId,
			}).length,
	],
};

/** Exported functions that take no compaction boundary. */
const NOT_BOUNDARY_PASSES = ["applyShakeRegion", "applyShakeRegions", "readToolSupersedeKey"];

describe("a maintenance pass reads only the live tail", () => {
	test("every exported function is a swept pass or pinned as not one", () => {
		const exported = Object.entries({ ...pruning, ...shake })
			.filter(([, value]) => typeof value === "function")
			.map(([name]) => name);
		expect(exported.filter(name => !(name in PASSES)).sort()).toEqual(NOT_BOUNDARY_PASSES);
		expect(Object.keys(PASSES).filter(name => !exported.includes(name))).toEqual([]);
	});

	for (const [name, invocations] of Object.entries(PASSES)) {
		for (const marker of ["kept", "nothing"] as const) {
			test(`${name} acts on the tail and reads nothing summarized (${marker} marker)`, () => {
				let acted = 0;
				for (const invoke of invocations) {
					const reads = new Set<string>();
					const { entries, keepBoundaryId } = branch(marker, reads);
					acted += invoke(entries, keepBoundaryId);
					expect([...reads]).toEqual([]);
				}
				expect(acted).toBeGreaterThan(0);
			});
		}
	}
});

describe("a live result answered across the boundary keeps its call", () => {
	function crossing() {
		const callId = id("call");
		const call = assistant([
			{ type: "toolCall", id: callId, name: "read", arguments: { path: "skill://demo/SKILL.md" } },
		]);
		const skill = result("read", callId, words(600, "skill"));
		const [plainCall, plain] = pair("read", { path: "src/b.ts" }, words(600, "plain"));
		const entries = [...candidates(), call, skill, plainCall, plain];
		return { entries, skill, plain, keepBoundaryId: skill.id };
	}

	test("the prune blanks the plain result and not the protected skill read", () => {
		const { entries, skill, plain, keepBoundaryId } = crossing();
		pruning.pruneToolOutputs(entries, {
			protectTokens: 0,
			minimumSavings: 0,
			protectedTools: PROTECTED,
			keepBoundaryId,
		});
		expect((plain.message as ToolResultMessage).prunedAt).toBeNumber();
		expect((skill.message as ToolResultMessage).prunedAt).toBeUndefined();
	});

	test("shake and truncation leave the protected skill read alone", () => {
		const { entries, plain, keepBoundaryId } = crossing();
		const shaken = shake.collectShakeRegions(entries, { ...shake.AGGRESSIVE_SHAKE_CONFIG, keepBoundaryId });
		expect(shaken.map(region => region.entry)).toEqual([plain]);
		const truncated = shake.collectOversizedTextRegions(entries, {
			excessTokens: 1_000_000,
			keepEdgeTokens: 20,
			minTextTokens: 200,
			protectedTools: PROTECTED,
			keepBoundaryId,
		});
		expect(truncated.map(region => region.entry)).toEqual([plain]);
	});

	test("the tail map resolves every live result to the call a whole-branch walk does", () => {
		// Seeded so a failure reproduces: call ids repeat across the boundary, a
		// result can precede its call, and some results answer no call at all.
		let state = 0x2545f491;
		const random = (bound: number) => {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			return (state >>> 0) % bound;
		};
		let compared = 0;
		let crossed = 0;
		for (let round = 0; round < 200; round++) {
			const ids = Array.from({ length: 6 }, (_, i) => `r${round}-c${i}`);
			const entries: SessionEntry[] = [];
			for (let i = 0; i < 40; i++) {
				const pick = ids[random(ids.length)];
				entries.push(
					random(2) === 0
						? assistant([{ type: "toolCall", id: pick, name: "read", arguments: { path: `f${i}` } }])
						: result("read", random(8) === 0 ? `${pick}-orphan` : pick, `r${i}`),
				);
			}
			const whole = collectToolCallsById(entries);
			for (let from = 0; from <= entries.length; from++) {
				const tail = collectToolCallsById(entries, from);
				const messages = entries.slice(from).map(e => (e as SessionMessageEntry).message);
				const tailCalls = new Set(
					messages
						.flatMap(m => (m.role === "assistant" ? m.content : []))
						.flatMap(b => (b.type === "toolCall" ? [b.id] : [])),
				);
				for (const message of messages) {
					if (message.role !== "toolResult") continue;
					expect(tail.get(message.toolCallId)).toBe(whole.get(message.toolCallId));
					compared++;
					if (!tailCalls.has(message.toolCallId) && whole.has(message.toolCallId)) crossed++;
				}
			}
		}
		expect(compared).toBeGreaterThan(10_000);
		expect(crossed).toBeGreaterThan(100);
	});
});
