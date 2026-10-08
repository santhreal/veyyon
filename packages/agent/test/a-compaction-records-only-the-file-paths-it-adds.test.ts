/**
 * WHY: every compaction stored the session's read and modified file lists in full, and the lists
 * only grow, so each compaction repeated every path the one before it held. One long session held
 * 390 compactions carrying 116MB of paths, 15% of the file, all of it parsed again on every resume
 * and held in memory for the life of the session.
 *
 * A compaction now records only the paths its lists gained over the compaction it built on and
 * names that compaction as `base`. The class this closes: a compaction record that repeats a path
 * its chain already holds, and a reader that resolves the chain to anything other than the lists
 * the full-list format produced. The differential below drives `prepareCompaction` and `compact`
 * over the same session twice, once as written and once with every record rewritten to the full
 * lists the previous format stored, and asserts after each compaction that both chains give the
 * summarizer the same file operations and the same `<files>` block, while the base-chained records
 * never store one path twice. It runs from a fresh session and from one an older build began, so a
 * full-list record is read as the root of a chain. Separate cases pin that an extension's
 * compaction starts the lists over, that a `base` naming a missing, later or looping record ends
 * the walk, and that a record holding full lists ends it whatever `base` it also names.
 *
 * What it does not catch: an older build resuming a session this build compacted. That build
 * reads no `readFiles` on the new records and carries only its own window's paths forward.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	type CompactionDetails,
	type CompactionEntry,
	type CompactionPreparation,
	compact,
	computeFileLists,
	DEFAULT_COMPACTION_SETTINGS,
	KEEP_NOTHING_ENTRY_ID,
	prepareCompaction,
	type SessionEntry,
	type SessionMessageEntry,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ToolCall, ToolResultMessage, Usage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";

const SETTINGS = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 };
const TIMESTAMP = "2026-09-25T00:00:00.000Z";

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${counter++}`;

const usage = (): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function model() {
	const found = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!found) throw new Error("expected a bundled compaction model");
	return found;
}

function messageEntry(message: AgentMessage): SessionMessageEntry {
	return { type: "message", id: nextId("entry"), parentId: null, timestamp: TIMESTAMP, message };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: 1,
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		api: "anthropic-messages",
		usage: usage(),
		stopReason: "stop",
	};
}

/** One turn that reads `reads` and edits `edits`, each call answered by a successful result. */
function turn(reads: string[], edits: string[]): SessionEntry[] {
	const calls: ToolCall[] = [
		...reads.map(path => ({ type: "toolCall" as const, id: nextId("call"), name: "read", arguments: { path } })),
		...edits.map(path => ({ type: "toolCall" as const, id: nextId("call"), name: "edit", arguments: { path } })),
	];
	const results = calls.map(
		(call): ToolResultMessage => ({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 1,
		}),
	);
	return [
		messageEntry({ role: "user", content: [{ type: "text", text: "next step" }], timestamp: 1 }),
		messageEntry(assistant(calls)),
		...results.map(messageEntry),
		messageEntry(assistant([{ type: "text", text: "done" }])),
	];
}

/** A turn that touches no file, for the tail a compaction keeps wherever its cut lands. */
function plainTurn(): SessionEntry[] {
	return [
		messageEntry({ role: "user", content: [{ type: "text", text: "what next" }], timestamp: 1 }),
		messageEntry(assistant([{ type: "text", text: "nothing to change" }])),
	];
}

/**
 * Steps of a session, each a turn the next compaction summarizes and a turn it keeps. The paths
 * overlap across steps: a read file later edited, an edited file later read, a file read again.
 */
const STEPS: { reads: string[]; edits: string[] }[][] = [
	[
		{ reads: ["src/a.ts", "src/b.ts:10-20"], edits: ["src/c.ts"] },
		{ reads: ["src/kept-1.ts"], edits: [] },
	],
	[
		{ reads: ["src/a.ts", "src/d.ts"], edits: ["src/b.ts"] },
		{ reads: ["src/kept-2.ts"], edits: [] },
	],
	[
		{ reads: ["src/c.ts", "src/e.ts"], edits: ["src/f.ts"] },
		{ reads: ["src/kept-3.ts"], edits: [] },
	],
	[
		{ reads: ["src/a.ts", "src/g.ts"], edits: ["src/a.ts"] },
		{ reads: ["src/kept-4.ts"], edits: [] },
	],
	[
		{ reads: ["src/h.ts", "src/d.ts"], edits: [] },
		{ reads: ["src/kept-5.ts"], edits: [] },
	],
];

