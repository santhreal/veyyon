/**
 * WHY. Automatic compaction is a chain of reducers, and until this suite existed
 * every one of them was eligibility-gated by the SHAPE of what was too large:
 * `collectShakeRegions` recognizes a whole tool result, a fenced block or a
 * top-level XML span, `dropImages` recognizes an image block. A session whose
 * tail is one message of megabyte-scale prose with no fence in it matches none
 * of them, so every tier reports "nothing eligible", the pass warns "the most
 * recent turn alone is too large to reduce further", and automatic maintenance
 * parks a session that can no longer send a request. There was no floor: the
 * only way out was for the operator to start over.
 *
 * `collectOversizedTextRegions` is that floor, and its eligibility asks one
 * question — how big is this text — so no shape can hide from it.
 *
 * THE CLASS THIS CLOSES. Not "prose with no fence". The class is a text that
 * some role holds and no reducer can reach, and the second half of it is that a
 * role need not hold its text in `content` at all: a bash or python cell holds
 * it in `output`, a branch or compaction summary in `summary`, a `@file` mention
 * in `files[i].content`, up to 50KB per mention. Five of the eleven roles a
 * session can hold store text outside `content`, so a reducer that reads only
 * `content` leaves five roles unreducible.
 *
 * FAIL BY DEFAULT. `OVERSIZED` is a `Record<AgentMessage["role"], …>`, the same
 * device `no-message-role-reaches-the-provider-uncounted.test.ts` uses: adding a
 * role through `CustomAgentMessages` fails the type check until a sample exists,
 * and the sweep then proves that role's text is reachable. A role that stores
 * text in a new field turns this suite red rather than quietly joining the
 * unreducible five.
 *
 * The suite lives in this package rather than beside the reducer it drives,
 * because `bashExecution`, `pythonExecution` and `fileMention` are merged into
 * `AgentMessage` from `session/messages.ts` here. From inside `packages/agent`
 * the union is the eight base roles, so the exhaustive `Record` would be
 * satisfied without ever naming the five roles this closes.
 *
 * WHAT IT DOES NOT CATCH. It does not prove the session-level recovery, which
 * `a-turn-too-large-to-summarize-is-truncated-not-parked.test.ts` drives through
 * the real `AgentSession`. It says nothing about whether the model can still use
 * a truncated text — only that the bytes left the context and the edges
 * survived. And a host that injects an untyped role at runtime is invisible to
 * the type-level gate.
 *
 * The no-grind test below proves the COLLECTOR honors its floor, with this
 * file's own margin. It does not pin `TRUNCATION_MIN_TEXT_TOKENS` against
 * `TRUNCATION_KEEP_EDGE_TOKENS` in `agent-session.ts`; a session-level version
 * was tried and deleted, because a second maintenance pass never reaches the
 * tier, so it stayed green with both production guards removed and could not
 * fail on the bug it named.
 */

import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { countTokens } from "@veyyon/agent-core";
import type {
	CustomMessageEntry,
	SessionEntry,
	SessionMessageEntry,
	TruncationConfig,
} from "@veyyon/agent-core/compaction";
import {
	applyShakeRegions,
	collectOversizedTextRegions,
	collectShakeRegions,
	DEFAULT_SHAKE_CONFIG,
} from "@veyyon/agent-core/compaction";

/**
 * Prose with no fence, no XML tag and no repeated line, so the shape-driven
 * reducers cannot see it and a dedup pass cannot match it against anything.
 */
function prose(approxTokens: number): string {
	const sample = "sentence 1000 describes an unremarkable observation about record 7000.";
	const count = Math.max(1, Math.ceil(approxTokens / countTokens(sample)));
	const sentences: string[] = [];
	for (let i = 0; i < count; i++) {
		sentences.push(`sentence ${i} describes an unremarkable observation about record ${i * 7}.`);
	}
	return sentences.join(" ");
}

const BIG = prose(4_000);

let idCounter = 0;
function messageEntry(message: AgentMessage): SessionMessageEntry {
	return { type: "message", id: `entry-${idCounter++}`, parentId: null, timestamp: new Date().toISOString(), message };
}

/**
 * One oversized message per role, each storing `BIG` where that role really
 * stores its model-visible text.
 */
