/**
 * WHY: a session records the model it opens on as an entry of its own, and the
 * desktop drew it as a `Model: local/qwen2.5-1.5b` row above the first prompt
 * of every transcript, while the composer footer stated the same value below
 * it. The footer draws the model at every width by design, so the row said it
 * twice and said nothing the operator could not already read.
 *
 * CLASS CLOSED: a setting entry recorded before a session has said anything,
 * drawn as though it recorded a change. The variant space is the
 * `SessionEntry` union, swept from the fixture map, which the type checker
 * holds exhaustive: the suite pins by exact equality the set of kinds that read
 * differently ahead of the first message, so a second kind suppressed there
 * turns red until the decision is recorded, and so does a kind that stops
 * suppressing. Beside the sweep: the ordering as the desktop receives it,
 * through `LoadTranscript` over the socket, for each of the three shapes a
 * model entry takes; and the seam the live listeners convert through, where an
 * entry arrives one at a time with no list around it.
 *
 * NOT CAUGHT: the desktop's own drawing of the blocks it is handed, and the
 * thinking level and the mode, which are reached through the command surface
 * and drawn nowhere at rest, so their entries draw on either side of the first
 * message.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { type GuiHostServer, startGuiHostServer, type TranscriptEntry } from "../../src/gui-host";
import {
	appendedEntryToTranscriptEntry,
	type FirstMessagePosition,
	seedFirstMessagePosition,
	sessionEntryToTranscriptEntry,
} from "../../src/gui-host/transcript-conversion";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { snapshotSections, TestSocketClient } from "./test-client";
import { EXHAUSTIVE_FIXTURES, FIXTURE_TIMESTAMP } from "./transcript-conversion-fixtures";

/** The kinds whose blocks read differently ahead of the session's first message. */
const SUPPRESSED_BEFORE_THE_FIRST_MESSAGE = ["model_change"];

/** A user message, so everything after it sits inside a conversation. */
const PROMPT = "run the verification workflow";

interface ActiveSessionValue {
	id: string;
}

interface SessionRow {
	id: string;
	path?: string;
}

describe("the state a session opened in", () => {
	test("only the model reads differently ahead of the first message", () => {
		// The fixture map is `satisfies Record<SessionEntry["type"], ...>`, so
		// this sweep is the union: a kind added to it appears here without an
		// edit, and a kind added to the union without a fixture fails the type
		// check over there.
		const differs: string[] = [];
		for (const [kind, fixture] of Object.entries(EXHAUSTIVE_FIXTURES)) {
			const inside = sessionEntryToTranscriptEntry(fixture.entry, 1, { beforeFirstMessage: false });
			const opening = sessionEntryToTranscriptEntry(fixture.entry, 1, { beforeFirstMessage: true });
			expect(inside.content).toEqual(fixture.expectedContent);
			if (JSON.stringify(opening.content) !== JSON.stringify(inside.content)) differs.push(kind);
		}
		expect(differs).toEqual(SUPPRESSED_BEFORE_THE_FIRST_MESSAGE);
	});

	test("a suppressed entry keeps its identity, its place and its record", () => {
		// It draws nothing; it is still an entry, and the ledger the desktop
		// files it under, the audit copy and the parent chain are what a later
		// reload and an export read.
		const entry = EXHAUSTIVE_FIXTURES.model_change.entry;
		const converted = sessionEntryToTranscriptEntry(entry, 7, { beforeFirstMessage: true });
		expect(converted.content).toEqual([]);
		expect(converted.id).toBe(entry.id);
		expect(converted.parent).toBe(entry.parentId ?? null);
		expect(converted.revision).toBe(7);
		expect(converted.raw_discriminator).toBe("model_change");
		expect(converted.raw).toBe(entry);
	});
});

describe("the seam a live entry converts through", () => {
	/** A model entry, which is the kind the position decides. */
	function modelChange(id: string): SessionEntry {
		return {
			type: "model_change",
			id,
			parentId: null,
			timestamp: FIXTURE_TIMESTAMP,
			model: "anthropic/claude-3-7-sonnet",
			role: "default",
		};
	}

	const message: SessionEntry = EXHAUSTIVE_FIXTURES.message.entry;

	test("a session attached with nothing said yet suppresses, and the first message ends it", () => {
		const position: FirstMessagePosition = {};
		seedFirstMessagePosition(position, []);
		expect(appendedEntryToTranscriptEntry(position, modelChange("m-1"), 1).content).toEqual([]);

		expect(appendedEntryToTranscriptEntry(position, message, 2).content).toEqual(
			EXHAUSTIVE_FIXTURES.message.expectedContent,
		);
		expect(appendedEntryToTranscriptEntry(position, modelChange("m-2"), 3).content).toEqual([
			{ ModelChange: { provider: "anthropic", model: "claude-3-7-sonnet" } },
		]);
	});

	test("a session attached with a conversation behind it draws the change it is handed", () => {
		// A model changed mid-session arrives on this path, and the session it
		// arrives for was attached with its messages already on disk: the flag
		// is read off those entries, not from what this connection has seen.
		const position: FirstMessagePosition = {};
		seedFirstMessagePosition(position, [modelChange("m-0"), message]);
		expect(appendedEntryToTranscriptEntry(position, modelChange("m-1"), 1).content).toEqual([
			{ ModelChange: { provider: "anthropic", model: "claude-3-7-sonnet" } },
		]);
	});
});

