/**
 * Tests for the argot codec (the `argot` package) and its veyyon wire glue: the
 * session lifecycle as veyyon drives it (loaded from a parsed vocabulary, the same
 * way loadArgotFolder arms a session), expansion at the tool-argument and
 * assistant-content seams (the same seams the secret codec uses for
 * deobfuscation), and the independent argotPreamble/argotHandles system-prompt
 * injection. The generated-cache load path itself lives in argot-cache.test.ts.
 *
 * These certify the codec MECHANISM is lossless and total at every boundary. They
 * are necessary but not sufficient for "argot works": whether a real model adopts
 * handles and nets a token saving is an economic truth only the live bench can
 * certify (see BACKLOG task 9). Green here means "when adoption happens, savings
 * are real and safe", not "adoption happens".
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { createArgotSession } from "@veyyon/coding-agent/argot-cache";
import { expandAssistantContent, expandSessionContext, expandToolArguments } from "@veyyon/coding-agent/argot-wire";
import type { SessionContext } from "@veyyon/coding-agent/session/session-context";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";
import { ArgotLoadTool, ArgotUnloadTool } from "@veyyon/coding-agent/tools/argot";
import { ArgotParseError, ArgotSession, DICT_FILENAME, parseDict, renderPreamble } from "argot";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";
import { makeToolSession } from "./helpers/tool-session";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

const DICT = `
version = 1

[handles]
dbconn = "postgres://prod-primary.internal:5432/orders"
db = "the orders database"
svc = "the checkout service"
`;

const DICT_SOURCE = `/repo/${DICT_FILENAME}`;

function armedSession(): ArgotSession {
	const argot = new ArgotSession();
	argot.loadVocab(parseDict(DICT, DICT_SOURCE));
	expect(argot.loaded).toBe(true);
	return argot;
}

describe("ArgotSession lifecycle", () => {
	it("exposes the fixed notation preamble whether or not a vocabulary is loaded", () => {
		const argot = new ArgotSession();
		expect(argot.preamble.length).toBeGreaterThan(0);
		expect(argot.loaded).toBe(false);
	});

	it("is identity expansion until a vocabulary is loaded", () => {
		const argot = new ArgotSession();
		expect(argot.expand("connect to §dbconn now")).toBe("connect to §dbconn now");
	});

	it("arms on loadVocab and expands known handles", () => {
		const argot = armedSession();
		expect(argot.loaded).toBe(true);
		expect(argot.expand("open §dbconn")).toBe("open postgres://prod-primary.internal:5432/orders");
	});

	it("prefers the longest matching handle name", () => {
		// §dbconn must win over §db even though §db is also defined.
		const argot = armedSession();
		expect(argot.expand("§dbconn")).toBe("postgres://prod-primary.internal:5432/orders");
		expect(argot.expand("§db")).toBe("the orders database");
	});

	it("leaves an unknown handle-name suffix untouched", () => {
		// §dbextra is not a handle; the boundary guard must not expand §db inside it.
		const argot = armedSession();
		expect(argot.expand("§dbextra")).toBe("§dbextra");
	});

	it("fails loud on a malformed dictionary instead of arming an empty codec", () => {
		// parseDict is the gate veyyon runs before loadVocab; a malformed cache must throw.
		expect(() => parseDict("version = 1\n", DICT_SOURCE)).toThrow(ArgotParseError);
	});
});

describe("expandToolArguments", () => {
	it("expands handles in nested tool-call JSON strings", () => {
		const argot = armedSession();
		const args = {
			command: "psql §dbconn -c 'select 1'",
			nested: { note: "restart §svc", list: ["ping §db", 42, true, null] },
		};
		const out = expandToolArguments(argot, args);
		expect(out.command).toBe("psql postgres://prod-primary.internal:5432/orders -c 'select 1'");
		expect((out.nested as { note: string }).note).toBe("restart the checkout service");
		expect((out.nested as { list: unknown[] }).list).toEqual(["ping the orders database", 42, true, null]);
	});

	it("returns the same reference when the session is not yet loaded", () => {
		const argot = new ArgotSession();
		const args = { command: "psql §dbconn" };
		expect(expandToolArguments(argot, args)).toBe(args);
	});

	it("returns the same reference when no handle is present", () => {
		const argot = armedSession();
		const args = { command: "ls -la" };
		expect(expandToolArguments(argot, args)).toBe(args);
	});

	it("expands adjacent handles with no separator, longest name first", () => {
		// §db then §svc back to back; the boundary guard must not read across them.
		const argot = armedSession();
		const out = expandToolArguments(argot, { note: "§db§svc" });
		expect(out.note).toBe("the orders databasethe checkout service");
	});

	it("expands handles at the very start and end of a string", () => {
		const argot = armedSession();
		const out = expandToolArguments(argot, { note: "§svc runs §dbconn" });
		expect(out.note).toBe("the checkout service runs postgres://prod-primary.internal:5432/orders");
	});

	it("expands many handles in one string", () => {
		const argot = armedSession();
		const out = expandToolArguments(argot, { note: "§db §svc §db §svc §dbconn" });
		expect(out.note).toBe(
			"the orders database the checkout service the orders database the checkout service postgres://prod-primary.internal:5432/orders",
		);
	});

	it("leaves an unknown handle untouched while expanding a known one beside it", () => {
		const argot = armedSession();
		const out = expandToolArguments(argot, { note: "§unknown then §svc" });
		expect(out.note).toBe("§unknown then the checkout service");
	});

	it("is idempotent: a second expansion is a no-op because expansions carry no sigil", () => {
		const argot = armedSession();
		const once = expandToolArguments(argot, { note: "restart §svc at §dbconn" });
		const twice = expandToolArguments(argot, once);
		expect(twice).toEqual(once);
	});

	it("walks deeply nested arrays and objects, preserving non-string scalars", () => {
		const argot = armedSession();
		const args = {
			plan: {
				steps: [
					{ run: "psql §dbconn", retries: 3, critical: true },
					{ run: "ping §svc", retries: 0, critical: false, skip: null },
				],
				tags: ["§db", "unrelated"],
			},
		};
		const out = expandToolArguments(argot, args) as typeof args;
		expect(out.plan.steps[0].run).toBe("psql postgres://prod-primary.internal:5432/orders");
		expect(out.plan.steps[0].retries).toBe(3);
		expect(out.plan.steps[0].critical).toBe(true);
		expect(out.plan.steps[1].run).toBe("ping the checkout service");
		expect(out.plan.steps[1].skip).toBeNull();
		expect(out.plan.tags).toEqual(["the orders database", "unrelated"]);
	});
});

describe("expandAssistantContent", () => {
	function content(): AssistantMessage["content"] {
		return [
			{ type: "text", text: "I will connect to §dbconn and restart §svc." },
			{
				type: "toolCall",
				id: "call_1",
				name: "bash",
				arguments: { command: "psql §dbconn" },
				intent: "query §db",
			},
		] as AssistantMessage["content"];
	}

	it("expands handles in text and tool-call arguments/intent", () => {
		const argot = armedSession();
		const out = expandAssistantContent(argot, content());
		const text = out[0];
		const call = out[1];
		expect(text.type === "text" && text.text).toBe(
			"I will connect to postgres://prod-primary.internal:5432/orders and restart the checkout service.",
		);
		expect(call.type === "toolCall" && (call.arguments as { command: string }).command).toBe(
			"psql postgres://prod-primary.internal:5432/orders",
		);
		expect(call.type === "toolCall" && call.intent).toBe("query the orders database");
	});

	it("returns the same reference when the session is not yet loaded", () => {
		const argot = new ArgotSession();
		const original = content();
		expect(expandAssistantContent(argot, original)).toBe(original);
	});
});

describe("expandSessionContext", () => {
	function sessionContext(): SessionContext {
		const messages: AgentMessage[] = [
			// User/tool-result messages are persisted raw and must never be walked.
			{ role: "user", content: "leave §dbconn alone in my raw message", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "connecting to §dbconn" }],
				api: "test",
				provider: "test",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
			{ role: "branchSummary", summary: "abandoned work on §svc", fromId: "x", timestamp: 3 },
			{
				role: "compactionSummary",
				summary: "compacted §db work",
				shortSummary: "§db",
				tokensBefore: 0,
				timestamp: 4,
			},
		];
		return { messages } as SessionContext;
	}

	it("expands handles in assistant content and model-written summaries, sparing raw user text", () => {
		const argot = armedSession();
		const out = expandSessionContext(argot, sessionContext());
		const [user, assistant, branch, compaction] = out.messages;
		// The user's raw message is never walked: the literal handle survives.
		expect(user).toEqual({ role: "user", content: "leave §dbconn alone in my raw message", timestamp: 1 });
		expect(assistant.role === "assistant" && (assistant.content[0] as { text: string }).text).toBe(
			"connecting to postgres://prod-primary.internal:5432/orders",
		);
		expect((branch as { summary: string }).summary).toBe("abandoned work on the checkout service");
		expect((compaction as { summary: string; shortSummary?: string }).summary).toBe(
			"compacted the orders database work",
		);
		expect((compaction as { summary: string; shortSummary?: string }).shortSummary).toBe("the orders database");
	});

	it("returns the same reference when the session is not yet loaded", () => {
		const argot = new ArgotSession();
		const original = sessionContext();
		expect(expandSessionContext(argot, original)).toBe(original);
	});
});

const HANDLE_TABLE =
	"## Project shorthand (Argot)\n\nUse handles.\n\n- `§dbconn` → `postgres://prod-primary.internal:5432/orders`\n";

const NOTATION_PREAMBLE = renderPreamble({ tools: true });

describe("argot preamble and handle-table injection into the system prompt", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-argot-prompt-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-argot-prompt-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	const baseOptions = () => ({
		cwd: tempDir,
		contextFiles: [],
		skills: [],
		rules: [],
		toolNames: [],
		workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
	});

	it("injects the handle table when argotHandles is passed", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			...baseOptions(),
			argotPreamble: NOTATION_PREAMBLE,
			argotHandles: HANDLE_TABLE,
		});
		expect(systemPrompt).toContain(HANDLE_TABLE);
		expect(systemPrompt).toContain(NOTATION_PREAMBLE);
	});

	it("injects handles independently of the preamble (handles without preamble)", async () => {
		// The two params are independent: a handle table alone still appears, and
		// no notation/tool preamble is invented from thin air.
		const { systemPrompt } = await buildSystemPrompt({
			...baseOptions(),
			argotPreamble: undefined,
			argotHandles: HANDLE_TABLE,
		});
		// Handles alone still appear — they are independent of the preamble flag.
		expect(systemPrompt).toContain(HANDLE_TABLE);
		expect(systemPrompt.join("\n\n")).not.toContain("argot_load(folder_path)");
	});

	it("injects the preamble WITHOUT handles when only argotPreamble is passed (unarmed-but-can-encode)", async () => {
		// The unarmed state: the model is taught the notation and told to call
		// argot_load, but no project handle table is present yet. (The preamble itself
		// may mention `§dbconn` as a notation example — that is not a taught handle.)
		const { systemPrompt } = await buildSystemPrompt({
			...baseOptions(),
			argotPreamble: NOTATION_PREAMBLE,
			argotHandles: undefined,
		});
		const joined = systemPrompt.join("\n\n");
		expect(systemPrompt).toContain(NOTATION_PREAMBLE);
		expect(joined).toContain("argot_load(folder_path)");
		expect(systemPrompt).not.toContain(HANDLE_TABLE);
		expect(joined).not.toContain("postgres://prod-primary.internal:5432/orders");
	});

	it("injects neither preamble nor handles when both are undefined", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			...baseOptions(),
			argotPreamble: undefined,
			argotHandles: undefined,
		});
		const joined = systemPrompt.join("\n\n");
		expect(joined).not.toContain("Project shorthand (Argot)");
		expect(joined).not.toContain("argot_load(folder_path)");
		expect(joined).not.toContain(HANDLE_TABLE);
	});
});

describe("createArgotSession starts unarmed (agent-driven loading)", () => {
	it("returns an unarmed top-level session whose expand is identity until a load", () => {
		// Loading is agent-driven: createArgotSession never arms from cwd. An
		// unarmed session is fully correct — expansion is identity, so nothing
		// decodes wrong and nothing leaks.
		const session = createArgotSession({
			enabled: true,
			isSubagent: false,
			subagentMode: "off",
		});
		expect(session).toBeDefined();
		expect(session!.loaded).toBe(false);
		expect(session!.expand("open §dbconn now")).toBe("open §dbconn now");
	});
});

describe("ArgotLoadTool / ArgotUnloadTool approval tiers", () => {
	it("marks load as write-tier with the requested folder in approval details, unload as read", () => {
		const session = makeToolSession({
			cwd: "/tmp/argot-approval",
			getArgotSession: () => new ArgotSession(),
			settings: { get: () => undefined },
		});
		const load = new ArgotLoadTool(session);
		const unload = new ArgotUnloadTool(session);
		expect(load.approval).toBe("write");
		expect(unload.approval).toBe("read");
		expect(load.formatApprovalDetails({ folder_path: "/repo/crate" })).toEqual(["Folder: /repo/crate"]);
		expect(load.formatApprovalDetails({ folder_path: "  " })).toEqual(["Folder: (missing)"]);
		expect(load.formatApprovalDetails({})).toEqual(["Folder: (missing)"]);
	});
});