const OVERSIZED: Record<AgentMessage["role"], AgentMessage> = {
	user: { role: "user", content: BIG, timestamp: 1 },
	developer: { role: "developer", content: BIG, timestamp: 1 },
	assistant: {
		role: "assistant",
		content: [{ type: "text", text: BIG }],
		api: "openai-completions",
		provider: "local",
		model: "qwen2.5-1.5b",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 1,
	} as AgentMessage,
	toolResult: {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: BIG }],
		isError: false,
		timestamp: 1,
	},
	custom: { role: "custom", customType: "note", content: BIG, display: true, timestamp: 1 },
	hookMessage: { role: "hookMessage", customType: "note", content: BIG, display: true, timestamp: 1 },
	branchSummary: { role: "branchSummary", summary: BIG, fromId: "entry-1", timestamp: 1 },
	compactionSummary: { role: "compactionSummary", summary: BIG, tokensBefore: 10_000, timestamp: 1 },
	bashExecution: {
		role: "bashExecution",
		command: "cat report.txt",
		output: BIG,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 1,
	},
	pythonExecution: {
		role: "pythonExecution",
		code: "print(report)",
		output: BIG,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 1,
	},
	fileMention: { role: "fileMention", files: [{ path: "report.txt", content: BIG }], timestamp: 1 },
};

const ROLES = Object.keys(OVERSIZED) as Array<AgentMessage["role"]>;

const KEEP_EDGE_TOKENS = 200;

function config(overrides: Partial<TruncationConfig> = {}): TruncationConfig {
	return {
		excessTokens: 1_000_000,
		keepEdgeTokens: KEEP_EDGE_TOKENS,
		minTextTokens: KEEP_EDGE_TOKENS * 2 + 100,
		protectedTools: DEFAULT_SHAKE_CONFIG.protectedTools,
		...overrides,
	};
}

