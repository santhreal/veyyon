import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	type CompactionEntry,
	type CompactionPreparation,
	compactWithProvider,
	DEFAULT_COMPACTION_SETTINGS,
	KEEP_NOTHING_ENTRY_ID,
	LEGACY_REMOTE_PRESERVE_KEYS,
	prepareCompaction,
	REMOTE_COMPACTION_PRESERVE_KEY,
	type SessionEntry,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Model } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { buildSessionContext } from "@veyyon/kernel/session/session-context";

/**
 * WHY: a compaction reads the history it replaces from the branch, and the context a turn sends is
 * rebuilt from the same branch by `buildSessionContext`. The two walks disagreed in three places.
 *
 * - A local pass started reading after the newest summary entry, so the turns that entry kept were
 *   neither summarized nor kept by the next pass.
 * - A server-side pass chained the previous window only when the cut landed after it. A cut inside
 *   a turn opened before the window re-sent the whole session behind the window instead, so a long
 *   single-turn run outgrew the provider's context on every compaction and failed with
 *   `context_length_exceeded`. A chained pass also dropped the turns the window kept.
 * - A server-side pass after a local summary posted only the messages since that summary, so the
 *   window it returned replaced the summary and the turns it kept with nothing.
 *
 * The class this closes: over every branch built from the artifacts a compaction leaves (a summary,
 * a window the session model chains, a window from another provider, each keeping nothing, its
 * whole span, or its last message, and every legacy provider-native key), stacked up to two deep,
 * with the second artifact's kept span also reaching behind the span the first kept, with turns
 * that open after each artifact or continue across it, and at every cut point:
 * - a local pass reads, in order, exactly the context a provider that replays no window is sent,
 *   less the tail it keeps;
 * - a server-side pass posts, in order, exactly the context the session model is sent, less the
 *   tail it keeps;
 * - a local cut inside a turn summarizes that turn's opening as the turn prefix.
 *
 * What it does NOT catch: tool calls and their results, whose pairing the cut and the rebuild
 * settle separately; keep markers naming entries off the branch; and wire detail of a transport
 * beyond the input items it posts.
 */

const MODEL: Model = (() => {
	const model = getBundledModel("openai", "gpt-5.1");
	if (!model) throw new Error("bundled catalog has no openai/gpt-5.1");
	return model;
})();

const TOKEN = /\b(?:MSG|SUM|WIN)\d+\b/g;
/**
 * Every fixture marker in `value`'s strings, in serialized order, repeats included. Strings are
 * matched as text, not as JSON, so a marker after an escaped newline still counts.
 */
function markers(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") {
		for (const match of value.match(TOKEN) ?? []) out.push(match);
	} else if (Array.isArray(value)) {
		for (const item of value) markers(item, out);
	} else if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) markers(item, out);
	}
	return out;
}

const USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
/** Enough text per message that the budget sweep lands the cut on every message. */
const BODY = " lorem ipsum".repeat(20);
const BASE_TIME = 1_700_000_000_000;

type ArtifactKind =
	| { kind: "summary" }
	| { kind: "window"; host: "session" | "foreign" }
	| { kind: "legacy"; key: string };
/** `behind` keeps from the branch's first message, reaching behind the span the artifact before it kept. */
type Keep = "nothing" | "first" | "last" | "behind";
interface Artifact {
	kind: ArtifactKind;
	keep: Keep;
}

const KEEPS: readonly Keep[] = ["nothing", "first", "last"];
const ARTIFACTS: readonly Artifact[] = [
	...KEEPS.map(keep => ({ kind: { kind: "summary" }, keep }) satisfies Artifact),
	...KEEPS.map(keep => ({ kind: { kind: "window", host: "session" }, keep }) satisfies Artifact),
	...KEEPS.map(keep => ({ kind: { kind: "window", host: "foreign" }, keep }) satisfies Artifact),
	...LEGACY_REMOTE_PRESERVE_KEYS.map(key => ({ kind: { kind: "legacy", key }, keep: "last" }) satisfies Artifact),
];
/** Second artifacts: every first artifact, and each window or summary keeping a span that reaches behind the first's. */
const SECOND_ARTIFACTS: readonly Artifact[] = [
	...ARTIFACTS,
	...ARTIFACTS.filter(artifact => artifact.kind.kind !== "legacy" && artifact.keep === "first").map(
		artifact => ({ kind: artifact.kind, keep: "behind" }) satisfies Artifact,
	),
];