let summaries = 0;

/** Prepare and run one compaction over `path` and return the entry it would append. */
async function compactPath(
	path: SessionEntry[],
): Promise<{ entry: CompactionEntry; preparation: CompactionPreparation }> {
	const preparation = prepareCompaction(path, SETTINGS);
	if (!preparation) throw new Error("expected the path to compact");
	const result = await compact(preparation, model(), "test-key", undefined, undefined, {
		completeImpl: async () => assistant([{ type: "text", text: `Summary ${++summaries} of the work so far.` }]),
	});
	const entry: CompactionEntry = {
		type: "compaction",
		id: nextId("compaction"),
		parentId: null,
		timestamp: TIMESTAMP,
		summary: result.summary,
		firstKeptEntryId: result.firstKeptEntryId,
		tokensBefore: result.tokensBefore,
		details: result.details,
	};
	return { entry, preparation };
}

/** The full lists the previous format stored for a compaction prepared as `preparation`. */
function fullLists(preparation: CompactionPreparation): { readFiles: string[]; modifiedFiles: string[] } {
	return computeFileLists(preparation.fileOps);
}

function sorted(values: Iterable<string>): string[] {
	return [...values].sort();
}

function filesBlock(summary: string): string | undefined {
	return summary.match(/<files>[\s\S]*?<\/files>/)?.[0];
}

