/**
 * WHY THIS SUITE EXISTS:
 *
 * A session file stores a read card as a `rows` tag, and a load rebuilds the card from the result's
 * own text: the numbered rows the model read. The rebuilt display held that text twice over, in the
 * record the codec checks before writing the tag back and in the getter that builds the card text on
 * first draw. While the result's content holds the same text, both are free. A prune replaces the
 * content with a notice, and the display then became the only holder of the file's numbered rows,
 * kept beside the card text the prune's rewrite builds. A resumed 600-turn session whose overflow
 * prune blanked 398 superseded reads held 5.07 MiB of those rows on top of 4.73 MiB of card text.
 *
 * CLASS: every pass that replaces a loaded read result's content and writes it back (a newer read
 * superseding it, the age window pruning it), whether a card drew the read before the prune or not,
 * leaves no copy of the numbered rows on the heap, while the card still draws the file and the
 * rewritten line stores the card text. A read no pass touched is the control: its content holds the
 * rows, so the probe counts one copy, which proves it sees a copy when one exists.
 *
 * DOES NOT CATCH: a content replacement that is never written back. The record is dropped when the
 * write finds the content changed, so a manager that does not persist keeps the rows until the entry
 * goes.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
import type { ReadToolDetails } from "@veyyon/coding-agent/tools/fs/read";
import { readResultCodec } from "@veyyon/coding-agent/tools/fs/read-display";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { registerToolResultCodecs } from "@veyyon/kernel/session/tool-result-codecs";
import { setAgentDir, TempDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";

/** Rows per read: enough that a copy of the result text is a distinct, sizable heap string. */
const ROWS = 3000;

/** The tag the subject read's header carries; the newer read of the same file carries another. */
const SUBJECT_TAG = "AAAA";
const NEWER_TAG = "BBBB";

interface ProbeCase {
	name: string;
	file: string;
	prune: "supersede" | "age" | "none";
	draw: boolean;
	marker: string;
	length: number;
}

interface ProbeResult {
	copies: number;
	pruned: boolean;
	card: string;
}

const CASES: ReadonlyArray<Pick<ProbeCase, "name" | "prune" | "draw">> = [
	{ name: "superseded by a newer read", prune: "supersede", draw: false },
	{ name: "drawn, then superseded by a newer read", prune: "supersede", draw: true },
	{ name: "aged out of the protect window", prune: "age", draw: false },
	{ name: "drawn, then aged out of the protect window", prune: "age", draw: true },
	{ name: "kept by every pass", prune: "none", draw: true },
];

/** The numbered rows a read of `file` returns under `tag`, and the card text those rows draw. */
function readOf(file: string, tag: string): { body: string; card: string } {
	const lines: string[] = [];
	for (let n = 1; n <= ROWS; n++) lines.push(`export const value${n} = compute(${n}, "${tag}");`);
	return {
		body: `[${file}#${tag}]\n${lines.map((line, index) => `${index + 1}:${line}`).join("\n")}`,
		card: lines.join("\n"),
	};
}

function assistantReading(file: string, ids: readonly string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map(id => ({ type: "toolCall", id, name: "read", arguments: { path: file } })),
		timestamp: 1,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		stopReason: "toolUse",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function readResult(id: string, read: { body: string; card: string }): ToolResultMessage<ReadToolDetails> {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: read.body }],
		details: { displayContent: { text: read.card, startLine: 1 } },
		isError: false,
		timestamp: 2,
	};
}

/** The subject read's details as the session file line holds them. */
function writtenSubject(file: string): ReadToolDetails | undefined {
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.includes('"toolCallId":"subject"')) continue;
		return (JSON.parse(line) as { message: ToolResultMessage<ReadToolDetails> }).message.details;
	}
	return undefined;
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Opens each case's session in a fresh process, prunes and writes it back as the case says, keeps
 * every manager alive, collects, and counts per case the heap strings that are the subject read's
 * whole result text: a string node that starts with its header and whose self size covers it. The
 * V8 snapshot truncates a node's name, not its size.
 */
