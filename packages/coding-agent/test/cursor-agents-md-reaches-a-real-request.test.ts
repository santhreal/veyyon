/**
 * Every instruction layer a session discovered reaches a real cursor-agent request.
 *
 * WHY THIS SUITE EXISTS, and what class it closes.
 *
 * Cursor's server discards the client's system-prompt blobs, rebuilds the prompt head with its
 * own, and applies none of `requestContext.rules`. The active user turn is the one thing it
 * delivers to the model verbatim. The delivery used to be split in two: the session inlined
 * NOTHING in the prompt on this api and shipped a separately composed list of file units as
 * rules instead, and that list was filtered to the caller's configured scopes. Each half was
 * correct on its own terms and the join was not: a repository's `AGENTS.md` was excluded from
 * the rules list because it was "repository content", and excluded from the prompt because
 * "the rules list carries it", so on cursor-agent alone it reached the model nowhere, while
 * every other api rendered it. The defect was reported as veyyon not loading AGENTS.md. Even
 * repaired, that channel delivered nothing, because no rule the client sends is applied at all.
 *
 * The class is "one api composes instructions its own way". It is closed by deleting the second
 * channel: the session assembles ONE prompt for every api, and the provider prepends that prompt
 * to the active user turn. A layer can no longer be dropped for cursor-agent without being
 * dropped for every api, which the per-api suite catches.
 *
 * WHAT IS PINNED. Every case below drives the real session (its own discovery, its own prompt
 * build, the real provider) against a Cursor server that speaks the real protocol; nothing is
 * stubbed but the socket, and every assertion reads the decoded user turn rather than a payload
 * the server ignores. The layers are swept from `ContextFile["level"]`, so a new scope does not
 * compile until someone records what it does here.
 *
 * WHAT IT DOES NOT CATCH. It cannot prove Cursor's SERVER hands the turn to the model unchanged
 * — only a live run does that — and it says nothing about apis other than cursor-agent, which
 * `operator-instructions-reach-every-api.test.ts` owns.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as http2 from "node:http2";
import * as path from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { buildModel } from "@veyyon/catalog/build";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	type CursorRule,
	ExecServerMessageSchema,
	InteractionUpdateSchema,
	RequestContextArgsSchema,
	type RequestContextSuccess,
	TurnEndedUpdateSchema,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ContextFile } from "@veyyon/coding-agent/discovery/capability/context-file";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import {
	GLOBAL_BODY,
	PROFILE_BODY,
	PROJECT_NESTED_BODY,
	PROJECT_ROOT_BODY,
	useContextScopeFixture,
} from "./helpers/context-scope-fixture";

// Each case boots a session, runs real discovery and completes a turn against a local server.
setDefaultTimeout(60_000);

const GLOBAL_MARKER = "GLOBAL-SCOPE-BYTES-c3f1";
const PROFILE_MARKER = "PROFILE-SCOPE-BYTES-9a27";
const PROJECT_ROOT_MARKER = "PROJECT-ROOT-BYTES-51bd";
const PROJECT_NESTED_MARKER = "PROJECT-NESTED-BYTES-7e40";
/** Bytes that exist only after the operator edits the global file mid-session. */
const EDITED_MARKER = "EDITED-GLOBAL-BYTES-5b0e";

/**
 * What the wire does with each context-file scope, one recorded decision per level.
 *
 * Exhaustive by type: adding a member to `ContextFile["level"]` does not compile until someone
 * records its answer, and the sweep below lays a real file down for every key and reads the
 * answer off the frames the server received. A scope that is silently dropped on one api is the
 * defect this file exists for, so "withheld" is not a value any level may take: a layer the
 * session decided not to deliver must not be discovered in the first place.
 */
const LEVEL_ON_THE_WIRE: Record<ContextFile["level"], "delivered"> = {
	global: "delivered",
	user: "delivered",
	project: "delivered",
};

const fixture = useContextScopeFixture("cursor-e2e-");

function frame(payload: Uint8Array): Buffer {
	const header = Buffer.alloc(5);
	header.writeUInt8(0, 0);
	header.writeUInt32BE(payload.length, 1);
	return Buffer.concat([header, Buffer.from(payload)]);
}

function requestContextAskFrame(): Buffer {
	return frame(
		toBinary(
			AgentServerMessageSchema,
			create(AgentServerMessageSchema, {
				message: {
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						execId: "ctx-1",
						message: { case: "requestContextArgs", value: create(RequestContextArgsSchema, {}) },
					}),
				},
			}),
		),
	);
}