function label(artifact: Artifact): string {
	const kind = artifact.kind;
	const name =
		kind.kind === "window" ? `window(${kind.host})` : kind.kind === "legacy" ? `legacy(${kind.key})` : "summary";
	return `${name}/keep-${artifact.keep}`;
}

function windowPreserveData(host: "session" | "foreign", token: string): Record<string, unknown> {
	return {
		[REMOTE_COMPACTION_PRESERVE_KEY]: {
			version: 1,
			provider: host === "session" ? MODEL.provider : "azure",
			api: host === "session" ? MODEL.api : "azure-openai-responses",
			model: MODEL.id,
			window: [{ type: "compaction", encrypted_content: token }],
			compactedAt: new Date(BASE_TIME).toISOString(),
		},
	};
}

/**
 * A branch of three-message runs with `artifacts[i]` after run `i`. Run 0 opens a turn; run `i + 1`
 * opens one when `opensTurn[i]`, and otherwise continues the turn across the artifact. Each
 * artifact keeps nothing, the first message it may keep, or the last; a kept span never reaches
 * behind the span the artifact before it kept, except a `behind` keep.
 */
function buildBranch(artifacts: readonly Artifact[], opensTurn: readonly boolean[]): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let parentId: string | undefined;
	let serial = 0;
	const append = (entry: SessionEntry): void => {
		entries.push(entry);
		parentId = entry.id;
	};
	const run = (opens: boolean): void => {
		for (let k = 0; k < 3; k++) {
			const id = `MSG${serial}`;
			const timestamp = BASE_TIME + serial++ * 1000;
			const message: AgentMessage =
				k === 0 && opens
					? { role: "user", content: `${id}${BODY}`, timestamp }
					: {
							role: "assistant",
							content: [{ type: "text", text: `${id}${BODY}` }],
							api: MODEL.api,
							provider: MODEL.provider,
							model: MODEL.id,
							usage: USAGE,
							stopReason: "stop",
							timestamp,
						};
			append({
				type: "message",
				id,
				parentId,
				timestamp: new Date(timestamp).toISOString(),
				message,
			} as SessionEntry);
		}
	};
	let keepFloor = 0;
	for (let i = 0; i <= artifacts.length; i++) {
		run(i === 0 || opensTurn[i - 1] === true);
		const artifact = artifacts[i];
		if (!artifact) break;
		const keepable = entries
			.slice(artifact.keep === "behind" ? 0 : keepFloor)
			.filter(entry => entry.type === "message");
		const firstKeptEntryId =
			artifact.keep === "nothing"
				? KEEP_NOTHING_ENTRY_ID
				: (artifact.keep === "last" ? keepable[keepable.length - 1] : keepable[0])!.id;
		const kind = artifact.kind;
		const entry = {
			type: "compaction",
			id: `C${i}`,
			parentId,
			timestamp: new Date(BASE_TIME + serial * 1000).toISOString(),
			summary:
				kind.kind === "summary"
					? `SUM${i}`
					: kind.kind === "legacy"
						? "Remote compaction preserved provider-native history for this session."
						: "",
			firstKeptEntryId,
			tokensBefore: 1,
			preserveData:
				kind.kind === "window"
					? windowPreserveData(kind.host, `WIN${i}`)
					: kind.kind === "legacy"
						? { [kind.key]: { provider: "openai-codex", replacementHistory: [{}] } }
						: undefined,
		} as CompactionEntry;
		append(entry);
		if (kind.kind !== "legacy") {
			keepFloor =
				firstKeptEntryId === KEEP_NOTHING_ENTRY_ID
					? entries.length
					: entries.findIndex(candidate => candidate.id === firstKeptEntryId);
		}
	}
	return entries;
}

/** The same branch with every window minted by a provider nothing replays. */
function withUnreplayableWindows(entries: readonly SessionEntry[]): SessionEntry[] {
	return entries.map(entry => {
		if (entry.type !== "compaction") return entry;
		const data = entry.preserveData?.[REMOTE_COMPACTION_PRESERVE_KEY] as Record<string, unknown> | undefined;
		if (!data) return entry;
		return {
			...entry,
			preserveData: { [REMOTE_COMPACTION_PRESERVE_KEY]: { ...data, provider: "unreplayable" } },
		};
	});
}

interface Case {
	name: string;
	entries: SessionEntry[];
}