describe("the transcript the desktop is sent", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-opening-state-"));
		await fs.writeFile(path.join(tempDir, "config.yml"), "modelRoles:\n  default: openai/gpt-4o-mini\n", "utf8");
		const authStorage = await isolatedAuthStorage(tempDir);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
		});
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

	/**
	 * A session the host created, evicted from memory, then written to on disk
	 * by `write`. Evicted, because a transcript the desktop asks for is read
	 * from the file, and this is the path that reads it.
	 */
	async function sessionWritten(write: (sm: SessionManager) => void): Promise<string> {
		const created = await client.request(1, { CreateSession: {} });
		const active = snapshotSections<{ revision: number; value: ActiveSessionValue }>(
			created.frames,
			"ActiveSession",
		).at(-1);
		if (!active) throw new Error("CreateSession emitted no ActiveSession");
		const session = active.value.id;
		const listed = snapshotSections<[{ revision: number; value: SessionRow[] }, unknown[]]>(
			created.frames,
			"Sessions",
		).at(-1)?.[0].value;
		const file = listed?.find(row => row.id === session)?.path;
		if (!file) throw new Error("CreateSession listed no path for the session it created");

		await client.request(2, { CreateSession: {} });
		const sm = await SessionManager.open(file);
		write(sm);
		await sm.flushSync();
		return session;
	}

	/** The transcript the host sends for `session`. */
	async function transcriptOf(session: string, request: number): Promise<TranscriptEntry[]> {
		const loaded = await client.request(request, { LoadTranscript: { session, before: null } });
		expect(loaded.outcome).toEqual({ RequestSucceeded: { request } });
		const entries = snapshotSections<{ revision: number; value: TranscriptEntry[] }>(loaded.frames, "Transcript").at(
			-1,
		)?.value;
		if (!entries) throw new Error("LoadTranscript carried no transcript");
		return entries;
	}

	/** The model entries in `entries`, in the order the session recorded them. */
	function modelRows(entries: TranscriptEntry[]): TranscriptEntry[] {
		return entries.filter(entry => entry.raw_discriminator === "model_change");
	}

	for (const [shape, model, role, drawn] of [
		[
			"a provider and a model",
			"anthropic/claude-3-7-sonnet",
			"default",
			{ ModelChange: { provider: "anthropic", model: "claude-3-7-sonnet" } },
		],
		["a model with no provider", "gpt-4o", "default", { Text: { text: "model: gpt-4o" } }],
		[
			"a routing role of its own",
			"anthropic/claude-3-7-sonnet",
			"title",
			{ Text: { text: "title model: anthropic/claude-3-7-sonnet" } },
		],
	] as const) {
		test(`a model stated as ${shape} draws once it is a change and not before`, async () => {
			// One transcript carrying both positions, in the order a session
			// records them: what it opened on, the prompt, then a change.
			const session = await sessionWritten(sm => {
				sm.appendModelChange(model, role);
				sm.appendMessage({ role: "user", timestamp: Date.now(), content: PROMPT });
				sm.appendModelChange(model, role);
			});
			const entries = await transcriptOf(session, 3);
			const rows = modelRows(entries);
			expect(rows.length).toBe(2);
			expect(rows[0].content).toEqual([]);
			expect(rows[1].content).toEqual([drawn]);
			// And the conversation itself is untouched by the rule.
			expect(entries.find(entry => entry.role === "User")?.content).toEqual([{ Text: { text: PROMPT } }]);
		});
	}

	test("a session that opened on a model and never said anything draws no row for it", async () => {
		const session = await sessionWritten(sm => {
			sm.appendModelChange("anthropic/claude-3-7-sonnet", "default");
			sm.appendThinkingLevelChange("high");
			sm.appendModeChange("plan");
		});
		const entries = await transcriptOf(session, 3);
		expect(modelRows(entries).map(entry => entry.content)).toEqual([[]]);
		// The two settings the surface states nowhere at rest still draw, on
		// either side of a first message that never arrived.
		expect(entries.find(entry => entry.raw_discriminator === "thinking_level_change")?.content).toEqual([
			{ ThinkingChange: { level: "high" } },
		]);
		expect(entries.find(entry => entry.raw_discriminator === "mode_change")?.content).toEqual([
			{ Text: { text: "mode: plan" } },
		]);
	});
});