function turnEndedFrame(): Buffer {
	return frame(
		toBinary(
			AgentServerMessageSchema,
			create(AgentServerMessageSchema, {
				message: {
					case: "interactionUpdate",
					value: create(InteractionUpdateSchema, {
						message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
					}),
				},
			}),
		),
	);
}

/**
 * Every rule the client answered with, decoded from the raw bytes the server received.
 *
 * The chunks are concatenated first: a Connect frame is not a TCP chunk, and the request body
 * carrying the system prompt is comfortably larger than one, so per-chunk framing reads a length
 * prefix out of the middle of a message and finds nothing.
 */
function deliveredRules(clientFrames: Buffer[]): CursorRule[] {
	let buffer = Buffer.concat(clientFrames);
	while (buffer.length >= 5) {
		const length = buffer.readUInt32BE(1);
		if (buffer.length < 5 + length) break;
		const body = buffer.subarray(5, 5 + length);
		buffer = buffer.subarray(5 + length);
		const message = fromBinary(AgentClientMessageSchema, new Uint8Array(body));
		if (message.message.case !== "execClientMessage") continue;
		const exec = message.message.value;
		if (exec.message.case !== "requestContextResult") continue;
		const result = exec.message.value.result;
		if (result.case !== "success") throw new Error(`requestContext failed: ${result.case}`);
		return (result.value as RequestContextSuccess).requestContext?.rules ?? [];
	}
	return [];
}

/**
 * The text of the active user turn this stream sent, decoded from the raw bytes the server
 * received. This is the field Cursor's server delivers to the model verbatim, so it is what
 * "reached the model" means on this api.
 */
function deliveredUserTurn(clientFrames: Buffer[]): string {
	let buffer = Buffer.concat(clientFrames);
	while (buffer.length >= 5) {
		const length = buffer.readUInt32BE(1);
		if (buffer.length < 5 + length) break;
		const body = buffer.subarray(5, 5 + length);
		buffer = buffer.subarray(5 + length);
		const message = fromBinary(AgentClientMessageSchema, new Uint8Array(body));
		if (message.message.case !== "runRequest") continue;
		const action = message.message.value.action?.action;
		if (action?.case !== "userMessageAction") continue;
		return action.value.userMessage?.text ?? "";
	}
	return "";
}

/**
 * Whether this stream's client has answered the `requestContextArgs` ask.
 *
 * Keyed on the ANSWER, not on what the answer contains: the payload carries no rules now, and a
 * trigger that waited for one would hang every turn.
 */
function answeredRequestContext(clientFrames: Buffer[]): boolean {
	let buffer = Buffer.concat(clientFrames);
	while (buffer.length >= 5) {
		const length = buffer.readUInt32BE(1);
		if (buffer.length < 5 + length) break;
		const body = buffer.subarray(5, 5 + length);
		buffer = buffer.subarray(5 + length);
		const message = fromBinary(AgentClientMessageSchema, new Uint8Array(body));
		if (message.message.case !== "execClientMessage") continue;
		if (message.message.value.message.case === "requestContextResult") return true;
	}
	return false;
}

interface FakeCursorServer {
	baseUrl: string;
	/** One entry per request stream, in order: the raw bytes that turn's client sent. */
	turns: Buffer[][];
	close: () => Promise<void>;
}

/**
 * A Cursor server that asks for the request context and ends the turn once it has the answer.
 *
 * Ending only after the answer arrives is what makes the recording deterministic: `turnEnded`
 * completes the round on the client, so writing it first would race the client's reply.
 *
 * Recording per STREAM rather than into one buffer is what lets a case span turns. A shared
 * buffer still holds the previous turn's answer, so the next stream would end on its first byte
 * and every turn after the first would record nothing.
 */
function startFakeCursor(): Promise<FakeCursorServer> {
	const turns: Buffer[][] = [];
	const server = http2.createServer();
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		const frames: Buffer[] = [];
		turns.push(frames);
		let ended = false;
		stream.on("data", (chunk: Buffer) => {
			frames.push(Buffer.from(chunk));
			if (ended || !answeredRequestContext(frames)) return;
			ended = true;
			stream.write(turnEndedFrame());
		});
		stream.on("error", () => {});
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		stream.write(requestContextAskFrame());
	});
	const { promise, resolve } = Promise.withResolvers<FakeCursorServer>();
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const close = () => {
			const done = Promise.withResolvers<void>();
			server.close(() => done.resolve());
			return done.promise;
		};
		resolve({ baseUrl: `http://127.0.0.1:${port}`, turns, close });
	});
	return promise;
}

