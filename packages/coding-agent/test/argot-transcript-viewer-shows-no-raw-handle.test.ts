/**
 * WHY: the subagent dashboard's read-only transcript viewer was the one
 * display in the product that showed the model's raw `§handle` text. Every
 * other human-facing surface goes through `argot-wire.ts`, but this viewer
 * parses a subagent's or advisor's persisted `.jsonl` itself — precisely
 * because those are the two agents with no live session to hand the view over
 * to — and the persisted file deliberately keeps the cheap handles, which is
 * what makes replay cheap. So the viewer rendered exactly what was on disk.
 *
 * THE CLASS THIS CLOSES: a new place the model's text crosses out of its
 * history that does not route through the wire. The rule is that a raw handle
 * in any display, tool, transcript or parent return is a defect, and the
 * enforcement here is a NEGATIVE CONTROL: the same file rendered with the
 * expansion dep omitted must show the handle. A future refactor that drops the
 * dep, or forgets to pass it at a new mount site, fails on that pair rather
 * than passing because nothing was checked.
 *
 * Both builder feeds are swept. The full-load path and the append path reach
 * the builder through different code, and a fix applied to one and not the
 * other is the recurring shape of this defect (see the streaming preview seam).
 *
 * The user-message row is not decoration: `mapAgentMessageStrings` walks
 * model-authored strings only, so an operator who literally typed `§db` must
 * still see `§db`. A "fix" that expands everything would break that and is
 * caught here.
 *
 * WHAT IT DOES NOT CATCH: the collab-guest path, which reads the transcript on
 * the host and holds no codec locally, so a guest still sees whatever the host
 * wrote. That is a gap, not an oversight: expanding it needs the host's
 * dictionary on the wire.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandSessionMessageEntries } from "@veyyon/coding-agent/argot-wire";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AgentTranscriptViewer } from "@veyyon/coding-agent/modes/components/agent-transcript-viewer";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { CURRENT_SESSION_VERSION, type SessionMessageEntry } from "@veyyon/coding-agent/session/session-entries";
import { removeSyncWithRetries } from "@veyyon/utils";
import { ArgotSession, type Vocabulary } from "argot";

const TS = new Date().toISOString();
const HANDLE = "§db";
const EXPANSION = "src/db.ts";

function loadedCodec(): ArgotSession {
	const vocab: Vocabulary = {
		version: 1,
		sigil: "§",
		handles: new Map([["db", EXPANSION]]),
		meta: new Map(),
	};
	const codec = new ArgotSession();
	codec.loadVocab(vocab);
	return codec;
}

const USAGE = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantLine(id: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: TS,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "gpt-5.5",
			usage: USAGE,
			stopReason: "stop",
			timestamp: 0,
		},
	});
}

function userLine(id: string, content: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: TS,
		message: { role: "user", synthetic: true, attribution: "agent", content, timestamp: 0 },
	});
}

function makeViewer(file: string, expandArgot?: (e: SessionMessageEntry[]) => SessionMessageEntry[]) {
	const agents = new AgentRegistry();
	agents.register({
		id: "Main/advisor",
		displayName: "advisor",
		kind: "advisor",
		parentId: "Main",
		session: null,
		sessionFile: file,
		status: "parked",
	});
	return new AgentTranscriptViewer({
		agentId: "Main/advisor",
		registry: agents,
		ui: { requestRender: () => {}, requestComponentRender: () => {} } as never,
		cwd: "/repo",
		expandArgot,
		expandKeys: ["ctrl+o"],
		hubKeys: ["ctrl+s"],
		requestRender: () => {},
		onClose: () => {},
		onHubClose: () => {},
	});
}

describe("the transcript viewer shows no raw handle", () => {
	let dir: string;
	let file: string;
	let rowsDesc: PropertyDescriptor | undefined;

	const body = (viewer: AgentTranscriptViewer): string =>
		viewer
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		initTheme();
		rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => 40, set: () => {} });

		dir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-view-"));
		file = path.join(dir, "__advisor.jsonl");
		fs.writeFileSync(
			file,
			`${[
				JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: "adv",
					timestamp: TS,
					cwd: "/repo",
				}),
				assistantLine("a0", `opened ${HANDLE} to check it`),
			].join("\n")}\n`,
		);
	});

	afterEach(() => {
		if (rowsDesc) {
			Object.defineProperty(process.stdout, "rows", rowsDesc);
		} else {
			Object.defineProperty(process.stdout, "rows", { configurable: true, value: undefined, writable: true });
		}
		removeSyncWithRetries(dir);
	});

	it("expands a handle in the full-load path", () => {
		const codec = loadedCodec();
		const rendered = body(makeViewer(file, entries => expandSessionMessageEntries(codec, entries)));

		expect(rendered).toContain(`opened ${EXPANSION} to check it`);
		expect(rendered).not.toContain("§");
	});

	// The control. Without it the assertion above could pass because the frame
	// never carried the text at all, and a dropped dep would go unnoticed.
	it("leaks the handle when the expansion dep is not wired, which is the defect", () => {
		const rendered = body(makeViewer(file));

		expect(rendered).toContain(`opened ${HANDLE} to check it`);
	});

	it("expands a handle that arrives on the append path", async () => {
		const codec = loadedCodec();
		const viewer = makeViewer(file, entries => expandSessionMessageEntries(codec, entries));
		body(viewer);

		fs.appendFileSync(file, `${assistantLine("a1", `then ${HANDLE} again TAILMARK`)}\n`);

		const deadline = Date.now() + 5000;
		while (!body(viewer).includes("TAILMARK") && Date.now() < deadline) {
			await Bun.sleep(50);
		}
		const rendered = body(viewer);

		expect(rendered).toContain(`then ${EXPANSION} again TAILMARK`);
		expect(rendered).not.toContain("§");
	});

	it("leaves an operator's literal handle text alone", () => {
		// A user message is persisted verbatim and is never model-authored, so
		// expanding it would rewrite what the operator actually typed.
		fs.appendFileSync(file, `${userLine("u1", `I typed ${HANDLE} on purpose`)}\n`);
		const codec = loadedCodec();

		const rendered = body(makeViewer(file, entries => expandSessionMessageEntries(codec, entries)));

		expect(rendered).toContain(`I typed ${HANDLE} on purpose`);
	});

	it("is identity while no dictionary is loaded, so argot-off renders the file as written", () => {
		const codec = new ArgotSession();
		const rendered = body(makeViewer(file, entries => expandSessionMessageEntries(codec, entries)));

		expect(rendered).toContain(`opened ${HANDLE} to check it`);
	});
});
