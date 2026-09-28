/**
 * WHY: the terminal's status line states seven facts the window had no
 * section for: the machine the host runs on, the branch and pull request of
 * the session's checkout, how long the agent has worked, how fast it replies,
 * the login serving the session and that login's quota. A window attached to
 * the host showed none of them.
 *
 * CLASS CLOSED: a status fact the host holds and never states, or states once
 * and never again after it moves. Each section is driven through the socket
 * the way a window reaches it: attaching states the machine, opening a
 * session states its checkout, a real turn states the pace while it runs and
 * the settled pace, the serving login and a re-read checkout when it ends.
 * The pace is pinned to its rate bound, so a pace written per streamed token
 * fails here.
 *
 * NOT CAUGHT: how the window draws any of it, and a quota a real provider
 * endpoint reports; the endpoint is replaced by a fixed usage report.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AssistantMessage, AuthStorage, UsageReport } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { PACE_INTERVAL_MS } from "../../src/gui-host/status-bridge";
import type { CheckoutView, HostView, PaceView, QuotaView, ServingAccountView } from "../../src/gui-host/wire";
import { AgentSession } from "../../src/session/agent-session";
import * as git from "../../src/utils/git";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

/** Deltas in one reply; a pace written per delta would be this many frames. */
const DELTAS = 40;
/** The gap between two deltas, so the reply spans several pace intervals. */
const DELTA_GAP_MS = 15;
/** What the finished reply reports: 50 tokens in 500 ms is 100.0 tokens a second. */
const REPLY_TOKENS = 50;
const REPLY_DURATION_MS = 500;

const PULL_REQUEST = { number: 42, url: "https://example.invalid/pull/42" };

interface SessionScoped<T> {
	session: string;
	[field: string]: T | string | null;
}

function assistantMessage(text: string, output: number, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-chat",
		provider: "openai",
		model: "gpt-4o-mini",
		stopReason: "stop",
		usage: {
			input: 10,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10 + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	};
}

/**
 * A reply streamed over `DELTAS * DELTA_GAP_MS`, as a provider paces one. A
 * reply given no `duration` is one whose provider reported none.
 */
function pacedStream(duration: number | undefined): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const startedAt = Date.now();
	void (async () => {
		let text = "";
		const opening = assistantMessage("", 0, startedAt);
		stream.push({ type: "start", partial: { ...opening, content: [] } });
		stream.push({ type: "text_start", contentIndex: 0, partial: opening });
		for (let delta = 0; delta < DELTAS; delta++) {
			await sleep(DELTA_GAP_MS);
			text += `token${delta} `;
			stream.push({
				type: "text_delta",
				contentIndex: 0,
				delta: `token${delta} `,
				partial: assistantMessage(text, delta + 1, startedAt),
			});
		}
		const finished = assistantMessage(text, REPLY_TOKENS, startedAt);
		const done = duration === undefined ? finished : { ...finished, duration };
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: done });
		stream.push({ type: "done", reason: "stop", message: done });
	})();
	return stream;
}

function usageReport(resetsAt: number): UsageReport {
	return {
		provider: "openai",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "5h",
				label: "5 Hour",
				scope: { provider: "openai", windowId: "5h", tier: "plus" },
				window: { id: "5h", label: "5 Hour", resetsAt },
				amount: { usedFraction: 0.805, unit: "percent" },
			},
		],
	};
}

function sectionsOf<T>(frames: RequestFrame[], section: string, session: string, field: string): T[] {
	return snapshotSections<SessionScoped<T>>(frames, section)
		.filter(value => value.session === session)
		.map(value => value[field] as T);
}