describe("a compaction records only the file paths it adds", () => {
	for (const olderBuildBegan of [false, true]) {
		it(`gives every compaction the lists the full-list format gave it, ${olderBuildBegan ? "from a session an older build began" : "from a fresh session"}`, async () => {
			const chained: SessionEntry[] = [];
			const full: SessionEntry[] = [];
			const stored: CompactionDetails[] = [];

			for (const [index, step] of STEPS.entries()) {
				for (const { reads, edits } of step) {
					chained.push(...turn(reads, edits));
					full.push(...turn(reads, edits));
				}
				const a = await compactPath(chained);
				const b = await compactPath(full);

				expect({ step: index, read: sorted(a.preparation.fileOps.read) }).toEqual({
					step: index,
					read: sorted(b.preparation.fileOps.read),
				});
				expect({ step: index, lists: fullLists(a.preparation) }).toEqual({
					step: index,
					lists: fullLists(b.preparation),
				});
				expect({ step: index, files: filesBlock(a.entry.summary) }).toEqual({
					step: index,
					files: filesBlock(b.entry.summary),
				});

				b.entry.details = fullLists(b.preparation);
				if (index === 0 && olderBuildBegan) {
					a.entry.details = fullLists(a.preparation);
				} else {
					const details = a.entry.details as CompactionDetails;
					// The first record of a fresh chain has nothing to build on; every later one builds on the
					// compaction before it.
					const previous = chained.findLast(entry => entry.type === "compaction");
					expect({ step: index, base: details.base }).toEqual({ step: index, base: previous?.id });
					stored.push(details);
				}
				chained.push(a.entry);
				full.push(b.entry);
			}

			const storedReads = stored.flatMap(details => details.readFilesAdded);
			const storedModified = stored.flatMap(details => details.modifiedFilesAdded);
			expect(storedReads).toEqual([...new Set(storedReads)]);
			expect(storedModified).toEqual([...new Set(storedModified)]);
			// The session repeats paths across compactions, so the full-list format stores more: the check
			// above is not satisfied by a session that never repeats one.
			const fullCount = full
				.filter((entry): entry is CompactionEntry => entry.type === "compaction")
				.reduce((total, entry) => {
					const lists = entry.details as { readFiles: string[]; modifiedFiles: string[] };
					return total + lists.readFiles.length + lists.modifiedFiles.length;
				}, 0);
			expect(storedReads.length + storedModified.length).toBeLessThan(fullCount);
		});
	}

	it("starts the lists over after a compaction an extension wrote", async () => {
		const path: SessionEntry[] = [
			...turn(["src/before.ts"], ["src/before-edit.ts"]),
			{
				type: "compaction",
				id: nextId("compaction"),
				parentId: null,
				timestamp: TIMESTAMP,
				summary: "Extension summary.",
				firstKeptEntryId: KEEP_NOTHING_ENTRY_ID,
				tokensBefore: 0,
				fromExtension: true,
				details: { readFiles: ["src/extension-read.ts"], modifiedFiles: ["src/extension-edit.ts"] },
			} satisfies CompactionEntry,
			...turn(["src/after.ts"], []),
			...plainTurn(),
		];

		const { entry, preparation } = await compactPath(path);

		expect(fullLists(preparation)).toEqual({ readFiles: ["src/after.ts"], modifiedFiles: [] });
		expect(entry.details).toEqual({ readFilesAdded: ["src/after.ts"], modifiedFilesAdded: [] });
	});

	it("ends the walk at a base that names no earlier compaction or that loops", async () => {
		const record = (id: string, base: string, path: string): CompactionEntry => ({
			type: "compaction",
			id,
			parentId: null,
			timestamp: TIMESTAMP,
			summary: `Summary ${id}.`,
			firstKeptEntryId: KEEP_NOTHING_ENTRY_ID,
			tokensBefore: 0,
			details: { base, readFilesAdded: [path], modifiedFilesAdded: [] } satisfies CompactionDetails,
		});
		const path: SessionEntry[] = [
			...turn(["src/one.ts"], []),
			record("loop-a", "loop-b", "src/loop-a.ts"),
			record("loop-b", "loop-a", "src/loop-b.ts"),
			record("head", "loop-b", "src/head.ts"),
			...turn(["src/two.ts"], []),
			...plainTurn(),
		];
		const looping = await compactPath(path);
		expect(fullLists(looping.preparation).readFiles).toEqual([
			"src/head.ts",
			"src/loop-a.ts",
			"src/loop-b.ts",
			"src/two.ts",
		]);

		const orphan: SessionEntry[] = [
			...turn(["src/one.ts"], []),
			record("head", "missing", "src/head.ts"),
			...turn(["src/two.ts"], []),
			...plainTurn(),
		];
		const missing = await compactPath(orphan);
		expect(fullLists(missing.preparation).readFiles).toEqual(["src/head.ts", "src/two.ts"]);
		expect(missing.entry.details).toEqual({ base: "head", readFilesAdded: ["src/two.ts"], modifiedFilesAdded: [] });

		// A provider-native compaction after the head is skipped as a base, so its id is on the path but
		// not before the head: a `base` naming it is as good as missing.
		const later: SessionEntry[] = [
			...turn(["src/one.ts"], []),
			record("head", "later", "src/head.ts"),
			...turn(["src/two.ts"], []),
			{ ...record("later", "head", "src/later.ts"), preserveData: { compactionV2: {} } },
			...plainTurn(),
		];
		const skipped = await compactPath(later);
		expect(fullLists(skipped.preparation).readFiles).toEqual(["src/head.ts", "src/two.ts"]);
	});

	it("reads a record that holds full lists as the whole chain, whatever base it also names", async () => {
		const path: SessionEntry[] = [
			...turn(["src/one.ts"], []),
			{
				type: "compaction",
				id: "earlier",
				parentId: null,
				timestamp: TIMESTAMP,
				summary: "Summary earlier.",
				firstKeptEntryId: KEEP_NOTHING_ENTRY_ID,
				tokensBefore: 0,
				details: { readFilesAdded: ["src/earlier.ts"], modifiedFilesAdded: [] } satisfies CompactionDetails,
			} satisfies CompactionEntry,
			{
				type: "compaction",
				id: "head",
				parentId: null,
				timestamp: TIMESTAMP,
				summary: "Summary head.",
				firstKeptEntryId: KEEP_NOTHING_ENTRY_ID,
				tokensBefore: 0,
				details: {
					readFiles: ["src/full.ts"],
					modifiedFiles: ["src/full-edit.ts"],
					base: "earlier",
					readFilesAdded: ["src/added.ts"],
					modifiedFilesAdded: ["src/added-edit.ts"],
				},
			} satisfies CompactionEntry,
			...turn(["src/two.ts"], []),
			...plainTurn(),
		];

		const { preparation } = await compactPath(path);

		expect(fullLists(preparation)).toEqual({
			readFiles: ["src/full.ts", "src/two.ts"],
			modifiedFiles: ["src/full-edit.ts"],
		});
	});
});
