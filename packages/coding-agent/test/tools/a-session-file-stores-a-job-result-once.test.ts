/**
 * WHY THIS SUITE EXISTS:
 *
 * A job tool result held its output twice: once in `content` as the text the model reads (with
 * resultText inside fenced code blocks and errorText following an Error: prefix), and again in
 * `details.jobs[i].resultText` and `details.jobs[i].errorText` for the card. Over local sessions,
 * job results accounted for ~100 MB of details bytes. The job result codec drops `resultText` and
 * `errorText` from the written line when the content text rebuilds them exactly (as spans of
 * content text), and restores them on load.
 *
 * CLASS: for every job result shape (single completed job, multi-job, failed job with errorText,
 * running/queued jobs), the session writes result and error text at most once and loads the details
 * byte-for-byte as the tool returned them, and the card drawn from the written form matches the card
 * drawn from the tool's original result. A result whose content no longer rebuilds the text (a prune
 * notice, replaced content) keeps its text on disk, and so does text shorter than the span tag
 * threshold. A line written before the codec existed loads unchanged.
 *
 * DOES NOT CATCH: jobs whose resultText or errorText was truncated or modified before being placed
 * in content text, which the codec safely leaves unslimmed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { getThemeByName, initTheme, type Theme } from "@veyyon/coding-agent/theme/theme";
import { MIN_CODED_TEXT } from "@veyyon/coding-agent/tools/core/output-notice";
import type { JobSnapshot, JobToolDetails } from "@veyyon/coding-agent/tools/shell/job";
import { jobResultCodec } from "@veyyon/coding-agent/tools/shell/job-result-codec";
import { jobToolView } from "@veyyon/coding-agent/tools/shell/job-view";
// Register all domain codecs through the composition root
import "@veyyon/coding-agent/tools/index";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { setAgentDir, TempDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";

function assistantCalling(ids: readonly string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map(id => ({ type: "toolCall", id, name: "job", arguments: { poll: ["bg_1"] } })),
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

/** Job details as a session file line holds them: a span stands in for each dropped text. */
type WrittenJobDetails = Omit<JobToolDetails, "jobs"> & {
	jobs: (JobSnapshot & { resultSpan?: [number, number]; errorSpan?: [number, number] })[];
};

function writtenDetails(file: string): Record<string, WrittenJobDetails> {
	const out: Record<string, WrittenJobDetails> = {};
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.includes('"toolResult"') || !line.includes('"toolName":"job"')) continue;
		const entry = JSON.parse(line) as { message: ToolResultMessage<WrittenJobDetails> };
		if (entry.message.details && entry.message.toolCallId) {
			out[entry.message.toolCallId] = entry.message.details;
		}
	}
	return out;
}

function loadedResults(manager: SessionManager): Record<string, ToolResultMessage<JobToolDetails>> {
	const out: Record<string, ToolResultMessage<JobToolDetails>> = {};
	for (const entry of manager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "toolResult") {
			out[entry.message.toolCallId] = entry.message as ToolResultMessage<JobToolDetails>;
		}
	}
	return out;
}

const LONG_RESULT = "Build succeeded with 0 errors and 0 warnings.\nGenerated 42 artifacts in dist/";
const LONG_ERROR = "Compilation failed: syntax error at line 45\nExpected semicolon, found identifier";
const SHORT_TEXT = "done (ok)";