describe("a window is told the status-line facts of the session it holds", () => {
	let tempDir: string;
	let repoDir: string;
	let authStorage: AuthStorage;
	let credential: number;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;

	/** Read frames after `seen` until `done` holds of all of them. */
	async function readUntil(seen: RequestFrame[], done: (frames: RequestFrame[]) => boolean): Promise<RequestFrame[]> {
		const frames = [...seen];
		while (!done(frames)) frames.push((await client.nextFrame()) as RequestFrame);
		return frames;
	}

	/** Create a session; its id and the frames the request produced. */
	async function createSession(id: number): Promise<{ session: string; created: RequestFrame[] }> {
		const { frames } = await client.request(id, { CreateSession: {} });
		const header = snapshotSections<{ value: { id: string } }>(frames, "ActiveSession").at(-1);
		if (!header) throw new Error("CreateSession stated no ActiveSession");
		return { session: header.value.id, created: frames };
	}

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-status-line-"));
		repoDir = path.join(tempDir, "repo");
		await fs.mkdir(repoDir);
		const run = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
		run("init", "-q", "-b", "feature/status");
		await fs.writeFile(path.join(repoDir, "README"), "status\n", "utf8");
		run("add", "README");
		run("-c", "user.name=Status", "-c", "user.email=status@example.invalid", "commit", "-q", "-m", "init");

		await fs.writeFile(path.join(tempDir, "config.yml"), "modelRoles:\n  default: openai/gpt-4o-mini\n", "utf8");
		authStorage = await isolatedAuthStorage(tempDir);
		const [stored] = authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		if (!stored) throw new Error("the credential was not stored");
		credential = stored.id;
		authStorage.setAccountName("openai", credential, "work");
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: repoDir, agentDir: tempDir, authStorage });
		client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		client.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("attaching states the machine the host runs on", async () => {
		const { frames } = await client.request(1, "Attach");
		expect(snapshotSections<HostView>(frames, "Host")).toEqual([{ hostname: os.hostname() }]);
	});

	test("a session's checkout, login and quota reach the window and follow each turn", async () => {
		const gh = vi.spyOn(git.github, "run").mockResolvedValue({
			exitCode: 0,
			stdout: JSON.stringify(PULL_REQUEST),
			stderr: "",
		});
		const resetsIn = 30 * 60_000;
		vi.spyOn(AgentSession.prototype, "fetchUsageReports").mockImplementation(async () => [
			usageReport(Date.now() + resetsIn),
		]);
		vi.spyOn(ai, "streamSimple").mockImplementation(() => pacedStream(REPLY_DURATION_MS));
		const { session, created } = await createSession(1);

		// Opening the session states its checkout: the branch, a clean tree,
		// and the pull request `gh` reports for it.
		const opened = await readUntil(created, frames => sectionsOf(frames, "Checkout", session, "checkout").length > 0);
		expect(sectionsOf<CheckoutView>(opened, "Checkout", session, "checkout")).toEqual([
			{ branch: "feature/status", dirty: false, pull_request: PULL_REQUEST },
		]);

		// A file the turn leaves behind makes the tree dirty; the turn's end
		// re-reads the checkout.
		await fs.writeFile(path.join(repoDir, "notes.txt"), "left behind\n", "utf8");
		const turnStarted = Date.now();
		const submitted = await client.request(2, { SubmitPrompt: { session, text: "pace it", attachments: [] } });
		const turn = await readUntil(
			submitted.frames,
			frames =>
				sectionsOf<CheckoutView>(frames, "Checkout", session, "checkout").some(checkout => checkout.dirty) &&
				sectionsOf(frames, "Quota", session, "quota").length > 0,
		);
		const turnEnded = Date.now();

		expect(sectionsOf<CheckoutView>(turn, "Checkout", session, "checkout").at(-1)).toEqual({
			branch: "feature/status",
			dirty: true,
			pull_request: PULL_REQUEST,
		});
		expect(sectionsOf<ServingAccountView>(turn, "ServingAccount", session, "account").at(-1)).toEqual({
			provider: "openai",
			label: "work",
			logins: 1,
			predicted: false,
		});
		const quota = sectionsOf<QuotaView>(turn, "Quota", session, "quota").at(-1);
		expect(quota?.tier).toBe("plus");
		expect(quota?.seven_day).toBeNull();
		expect(quota?.five_hour?.used_permille).toBe(805);
		expect(quota?.five_hour?.resets_at_ms).toBeGreaterThanOrEqual(turnStarted + resetsIn - 60_000);
		expect(quota?.five_hour?.resets_at_ms).toBeLessThanOrEqual(turnEnded + resetsIn + 60_000);

		// A login renamed between turns is stated under its new name when the
		// next turn ends.
		authStorage.setAccountName("openai", credential, "home");
		const again = await client.request(3, { SubmitPrompt: { session, text: "pace it again", attachments: [] } });
		const second = await readUntil(again.frames, frames =>
			sectionsOf<ServingAccountView>(frames, "ServingAccount", session, "account").some(
				account => account?.label === "home",
			),
		);
		expect(sectionsOf<ServingAccountView>(second, "ServingAccount", session, "account").at(-1)).toEqual({
			provider: "openai",
			label: "home",
			logins: 1,
			predicted: false,
		});

		// A model on another provider is served by that provider's login, and
		// the selection states it without waiting for a turn.
		const [other] = authStorage.upsertCredential("anthropic", { type: "api_key", key: "test-anthropic-key" });
		if (!other) throw new Error("the second credential was not stored");
		authStorage.setAccountName("anthropic", other.id, "other");
		const selected = await client.request(4, { SelectModel: { provider: "anthropic", model: "claude-sonnet-4-5" } });
		expect(selected.outcome).toEqual({ RequestSucceeded: { request: 4 } });
		expect(
			sectionsOf<ServingAccountView>(selected.frames, "ServingAccount", session, "account").at(-1),
		).toMatchObject({
			provider: "anthropic",
			label: "other",
			logins: 1,
		});
		// A branch's pull request is looked up once, not once per turn.
		expect(gh).toHaveBeenCalledTimes(1);
	}, 30_000);

	test("the pace moves at most once an interval while a reply streams and settles when the turn ends", async () => {
		vi.spyOn(git.github, "run").mockResolvedValue({ exitCode: 1, stdout: "", stderr: "" });
		vi.spyOn(AgentSession.prototype, "fetchUsageReports").mockResolvedValue(null);
		let replyDuration: number | undefined;
		vi.spyOn(ai, "streamSimple").mockImplementation(() => pacedStream(replyDuration));
		const { session } = await createSession(1);
		const paceOf = (frames: RequestFrame[]) => sectionsOf<PaceView>(frames, "Pace", session, "pace");

		// The first reply reports no duration, so while the next one streams
		// its rate is read against the clock and moves on every delta: a pace
		// written per delta would be one frame per token.
		const firstStarted = Date.now();
		const first = await client.request(2, { SubmitPrompt: { session, text: "pace it", attachments: [] } });
		const firstTurn = await readUntil(first.frames, frames =>
			paceOf(frames).some(pace => pace.working_since_ms === null && pace.worked_ms > 0),
		);
		expect(paceOf(firstTurn).at(-1)?.tokens_per_second_tenths).toBeNull();

		replyDuration = REPLY_DURATION_MS;
		const secondStarted = Date.now();
		const second = await client.request(3, { SubmitPrompt: { session, text: "pace it again", attachments: [] } });
		const secondTurn = await readUntil(second.frames, frames =>
			paceOf(frames).some(pace => pace.working_since_ms === null && pace.tokens_per_second_tenths !== null),
		);
		const secondEnded = Date.now();
		const paces = paceOf(secondTurn);
		const streaming = paces.filter(pace => pace.working_since_ms !== null);

		// While the reply streams the pace holds the epoch the working window
		// opened, inside the turn, so the window counts the time itself, and
		// the rate it states did move.
		expect(streaming[0]?.working_since_ms).toBeGreaterThanOrEqual(secondStarted);
		expect(streaming[0]?.working_since_ms).toBeLessThanOrEqual(secondEnded);
		expect(new Set(streaming.map(pace => pace.tokens_per_second_tenths)).size).toBeGreaterThan(1);

		// At most one pace per interval the turn spanned, plus the turn's start
		// and its end. One per streamed token would be `DELTAS` of them.
		expect(paces.length).toBeLessThanOrEqual(Math.ceil((secondEnded - secondStarted) / PACE_INTERVAL_MS) + 2);
		expect(paces.length).toBeLessThan(DELTAS / 2);

		// The settled pace holds both turns' working time and the rate the
		// finished reply reports.
		const settled = paces.at(-1);
		expect(settled?.working_since_ms).toBeNull();
		expect(settled?.tokens_per_second_tenths).toBe((REPLY_TOKENS * 1000 * 10) / REPLY_DURATION_MS);
		expect(settled?.worked_ms).toBeGreaterThanOrEqual(2 * (DELTAS - 1) * DELTA_GAP_MS);
		expect(settled?.worked_ms).toBeLessThanOrEqual(secondEnded - firstStarted);
	}, 30_000);
});