/** Every text the branch still holds, whatever field it lives in. */
function liveTexts(entries: SessionEntry[]): string[] {
	const texts: string[] = [];
	const visit = (value: unknown): void => {
		if (typeof value === "string") {
			texts.push(value);
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (value !== null && typeof value === "object") {
			for (const key of ["content", "output", "summary", "text", "files"]) {
				if (key in value) visit((value as Record<string, unknown>)[key]);
			}
		}
	};
	for (const entry of entries) {
		if (entry.type === "message") visit(entry.message);
		else if (entry.type === "custom_message") visit((entry as CustomMessageEntry).content);
	}
	return texts;
}

describe("every oversized text can be truncated", () => {
	test("reduces a message of every role, wherever that role stores its text", () => {
		const unreachable = ROLES.filter(role => {
			const entry = messageEntry(structuredClone(OVERSIZED[role]));
			return collectOversizedTextRegions([entry], config()).length === 0;
		});
		// A role added to `CustomAgentMessages` that stores text in a field the
		// address union does not name lands here. Fix the walk, do not shrink this.
		expect(unreachable).toEqual([]);
	});

	test("removes the bulk and keeps both edges, for every role", () => {
		for (const role of ROLES) {
			const entry = messageEntry(structuredClone(OVERSIZED[role]));
			const regions = collectOversizedTextRegions([entry], config());
			expect(regions).toHaveLength(1);

			const region = regions[0];
			if (region.kind !== "block") throw new Error(`${role}: expected a block region`);
			expect(region.truncation).toBe(true);
			expect(region.originalText).toBe(BIG.slice(region.start, region.end));

			applyShakeRegions([{ region, replacement: "[cut]" }]);

			const after = liveTexts([entry]).find(text => text.includes("[cut]"));
			if (after === undefined) throw new Error(`${role}: the truncated text is not on the branch`);
			// The head and the tail of the original are both still readable, and
			// the middle is gone: this is a truncation, not a drop.
			expect(after.startsWith(BIG.slice(0, 40))).toBe(true);
			expect(after.endsWith(BIG.slice(-40))).toBe(true);
			expect(countTokens(after)).toBeLessThan(countTokens(BIG) / 2);
		}
	});

	test("is the only reducer that sees unfenced prose", () => {
		const entry = messageEntry(structuredClone(OVERSIZED.user));
		// The premise of the whole tier: the shape-driven collector finds nothing
		// here, which is what left a session parked.
		expect(collectShakeRegions([entry], { ...DEFAULT_SHAKE_CONFIG, protectTokens: 0, minSavings: 0 })).toEqual([]);
		expect(collectOversizedTextRegions([entry], config()).length).toBe(1);
	});

	test("stops once the excess is covered instead of cutting every candidate", () => {
		const entries = [
			messageEntry(structuredClone(OVERSIZED.user)),
			messageEntry(structuredClone(OVERSIZED.developer)),
			messageEntry(structuredClone(OVERSIZED.bashExecution)),
		];
		const firstCut = collectOversizedTextRegions(entries, config({ excessTokens: 1 }));
		// One region for a token of excess: the walk stops the moment it is covered.
		expect(firstCut).toHaveLength(1);

		// Measured from what that region actually frees, not from an estimate of it:
		// one token more than that needs a second region, and no more than three
		// exist to give.
		const oneCutFrees = firstCut[0].tokens;
		expect(collectOversizedTextRegions(entries, config({ excessTokens: oneCutFrees + 1 })).length).toBe(2);
		expect(collectOversizedTextRegions(entries, config({ excessTokens: 10_000_000 })).length).toBe(3);
	});

	test("cuts the largest text first, so one region covers the most excess", () => {
		const small = messageEntry({ role: "user", content: prose(700), timestamp: 1 });
		const large = messageEntry({ role: "developer", content: BIG, timestamp: 1 });
		const regions = collectOversizedTextRegions([small, large], config({ excessTokens: 1 }));

		expect(regions).toHaveLength(1);
		expect(regions[0].entry).toBe(large);
	});

	test("leaves a text that is not oversized alone", () => {
		const small = prose(120);
		// The helper has to be honest for this case to mean anything.
		expect(countTokens(small)).toBeLessThan(config().minTextTokens);
		expect(
			collectOversizedTextRegions([messageEntry({ role: "user", content: small, timestamp: 1 })], config()),
		).toEqual([]);
	});

	test("does nothing when the context already meets its bar", () => {
		const entry = messageEntry(structuredClone(OVERSIZED.user));
		expect(collectOversizedTextRegions([entry], config({ excessTokens: 0 }))).toEqual([]);
		expect(collectOversizedTextRegions([entry], config({ excessTokens: -5 }))).toEqual([]);
	});

	test("does not touch a protected tool's output", () => {
		const entry = messageEntry({
			role: "toolResult",
			toolCallId: "call-skill",
			toolName: "skill",
			content: [{ type: "text", text: BIG }],
			isError: false,
			timestamp: 1,
		});
		// `protectedTools` exists because the model must keep seeing those bytes;
		// the reducer of last resort is not a licence to ignore it.
		expect(collectOversizedTextRegions([entry], config())).toEqual([]);
	});

	test("skips entries the latest compaction already summarized away", () => {
		const summarized = messageEntry(structuredClone(OVERSIZED.user));
		const kept = messageEntry(structuredClone(OVERSIZED.developer));
		const boundary: SessionEntry = {
			type: "compaction",
			id: "compaction-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			summary: "earlier work",
			firstKeptEntryId: kept.id,
			tokensBefore: 10_000,
		} as SessionEntry;

		const regions = collectOversizedTextRegions([summarized, boundary, kept], config({ keepBoundaryId: kept.id }));
		expect(regions.map(region => region.entry)).toEqual([kept]);
	});

	test("leaves a text it already truncated alone, so repeated passes do not grind it away", () => {
		// The only thing standing between this tier and a slow grind is the margin
		// between `minTextTokens` and the two edges it leaves behind: a cut text
		// must land BELOW the floor that made it a candidate, or every maintenance
		// pass shaves the same message again and the model loses a little more of
		// it each time while the session still reports recovery.
		const entry = messageEntry(structuredClone(OVERSIZED.user));
		const first = collectOversizedTextRegions([entry], config());
		expect(first).toHaveLength(1);
		applyShakeRegions(first.map(region => ({ region, replacement: "[truncated ~4,000 tokens]" })));

		expect(collectOversizedTextRegions([entry], config())).toEqual([]);
	});
});
