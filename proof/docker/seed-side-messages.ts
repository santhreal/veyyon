/**
 * Seed a session holding one of every recorded message that is neither a
 * prompt nor a model reply, so a proof scene photographs the desktop drawing
 * all eight of them in a single transcript.
 *
 * Each message is written in the shape its producer writes: the async batch
 * through `buildAsyncResultBatchMessage`, the diagnostics through
 * `buildLateDiagnosticsBatchMessage`, the advisor note through
 * `formatAdvisorBatchContent`, and the remaining five with the `customType`
 * and `details` their call sites in `collab/host.ts`, `task/irc-bus.ts`,
 * `modes/terminal/skill-command.ts` and `session/agent-session.ts` record. A
 * fixture that invented a shape would photograph a card no session produces.
 *
 * The seed fails closed on a variant it does not cover: every member of
 * `CUSTOM_BLOCK_DISPLAY_VARIANTS` has to project from a message written here,
 * so a ninth variant stops the seed instead of leaving a scene to photograph a
 * frame that silently misses one.
 *
 * Written through the production `SessionManager` into the canonical session
 * directory, so the scene reaches it the way a resumed session is read back.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AsyncJob, AsyncJobType } from "@veyyon/coding-agent/async/job-manager";
import { formatAdvisorBatchContent } from "@veyyon/coding-agent/advisor/advise-tool";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@veyyon/coding-agent/collab/protocol";
import { projectCustomDisplay } from "@veyyon/coding-agent/presentation/custom-display";
import {
	buildAsyncResultBatchMessage,
	buildLateDiagnosticsBatchMessage,
} from "@veyyon/coding-agent/session/factory-notices";
import {
	BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
	type BackgroundTanDispatchDetails,
	type CustomMessage,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { CUSTOM_BLOCK_DISPLAY_VARIANTS } from "@veyyon/wire/presentation";

const [repoDirArg] = process.argv.slice(2);
const repoDir = path.resolve(repoDirArg || "/sandbox/home/demo");

/** Fixed, so both arms of a pair draw the same durations and the same clock. */
const BASE = Date.UTC(2024, 4, 7, 9, 30, 0);

/** The row the scene searches the rail for. */
const SESSION_TITLE = "Parser arena reset";

/**
 * Where the scene reads the seeded session's title, file and variants from, so
 * a re-seeded fixture cannot leave a scene searching for a row that is no
 * longer in the store.
 */
const MANIFEST = path.join(os.homedir(), ".veyyon", "proof", "side-messages.json");

const sessionManager = SessionManager.create(repoDir);
const seeded = new Set<string>();

/**
 * Append a side message and record the display it projects to.
 *
 * The projection runs here rather than in the scene because a message whose
 * `details` no longer reach its card is a blank frame, and a blank frame in a
 * proof pair reads as a renderer that stopped drawing.
 */
function appendSide(message: CustomMessage<unknown>): void {
	const display = projectCustomDisplay(
		message.customType,
		message.details,
		message.content,
		message.timestamp ?? BASE,
		message,
	);
	if (display === undefined) {
		throw new Error(`${message.customType} projects to no typed display, so it draws as plain text`);
	}
	seeded.add(display.variant);
	sessionManager.appendMessage(message);
}

sessionManager.appendMessage({
	role: "user",
	content: [{ type: "text", text: "Land the parser fix and keep the review notes" }],
	timestamp: BASE,
});

