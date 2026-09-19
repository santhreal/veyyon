/**
 * Seed a branched session, so a scene can photograph the session tree card.
 *
 *   bun proof/docker/seed-session-tree.ts <repo-dir>
 *
 * `/tree` renders whatever `SessionManager.getTree()` holds, and a card with one
 * straight line of four entries shows nothing about a fork, a rail, an abandoned
 * branch or the mark on the current leaf. Producing that from a live session
 * needs several turns from a model plus a rewind, which a capture cannot wait
 * for and could not reproduce twice.
 *
 * Every entry here is written through the product's own `SessionManager`, so the
 * fixture cannot drift from the entry schema, and it lands in the directory the
 * CLI resolves for this cwd — the scene reaches it with `--continue`, the way a
 * user reaches this morning's session.
 *
 * Timestamps are the one thing the API cannot supply: an append is stamped now,
 * and a card whose every row was written in the same second has nothing to say
 * in its age column. Each entry carries the age it should read as, and the file
 * is rewritten once at the end with `now - age`, so the ages are the same on
 * every re-record and cover minutes, hours, days and the sub-minute blank.
 */
import * as fs from "node:fs";
import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@veyyon/ai";
import { SessionManager } from "@veyyon/kernel/session/session-manager";

const [repoDir] = process.argv.slice(2);
if (!repoDir) throw new Error("usage: seed-session-tree.ts <repo-dir>");

const manager = SessionManager.create(repoDir);

/** Age each entry reads as, in minutes, keyed by the id the append returned. */
const ages = new Map<string, number>();

/** Provider identity every seeded assistant turn carries, as one record. */
const TURN = { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5" } as const;

const at = (minutes: number): number => Date.now() - minutes * 60_000;

function user(text: string, age: number): string {
	const message: UserMessage = { role: "user", content: text, timestamp: at(age) };
	const id = manager.appendMessage(message);
	ages.set(id, age);
	return id;
}

function assistant(text: string, age: number, call?: ToolCall): string {
	const message: AssistantMessage = {
		role: "assistant",
		content: call ? [{ type: "text", text }, call] : [{ type: "text", text }],
		...TURN,
		usage: {
			input: 1_200,
			output: 180,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_380,
			cost: { input: 0.0036, output: 0.0027, cacheRead: 0, cacheWrite: 0, total: 0.0063 },
		},
		stopReason: call ? "toolUse" : "stop",
		timestamp: at(age),
	};
	const id = manager.appendMessage(message);
	ages.set(id, age);
	return id;
}

function toolResult(call: ToolCall, text: string, age: number): string {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: at(age),
	};
	const id = manager.appendMessage(message);
	ages.set(id, age);
	return id;
}

function label(targetId: string, text: string, age: number): void {
	ages.set(manager.appendLabelChange(targetId, text), age);
}

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
});

// ─── The trunk: a question, a read, and the finding that forks it ───────────
user("harden parse() so whitespace-only input is rejected", 4_320);
const readCall = call("toolu_seed_read", "read", { path: "src/parser.ts" });
assistant("Reading the parser and its suite before I change either.", 4_318, readCall);
toolResult(readCall, "export function parse(s: string): string {\n\treturn s.trim();\n}", 4_317);
const fork = assistant("parse() trims and returns the empty string, so a whitespace-only record is accepted.", 2_880);

// ─── The branch that was abandoned ──────────────────────────────────────────
// Written first and left behind, which is what puts it off the active path: its
// rows carry no mark and a dim rail, and the card is the only place that shows
// the attempt still exists.
const regexTry = user("just match the whole thing against a regex", 300);
assistant("A regex rejects the whitespace case, and also rejects a tab inside an otherwise valid record.", 295);
label(regexTry, "regex attempt", 295);

// ─── The branch that was kept ───────────────────────────────────────────────
manager.branch(fork);
user("reject it in parse() itself, and pin both cases in the suite", 40);
const editCall = call("toolu_seed_edit", "edit", { path: "src/parser.ts" });
assistant("Rejecting empty input at the boundary, then extending the suite.", 38, editCall);
toolResult(editCall, "src/parser.ts: 1 hunk applied", 22);
assistant("parse() now throws on a whitespace-only record and keeps trimming a valid one.", 14);
user("run the suite", 8);
const testCall = call("toolu_seed_bash", "bash", { command: "bun test src/parser.test.ts" });
assistant("Running the parser suite.", 5, testCall);
toolResult(testCall, "4 pass\n0 fail\nRan 4 tests across 1 file.", 3);
assistant("4 pass, 0 fail: the whitespace case is rejected and the valid record still parses.", 0);

await manager.flush();

// ─── The ages, written over the stamps the appends minted ───────────────────
const file = manager.getSessionFile();
if (!file) throw new Error("the seeded session was not persisted");
const aged = fs
	.readFileSync(file, "utf8")
	.split("\n")
	.map(line => {
		if (!line) return line;
		const entry: { id?: string; timestamp?: string } = JSON.parse(line);
		const age = entry.id === undefined ? undefined : ages.get(entry.id);
		if (age === undefined) return line;
		entry.timestamp = new Date(at(age)).toISOString();
		return JSON.stringify(entry);
	})
	.join("\n");
fs.writeFileSync(file, aged);

console.log(`seeded a branched session with ${ages.size} entries at ${file}`);