function buildContent(jobs: readonly JobSnapshot[]): string {
	const lines = ["## Completed (1)\n"];
	for (const j of jobs) {
		lines.push(`### ${j.id} [${j.type}] — ${j.status}`);
		lines.push(`Label: ${j.label}`);
		if (j.resultText) {
			lines.push("```", j.resultText, "```");
		}
		if (j.errorText) {
			lines.push(`Error: ${j.errorText}`);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

describe("a session file stores a job result once", () => {
	let theme: Theme;
	let dirOverrides: DirOverridesSnapshot | undefined;
	let root: TempDir;

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("dark theme missing");
		theme = dark;
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	beforeEach(() => {
		dirOverrides = captureDirOverrides();
		root = TempDir.createSync("@pi-job-result-once-");
		setAgentDir(root.join("agent"));
	});

	afterEach(async () => {
		if (dirOverrides !== undefined) restoreDirOverrides(dirOverrides);
		dirOverrides = undefined;
		await root.remove();
	});

	async function record(results: readonly ToolResultMessage<JobToolDetails>[]): Promise<SessionManager> {
		const returned = results.map(result => JSON.stringify(result.details));
		const manager = SessionManager.create(root.path(), root.join("sessions"));
		manager.appendMessage(assistantCalling(results.map(r => r.toolCallId)));
		for (const result of results) manager.appendMessage(result);
		// Recording settles each result in place: the details the session holds read as the tool returned them.
		expect(results.map(result => JSON.stringify(result.details))).toEqual(returned);
		await manager.flush();
		return manager;
	}

	function draw(result: ToolResultMessage<JobToolDetails>, details: JobToolDetails): string {
		const view = jobToolView.renderResult({ content: result.content, details }, { expanded: true, partial: false });
		return Bun.stripANSI(drawToolView(view, theme).render(160).join("\n"));
	}

	it("drops resultText on disk when content matches, and restores it on load", async () => {
		const jobs: JobSnapshot[] = [
			{
				id: "bg_1",
				type: "bash",
				status: "completed",
				label: "cargo build",
				durationMs: 1200,
				resultText: LONG_RESULT,
			},
		];
		const contentText = buildContent(jobs);
		const result: ToolResultMessage<JobToolDetails> = {
			role: "toolResult",
			toolCallId: "call-job-result",
			toolName: "job",
			content: [{ type: "text", text: contentText }],
			details: { jobs },
			isError: false,
			timestamp: 2,
		};

		const manager = await record([result]);
		const file = manager.getSessionFile() as string;
		const written = writtenDetails(file);

		const diskDetails = written["call-job-result"];
		const diskJob = diskDetails?.jobs?.[0];
		expect(diskJob?.resultText).toBeUndefined();
		expect(contentText.slice(...(diskJob?.resultSpan ?? [0, 0]))).toBe(LONG_RESULT);

		const reopened = loadedResults(await SessionManager.open(file));
		const loaded = reopened["call-job-result"];
		expect(loaded?.details).toEqual(JSON.parse(JSON.stringify(result.details)));
		expect(loaded?.details?.jobs?.[0]?.resultText).toBe(LONG_RESULT);

		// View drawn from written form matches original
		expect(draw(result, diskDetails!)).toEqual(draw(result, result.details!));
	});

	it("drops errorText on disk when content matches, and restores it on load", async () => {
		const jobs: JobSnapshot[] = [
			{
				id: "bg_2",
				type: "bash",
				status: "failed",
				label: "cargo check",
				durationMs: 800,
				errorText: LONG_ERROR,
			},
		];
		const contentText = buildContent(jobs);
		const result: ToolResultMessage<JobToolDetails> = {
			role: "toolResult",
			toolCallId: "call-job-error",
			toolName: "job",
			content: [{ type: "text", text: contentText }],
			details: { jobs },
			isError: false,
			timestamp: 2,
		};

		const manager = await record([result]);
		const file = manager.getSessionFile() as string;
		const written = writtenDetails(file);

		const diskDetails = written["call-job-error"];
		const diskJob = diskDetails?.jobs?.[0];
		expect(diskJob?.errorText).toBeUndefined();
		expect(contentText.slice(...(diskJob?.errorSpan ?? [0, 0]))).toBe(LONG_ERROR);

		const reopened = loadedResults(await SessionManager.open(file));
		expect(reopened["call-job-error"]?.details).toEqual(JSON.parse(JSON.stringify(result.details)));
		expect(draw(result, diskDetails!)).toEqual(draw(result, result.details!));
	});

	it("handles multi-job results with both resultText and errorText", async () => {
		const jobs: JobSnapshot[] = [
			{
				id: "bg_1",
				type: "bash",
				status: "completed",
				label: "test 1",
				durationMs: 500,
				resultText: LONG_RESULT,
			},
			{
				id: "bg_2",
				type: "bash",
				status: "failed",
				label: "test 2",
				durationMs: 600,
				errorText: LONG_ERROR,
			},
		];
		const contentText = buildContent(jobs);
		const result: ToolResultMessage<JobToolDetails> = {
			role: "toolResult",
			toolCallId: "call-multi-job",
			toolName: "job",
			content: [{ type: "text", text: contentText }],
			details: { jobs },
			isError: false,
			timestamp: 2,
		};

		const manager = await record([result]);
		const file = manager.getSessionFile() as string;
		const written = writtenDetails(file);

		const diskDetails = written["call-multi-job"];
		const j1 = diskDetails?.jobs?.[0];
		const j2 = diskDetails?.jobs?.[1];
		expect(j1?.resultText).toBeUndefined();
		expect(j1?.resultSpan).toBeDefined();
		expect(j2?.errorText).toBeUndefined();
		expect(j2?.errorSpan).toBeDefined();

		const reopened = loadedResults(await SessionManager.open(file));
		expect(reopened["call-multi-job"]?.details).toEqual(JSON.parse(JSON.stringify(result.details)));
	});

	it("keeps text whole when content does not rebuild it", async () => {
		const jobs: JobSnapshot[] = [
			{
				id: "bg_1",
				type: "bash",
				status: "completed",
				label: "cargo build",
				durationMs: 1200,
				resultText: LONG_RESULT,
			},
		];
		const result: ToolResultMessage<JobToolDetails> = {
			role: "toolResult",
			toolCallId: "call-pruned-job",
			toolName: "job",
			content: [{ type: "text", text: "[Output pruned ~100 tokens]" }],
			details: { jobs },
			isError: false,
			timestamp: 2,
		};

		const manager = await record([result]);
		const file = manager.getSessionFile() as string;
		const written = writtenDetails(file);

		const diskDetails = written["call-pruned-job"];
		expect(diskDetails?.jobs?.[0]?.resultText).toBe(LONG_RESULT);
		expect(diskDetails?.jobs?.[0]?.resultSpan).toBeUndefined();

		const reopened = loadedResults(await SessionManager.open(file));
		expect(reopened["call-pruned-job"]?.details).toEqual(JSON.parse(JSON.stringify(result.details)));
	});

	it("keeps text whole when shorter than MIN_DROPPED_TEXT", async () => {
		expect(SHORT_TEXT.length).toBeLessThan(MIN_CODED_TEXT);
		const jobs: JobSnapshot[] = [
			{
				id: "bg_1",
				type: "bash",
				status: "completed",
				label: "quick task",
				durationMs: 100,
				resultText: SHORT_TEXT,
			},
		];
		const result: ToolResultMessage<JobToolDetails> = {
			role: "toolResult",
			toolCallId: "call-short-job",
			toolName: "job",
			content: [{ type: "text", text: buildContent(jobs) }],
			details: { jobs },
			isError: false,
			timestamp: 2,
		};

		const manager = await record([result]);
		const file = manager.getSessionFile() as string;
		const written = writtenDetails(file);

		const diskDetails = written["call-short-job"];
		expect(diskDetails?.jobs?.[0]?.resultText).toBe(SHORT_TEXT);
		expect(diskDetails?.jobs?.[0]?.resultSpan).toBeUndefined();

		const reopened = loadedResults(await SessionManager.open(file));
		expect(reopened["call-short-job"]?.details).toEqual(JSON.parse(JSON.stringify(result.details)));
	});

	it("leaves running jobs untouched", async () => {
		const jobs: JobSnapshot[] = [
			{
				id: "bg_run",
				type: "bash",
				status: "running",
				label: "daemon process",
				durationMs: 5000,
				queued: true,
			},
		];
		const result: ToolResultMessage<JobToolDetails> = {
			role: "toolResult",
			toolCallId: "call-running-job",
			toolName: "job",
			content: [{ type: "text", text: "## Still Running (1)\n- `bg_run` [bash] — daemon process" }],
			details: { jobs },
			isError: false,
			timestamp: 2,
		};

		const manager = await record([result]);
		const file = manager.getSessionFile() as string;
		const written = writtenDetails(file);

		const diskDetails = written["call-running-job"];
		expect(diskDetails?.jobs?.[0]).toEqual(jobs[0]);

		const reopened = loadedResults(await SessionManager.open(file));
		expect(reopened["call-running-job"]?.details).toEqual(JSON.parse(JSON.stringify(result.details)));
	});

	it("leaves in-memory details whole and never mutates input during slim", async () => {
		const jobs: JobSnapshot[] = [
			{
				id: "bg_1",
				type: "bash",
				status: "completed",
				label: "cargo build",
				durationMs: 1200,
				resultText: LONG_RESULT,
			},
		];
		const originalDetails: JobToolDetails = { jobs };
		const clone = JSON.parse(JSON.stringify(originalDetails));

		const result: ToolResultMessage<JobToolDetails> = {
			role: "toolResult",
			toolCallId: "call-job-immut",
			toolName: "job",
			content: [{ type: "text", text: buildContent(jobs) }],
			details: originalDetails,
			isError: false,
			timestamp: 2,
		};

		await record([result]);
		expect(originalDetails).toEqual(clone);
		expect(originalDetails.jobs[0].resultText).toBe(LONG_RESULT);
	});

	it("slim returns the exact same reference when nothing drops", () => {
		const details: JobToolDetails = {
			jobs: [
				{ id: "bg_1", type: "bash", status: "completed", label: "short", durationMs: 10, resultText: SHORT_TEXT },
			],
		};
		const slimmed = jobResultCodec.slim(details, [{ type: "text", text: buildContent(details.jobs) }]);
		expect(slimmed).toBe(details);
	});

	it("restore of details written whole is a no-op", () => {
		const wholeDetails: JobToolDetails = {
			jobs: [
				{ id: "bg_1", type: "bash", status: "completed", label: "whole", durationMs: 10, resultText: LONG_RESULT },
			],
		};
		const clone = JSON.parse(JSON.stringify(wholeDetails));
		jobResultCodec.restore(wholeDetails, [{ type: "text", text: buildContent(wholeDetails.jobs) }]);
		expect(wholeDetails).toEqual(clone);
	});
});