const HEAP_PROBE = `
const { createHash } = await import("node:crypto");
const { setAgentDir } = await import("@veyyon/utils");
const { SessionManager } = await import("@veyyon/kernel/session/session-manager");
const { registerToolResultCodecs } = await import("@veyyon/kernel/session/tool-result-codecs");
const { readResultCodec } = await import("@veyyon/coding-agent/tools/fs/read-display");
const { pruneSupersededToolResults, pruneToolOutputs, readToolSupersedeKey } = await import(
	"@veyyon/agent-core/compaction/pruning"
);
setAgentDir(process.env.PROBE_AGENT_DIR);
registerToolResultCodecs([readResultCodec]);
const cases = JSON.parse(process.env.PROBE_CASES);
const held = [];
async function prepare(c) {
	const manager = await SessionManager.open(c.file);
	const entry = manager
		.getBranch()
		.find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === "subject");
	if (c.draw) held.push(entry.message.details.displayContent.text.length);
	let pruned = [];
	if (c.prune === "supersede") {
		pruned = pruneSupersededToolResults(manager.getBranch(), {
			supersedeKey: readToolSupersedeKey,
			protectedTools: [],
			idleFlushMs: 0,
		}).prunedEntries;
	} else if (c.prune === "age") {
		pruned = pruneToolOutputs(manager.getBranch(), { protectTokens: 0, minimumSavings: 0, protectedTools: [] })
			.prunedEntries;
	}
	if (pruned.length > 0) await manager.rewriteEntries(pruned);
	return { c, manager, entry, pruned: pruned.includes(entry) };
}
const prepared = [];
for (const c of cases) prepared.push(await prepare(c));
Bun.gc(true);
Bun.gc(true);
const snap = JSON.parse(Bun.generateHeapSnapshot("v8"));
const fields = snap.snapshot.meta.node_fields;
const stride = fields.length;
const typeAt = fields.indexOf("type");
const nameAt = fields.indexOf("name");
const sizeAt = fields.indexOf("self_size");
const stringType = snap.snapshot.meta.node_types[0].indexOf("string");
const copies = Object.fromEntries(cases.map(c => [c.name, 0]));
for (let i = 0; i < snap.nodes.length; i += stride) {
	if (snap.nodes[i + typeAt] !== stringType) continue;
	const value = snap.strings[snap.nodes[i + nameAt]];
	for (const c of cases) {
		if (value.startsWith(c.marker) && snap.nodes[i + sizeAt] >= c.length) copies[c.name]++;
	}
}
const out = {};
for (const p of prepared) {
	const card = p.entry.message.details.displayContent.text;
	out[p.c.name] = { copies: copies[p.c.name], pruned: p.pruned, card: createHash("sha256").update(card).digest("hex") };
}
process.stdout.write(JSON.stringify(out));
`;

describe("a pruned read releases the text its card was rebuilt from", () => {
	let dirOverrides: DirOverridesSnapshot | undefined;
	let root: TempDir;

	beforeEach(() => {
		dirOverrides = captureDirOverrides();
		root = TempDir.createSync("@pi-pruned-read-rows-");
		setAgentDir(root.join("agent"));
		registerToolResultCodecs([readResultCodec]);
	});

	afterEach(async () => {
		if (dirOverrides !== undefined) restoreDirOverrides(dirOverrides);
		dirOverrides = undefined;
		await root.remove();
	});

	it("holds no copy of the pruned result's rows, draws the same card, and writes its text whole", async () => {
		const cases: ProbeCase[] = [];
		const cards: string[] = [];
		for (const [index, spec] of CASES.entries()) {
			const file = `case-${index}.ts`;
			const subject = readOf(file, SUBJECT_TAG);
			const writer = SessionManager.create(root.path(), root.join("sessions", `case-${index}`));
			writer.appendMessage(assistantReading(file, ["subject", "newer"]));
			writer.appendMessage(readResult("subject", subject));
			writer.appendMessage(readResult("newer", readOf(file, NEWER_TAG)));
			await writer.flush();
			const sessionFile = writer.getSessionFile() as string;
			// The load rebuilds the card from the rows only when the line was written as a `rows` tag.
			expect({ case: spec.name, written: writtenSubject(sessionFile)?.displayContent }).toEqual({
				case: spec.name,
				written: { startLine: 1, from: "rows" },
			});
			cases.push({
				...spec,
				file: sessionFile,
				marker: `[${file}#${SUBJECT_TAG}]`,
				length: subject.body.length,
			});
			cards.push(subject.card);
		}

		const probe = spawnSync(process.execPath, ["-e", HEAP_PROBE], {
			cwd: path.join(import.meta.dirname, "..", ".."),
			encoding: "utf8",
			env: {
				...process.env,
				PROBE_CASES: JSON.stringify(cases),
				PROBE_AGENT_DIR: root.join("probe-agent"),
			},
		});
		expect(probe.stderr).toBe("");
		const results = JSON.parse(probe.stdout) as Record<string, ProbeResult>;

		for (const [index, c] of cases.entries()) {
			const pruned = c.prune !== "none";
			expect({ case: c.name, result: results[c.name] }).toEqual({
				case: c.name,
				result: { copies: pruned ? 0 : 1, pruned, card: sha256(cards[index]) },
			});
			const written = writtenSubject(c.file)?.displayContent;
			expect({ case: c.name, written }).toEqual({
				case: c.name,
				written: pruned ? { text: cards[index], startLine: 1 } : { startLine: 1, from: "rows" },
			});
		}
	});
});