// A session holding no model turn is never written to the store, so the reply
// the side messages arrive around is part of the fixture, not decoration.
sessionManager.appendMessage({
	role: "assistant",
	content: [{ type: "text", text: "Reset the arena before the retry and queued the fuzz corpus." }],
	api: "custom",
	provider: "local",
	model: "qwen2.5-1.5b",
	usage: {
		input: 210,
		output: 58,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 268,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: BASE + 500,
});

/** A finished background job, in the shape the job manager holds one. */
const finishedJob = (id: string, type: AsyncJobType, label: string): AsyncJob => ({
	id,
	type,
	status: "completed",
	startTime: BASE,
	label,
	abortController: new AbortController(),
	promise: Promise.resolve(),
});

const asyncResult = buildAsyncResultBatchMessage([
	{
		jobId: "bg_41",
		result: "3 files changed, 218 insertions(+), 41 deletions(-)",
		job: finishedJob("bg_41", "bash", "cargo check --workspace"),
		durationMs: 94_000,
	},
	{
		jobId: "bg_42",
		result: "ok",
		job: finishedJob("bg_42", "task", "parser reviewer"),
		durationMs: 312_000,
	},
]);
if (!asyncResult) throw new Error("the async batch built no message, so the frame states no finished job");
appendSide({ ...asyncResult, timestamp: BASE + 1_000 });

const advisorNotes = [
	{
		note: "The retry path re-enters the parser before the arena is reset, so a second failure reads freed spans.",
		severity: "blocker" as const,
		advisor: "reviewer",
	},
	{
		note: "State the bound in the doc comment; the constant alone does not.",
		severity: "nit" as const,
		advisor: "reviewer",
	},
];
appendSide({
	role: "custom",
	customType: "advisor",
	content: formatAdvisorBatchContent(advisorNotes),
	display: true,
	attribution: "agent",
	details: { notes: advisorNotes },
	timestamp: BASE + 2_000,
});

const spanRs = path.join(repoDir, "src", "span.rs");
const diagnostics = buildLateDiagnosticsBatchMessage([
	{
		path: spanRs,
		summary: "1 error, 1 warning",
		errored: true,
		messages: [
			`${spanRs}:88:12 [error] [rust-analyzer] borrow of moved value: \`arena\``,
			`${spanRs}:41:5 [warning] [rust-analyzer] unused variable: \`retry\``,
		],
		isStale: () => false,
	},
]);
if (!diagnostics) throw new Error("the diagnostics batch built no message, so the frame states no late error");
appendSide({ ...diagnostics, timestamp: BASE + 2_500 });

appendSide({
	role: "custom",
	customType: "irc:relay",
	content: "[IRC `ParserLane` → `ReviewLane`]\n\nArena reset moved ahead of the retry; re-read span.rs:88.",
	display: true,
	details: {
		from: "ParserLane",
		to: "ReviewLane",
		body: "Arena reset moved ahead of the retry; re-read span.rs:88.",
	},
	attribution: "agent",
	timestamp: BASE + 3_000,
});

appendSide({
	role: "custom",
	customType: COLLAB_PROMPT_MESSAGE_TYPE,
	content: "Hold the release until the arena fix has a regression test.",
	display: true,
	details: { from: "guest-2" },
	attribution: "user",
	timestamp: BASE + 4_000,
});

const skillDetails: SkillPromptDetails = {
	name: "regression-suite",
	path: path.join(repoDir, ".veyyon", "skills", "regression-suite", "SKILL.md"),
	args: "span arena reset",
	lineCount: 64,
};
appendSide({
	role: "custom",
	customType: SKILL_PROMPT_MESSAGE_TYPE,
	content: "Write the suite against the invariant, sweep the variant space, then mutate every branch.",
	display: true,
	details: skillDetails,
	attribution: "user",
	timestamp: BASE + 5_000,
});

const tanDetails: BackgroundTanDispatchDetails = {
	jobId: "tan_7",
	work: "Re-run the parser fuzz corpus against the reset ordering",
	sessionFile: path.join(repoDir, ".veyyon", "sessions", "tan_7.jsonl"),
};
appendSide({
	role: "custom",
	customType: BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
	content: "Dispatched tan_7 to re-run the parser fuzz corpus.",
	display: true,
	details: tanDetails,
	attribution: "agent",
	timestamp: BASE + 6_000,
});

appendSide({
	role: "custom",
	customType: "handoff",
	content: [
		"<handoff-context>",
		"Arena reset now precedes the retry in span.rs. The regression suite sweeps every",
		"parser entry point and fails on a new one. The fuzz corpus re-run is tan_7.",
		"</handoff-context>",
	].join("\n"),
	display: true,
	attribution: "agent",
	timestamp: BASE + 7_000,
});

const uncovered = CUSTOM_BLOCK_DISPLAY_VARIANTS.filter(variant => !seeded.has(variant));
if (uncovered.length > 0) {
	throw new Error(
		`no message here projects to ${uncovered.join(", ")}; add one per variant so the frame states every card`,
	);
}

// A user title is never overwritten by a generated one, so a re-seed leaves the
// same row for the scene to search for.
await sessionManager.setSessionName(SESSION_TITLE, "user");
await sessionManager.flush();

const sessionFile = sessionManager.getSessionFile();
const manifest = {
	id: sessionManager.getSessionId(),
	title: SESSION_TITLE,
	sessionFile,
	variants: [...CUSTOM_BLOCK_DISPLAY_VARIANTS],
};
fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
process.stdout.write(`seeded ${SESSION_TITLE} at ${sessionFile}\n`);