function cases(): Case[] {
	const out: Case[] = [{ name: "no artifact", entries: buildBranch([], []) }];
	for (const first of ARTIFACTS) {
		for (const opens of [true, false]) {
			out.push({
				name: `${label(first)} turn-${opens ? "opens" : "continues"}`,
				entries: buildBranch([first], [opens]),
			});
		}
		for (const second of SECOND_ARTIFACTS) {
			for (const opensA of [true, false]) {
				for (const opensB of [true, false]) {
					out.push({
						name: `${label(first)} ${opensA ? "opens" : "continues"} ${label(second)} ${opensB ? "opens" : "continues"}`,
						entries: buildBranch([first, second], [opensA, opensB]),
					});
				}
			}
		}
	}
	return out;
}

/** One preparation per distinct cut, from keeping nearly nothing to keeping nearly everything. */
function preparationsAtEveryCut(entries: SessionEntry[]): CompactionPreparation[] {
	const out: CompactionPreparation[] = [];
	const seen = new Set<string>();
	for (let keepRecentTokens = 1; keepRecentTokens <= 4_000; keepRecentTokens += 10) {
		const prepared = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens });
		if (!prepared || seen.has(prepared.firstKeptEntryId)) continue;
		seen.add(prepared.firstKeptEntryId);
		out.push(prepared);
	}
	return out;
}

async function postedInput(prepared: CompactionPreparation): Promise<unknown> {
	let input: unknown;
	await compactWithProvider(prepared, MODEL, "test-key", undefined, undefined, {
		fetch: async (_url, init) => {
			input = (JSON.parse(String(init?.body)) as { input: unknown }).input;
			return new Response(JSON.stringify({ output: [{ type: "compaction", encrypted_content: "WINDOW_NEW" }] }), {
				status: 200,
			});
		},
	});
	return input;
}

const CASES = cases();

describe("a compaction reads exactly the context it replaces", () => {
	it("sweeps a branch for every artifact kind, keep marker and turn shape", () => {
		const kinds = new Set(ARTIFACTS.map(artifact => artifact.kind.kind));
		expect([...kinds].sort()).toEqual(["legacy", "summary", "window"]);
		expect(ARTIFACTS.filter(artifact => artifact.kind.kind === "legacy")).toHaveLength(
			LEGACY_REMOTE_PRESERVE_KEYS.length,
		);
		for (const testCase of CASES) {
			expect(preparationsAtEveryCut(testCase.entries).length).toBeGreaterThan(1);
		}
	});

	it("a local pass reads the context a provider that replays no window is sent, less the kept tail", () => {
		const failures: string[] = [];
		for (const testCase of CASES) {
			const expanded = markers(buildSessionContext(withUnreplayableWindows(testCase.entries)).messages);
			for (const prepared of preparationsAtEveryCut(testCase.entries)) {
				const read = [
					...markers(prepared.previousSummary ?? null),
					...markers(prepared.messagesToSummarize),
					...markers(prepared.turnPrefixMessages),
					...markers(prepared.recentMessages),
				];
				if (read.join(" ") !== expanded.join(" ")) {
					failures.push(`${testCase.name} @${prepared.firstKeptEntryId}: read [${read}] context [${expanded}]`);
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it("a server-side pass posts the context the session model is sent, less the kept tail", async () => {
		const failures: string[] = [];
		for (const testCase of CASES) {
			const live = markers(buildSessionContext(testCase.entries).messages);
			for (const prepared of preparationsAtEveryCut(testCase.entries)) {
				const sent = [...markers(await postedInput(prepared)), ...markers(prepared.recentMessages)];
				if (sent.join(" ") !== live.join(" ")) {
					failures.push(`${testCase.name} @${prepared.firstKeptEntryId}: posted+kept [${sent}] context [${live}]`);
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it("a local cut inside a turn summarizes that turn's opening as the turn prefix", () => {
		const failures: string[] = [];
		for (const testCase of CASES) {
			for (const prepared of preparationsAtEveryCut(testCase.entries)) {
				const read = prepared.messagesToSummarize.concat(prepared.turnPrefixMessages);
				const opening = read.findLastIndex(message => message.role === "user");
				const cutInsideTurn = prepared.recentMessages[0]?.role === "assistant" && opening !== -1;
				const prefix = markers(prepared.turnPrefixMessages).join(" ");
				const expected = cutInsideTurn ? markers(read.slice(opening)).join(" ") : "";
				if (prepared.isSplitTurn !== cutInsideTurn || prefix !== expected) {
					failures.push(
						`${testCase.name} @${prepared.firstKeptEntryId}: split ${prepared.isSplitTurn} prefix [${prefix}] expected [${expected}]`,
					);
				}
			}
		}
		expect(failures).toEqual([]);
	});
});