/** The fixture state a case starts from, plus the paths it needs to assert on. */
interface OperatorWorkspace {
	cwd: string;
	home: string;
	agentDir: string;
	globalAgentsPath: string;
	profileAgentsPath: string;
	rootAgentsPath: string;
	nestedAgentsPath: string;
	agentDirFor: (profile: string) => string;
	resetCaches: () => void;
	writeFile: (target: string, body: string) => string;
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
	return count;
}

describe("a cursor-agent turn carries every instruction layer the session found", () => {
	let session: AgentSession | undefined;
	let srv: FakeCursorServer | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		await srv?.close();
		srv = undefined;
	});

	/**
	 * Every scope on disk at once: the operator's two files, and the repository's own two at
	 * their real depths. A case that wants fewer deletes what it does not want.
	 */
	function operatorWorkspace(profile = "work"): OperatorWorkspace {
		const fx = fixture(profile);
		fx.writeFile(fx.globalAgentsPath, GLOBAL_BODY);
		fx.writeFile(fx.profileAgentsPath, PROFILE_BODY);
		fx.writeFile(fx.rootAgentsPath, PROJECT_ROOT_BODY);
		fx.writeFile(fx.nestedAgentsPath, PROJECT_NESTED_BODY);
		fx.resetCaches();
		return {
			cwd: fx.cwd,
			home: fx.home,
			agentDir: fx.agentDir,
			globalAgentsPath: fx.globalAgentsPath,
			profileAgentsPath: fx.profileAgentsPath,
			rootAgentsPath: fx.rootAgentsPath,
			nestedAgentsPath: fx.nestedAgentsPath,
			agentDirFor: fx.agentDirFor,
			resetCaches: fx.resetCaches,
			writeFile: fx.writeFile,
		};
	}

	async function startSession(
		ws: OperatorWorkspace,
		baseUrl: string,
		overrides: { cwd?: string; agentDir?: string } = {},
	): Promise<AgentSession> {
		const cwd = overrides.cwd ?? ws.cwd;
		const authStorage = await AuthStorage.create(path.join(ws.home, `auth-${path.basename(cwd)}.db`));
		authStorage.setRuntimeApiKey("cursor", "test-token");
		const created = await createAgentSession({
			cwd,
			agentDir: overrides.agentDir ?? ws.agentDir,
			sessionManager: SessionManager.create(cwd, path.join(ws.home, "sessions")),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage),
			settings: Settings.isolated({ "async.enabled": false, "advisor.enabled": false }),
			model: buildModel({
				id: "cursor-composer-2.5",
				name: "Cursor Composer 2.5",
				api: "cursor-agent",
				provider: "cursor",
				baseUrl,
				reasoning: false,
				input: ["text"],
				cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 64_000,
			}),
			// `contextFiles` deliberately omitted: the session must run its OWN discovery, which
			// is the step that was never exercised together with the delivery choice.
			disableExtensionDiscovery: true,
			skills: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		return created.session;
	}

	/**
	 * The turns that actually answered a request-context ask, in order.
	 *
	 * A client opens more streams than it takes turns (retries, and the provider's own probes),
	 * and only the ones carrying an answer say anything about delivery.
	 */
	function answeredTurns(server: FakeCursorServer): Buffer[][] {
		return server.turns.filter(turn => answeredRequestContext(turn));
	}

	/**
	 * What the model receives on this turn: the text of the active user message.
	 *
	 * NOT the rules. The server applies none of them, so a case that reads the rules payload
	 * proves only that bytes left this process — which is exactly how the defect stayed green
	 * through two suites.
	 */
	function turnText(turn: Buffer[]): string {
		return deliveredUserTurn(turn);
	}

	/** Run one turn and return what the first answering turn delivered. */
	async function turnOnTheWire(ws: OperatorWorkspace, overrides: { cwd?: string; agentDir?: string } = {}) {
		srv = await startFakeCursor();
		session = await startSession(ws, srv.baseUrl, overrides);
		await session.prompt("what are my standing orders?");
		await session.waitForIdle();
		const turns = answeredTurns(srv);
		expect(turns.length).toBeGreaterThan(0);
		return { turns, first: turns[0], text: turnText(turns[0]) };
	}

	it("delivers every scope it discovered, one recorded decision per level", async () => {
		// The sweep. Each level has a real file on disk and a marker of its own, and the answer
		// is read off the frames rather than asserted about a helper. A level that stops being
		// delivered fails here by name.
		const ws = operatorWorkspace();
		const { text } = await turnOnTheWire(ws);

		const markerFor: Record<ContextFile["level"], string> = {
			global: GLOBAL_MARKER,
			user: PROFILE_MARKER,
			project: PROJECT_ROOT_MARKER,
		};
		const levels = Object.keys(LEVEL_ON_THE_WIRE) as ContextFile["level"][];
		const observed = levels.map(level => [level, text.includes(markerFor[level]) ? "delivered" : "withheld"]);

		expect(observed).toEqual(levels.map(level => [level, LEVEL_ON_THE_WIRE[level]]));
	});

	it("delivers the repository's own AGENTS.md, the layer this api used to drop", async () => {
		// The reported regression, named. The repo file was withheld from the rules channel as
		// "repository content" while the prompt that would have carried it was blanked for this
		// api, so it reached the model on no channel at all.
		const ws = operatorWorkspace();
		const { text } = await turnOnTheWire(ws);

		expect(text).toContain(PROJECT_ROOT_MARKER);
		expect(text).toContain(fs.readFileSync(ws.rootAgentsPath, "utf8").trim());
	});

	it("delivers a package's own AGENTS.md beside the repository root's", async () => {
		// Both project depths, not merely the nearest. A file closer to cwd refines its
		// ancestors, which only works when the ancestor arrives too.
		const ws = operatorWorkspace();
		const { text } = await turnOnTheWire(ws);

		expect(text).toContain(PROJECT_ROOT_MARKER);
		expect(text).toContain(PROJECT_NESTED_MARKER);
	});

	it("carries the operator's instructions inside a delimited block, ahead of the question", async () => {
		// The shape the model receives. The instructions are marked off from the caller's
		// configuration, and the question stays after them, so a turn does not read as a
		// reciting of a configuration file.
		const ws = operatorWorkspace();
		const { text } = await turnOnTheWire(ws);

		const open = text.indexOf("<operator-instructions>");
		const close = text.indexOf("</operator-instructions>");
		expect(open).toBe(0);
		expect(close).toBeGreaterThan(open);
		expect(text.indexOf("what are my standing orders?")).toBeGreaterThan(close);
		for (const marker of [GLOBAL_MARKER, PROFILE_MARKER, PROJECT_ROOT_MARKER, PROJECT_NESTED_MARKER]) {
			expect(text.slice(open, close)).toContain(marker);
		}
	});

	it("answers the request-context ask carrying no instruction bytes at all", async () => {
		// The channel that used to carry a second copy of the whole prompt. The ask is still
		// answered — a silent client stalls the turn — and the answer is instruction-free.
		const ws = operatorWorkspace();
		const { first } = await turnOnTheWire(ws);

		expect(deliveredRules(first)).toEqual([]);
	});

	it("delivers each layer's bytes exactly once", async () => {
		// Delivering twice is the failure mode of "fix it by sending it on both channels": it
		// doubles a 40KB file into every request and hides which channel is the real one.
		const ws = operatorWorkspace();
		const { text } = await turnOnTheWire(ws);

		for (const marker of [GLOBAL_MARKER, PROFILE_MARKER, PROJECT_ROOT_MARKER, PROJECT_NESTED_MARKER]) {
			expect(countOccurrences(text, marker)).toBe(1);
		}
	});

	it("keeps the authority order the prompt renders: project, then profile, then global", async () => {
		// Position IS authority in a prompt, and the operator's own file has to hold the last,
		// highest-recency slot. A channel that reordered the layers would deliver every byte and
		// still let a repository outrank the operator.
		const ws = operatorWorkspace();
		const { text } = await turnOnTheWire(ws);

		// A missing marker yields -1, which sorts before everything, so a dropped layer would
		// pass an index comparison on its own. Presence is asserted first, in the same shape.
		const at = [PROJECT_ROOT_MARKER, PROFILE_MARKER, GLOBAL_MARKER].map(marker => text.indexOf(marker));
		expect(at.filter(index => index === -1)).toEqual([]);
		expect(at[0]).toBeLessThan(at[1] as number);
		expect(at[1]).toBeLessThan(at[2] as number);
	});

	it("carries them on every turn the session answered, not only the first", async () => {
		// A session issues more than one request, and one of them arriving without the operator's
		// instructions is the same failure wearing a different hat.
		const ws = operatorWorkspace();
		const { turns } = await turnOnTheWire(ws);
		if (!session) throw new Error("session not started");
		await session.prompt("and again");
		await session.waitForIdle();

		const all = answeredTurns(srv as FakeCursorServer);
		expect(all.length).toBeGreaterThan(turns.length);
		for (const turn of all) {
			expect(turnText(turn)).toContain(GLOBAL_MARKER);
			expect(turnText(turn)).toContain(PROJECT_ROOT_MARKER);
		}
	});

	it("delivers the operator's files as edited after the session re-roots, not as first read", async () => {
		// The prompt is rebuilt from whatever discovery holds AT REQUEST TIME. Capturing the
		// files once at session start would look identical on turn one and would then serve the
		// bytes from session start forever, so an operator who edits a file and re-roots is told
		// the new instructions are live while the model keeps reading the old ones.
		const ws = operatorWorkspace();
		const { first } = await turnOnTheWire(ws);
		expect(turnText(first)).not.toContain(EDITED_MARKER);
		if (!session) throw new Error("session not started");

		ws.writeFile(ws.globalAgentsPath, `${GLOBAL_BODY}\nEdited: ${EDITED_MARKER}.`);
		const elsewhere = path.join(ws.home, "elsewhere");
		fs.mkdirSync(elsewhere, { recursive: true });
		ws.resetCaches();
		await session.setCwd(elsewhere);

		await session.prompt("second");
		await session.waitForIdle();

		const turns = answeredTurns(srv as FakeCursorServer);
		expect(turns.length).toBeGreaterThanOrEqual(2);
		expect(turnText(turns[turns.length - 1])).toContain(EDITED_MARKER);
	});

	it("keeps delivering the other layers when one of them is empty", async () => {
		// An empty file is not an instruction, but it is also not a veto. Treating it as one is
		// how a freshly created profile used to silence the operator's global file.
		const ws = operatorWorkspace();
		ws.writeFile(ws.profileAgentsPath, "   \n");
		ws.resetCaches();

		const { text } = await turnOnTheWire(ws);

		expect(text).not.toContain(PROFILE_MARKER);
		expect(text).toContain(GLOBAL_MARKER);
		expect(text).toContain(PROJECT_ROOT_MARKER);
	});

	it("carries the instruction file of the profile the session runs, not the booted one", async () => {
		// The profile scope resolves from the session's agent dir. A session rooted in another
		// profile that received the booted profile's file would be obeying rules the operator
		// wrote for a different context, and would never see the ones they wrote for this one.
		const ws = operatorWorkspace();
		const otherAgentDir = ws.agentDirFor("review");
		const otherMarker = "REVIEW-PROFILE-BYTES-2c8f";
		ws.writeFile(path.join(otherAgentDir, "AGENTS.md"), `# Review profile\nMarker: ${otherMarker}.`);
		ws.resetCaches();

		const { text } = await turnOnTheWire(ws, { agentDir: otherAgentDir });

		expect(text).toContain(otherMarker);
		expect(text).not.toContain(PROFILE_MARKER);
		// The scopes that do not depend on the profile still arrive.
		expect(text).toContain(GLOBAL_MARKER);
	});

	it("delivers a CLAUDE.md at a level that has no AGENTS.md", async () => {
		// The project rung is a ladder of filenames, not one name. A rung whose file happens to
		// be the other supported name is still that rung's instructions.
		const ws = operatorWorkspace();
		fs.rmSync(ws.nestedAgentsPath);
		const claudeMarker = "PROJECT-CLAUDE-BYTES-4d17";
		ws.writeFile(path.join(path.dirname(ws.nestedAgentsPath), "CLAUDE.md"), `# Package rules\n${claudeMarker}`);
		ws.resetCaches();

		const { text } = await turnOnTheWire(ws);

		expect(text).toContain(claudeMarker);
		expect(text).toContain(PROJECT_ROOT_MARKER);
	});
});
