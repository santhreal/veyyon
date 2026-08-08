/**
 * The operator's AGENTS.md reaches a real cursor-agent request, end to end.
 *
 * WHY THIS SUITE EXISTS. The operator ran a `cursor-agent` model from `~/tmp` and the model
 * reported "No AGENTS.md content is present in my current context". Every component was tested and
 * every component was fine: discovery produced the two operator scopes, `cursorContextFileRules`
 * kept them, `buildCursorRules` wrapped them, and the provider wrote them out when asked. The
 * defect lived in the JOIN, which nothing drove: on a cursor-agent model `sdk.ts` deliberately
 * inlines NO context files in the prompt, so if the rules channel does not carry them, nothing
 * does, and the turn reports success anyway.
 *
 * So this suite drives the whole thing: a real `createAgentSession` over real discovery from a
 * real bare directory, a real cursor-agent model, the real provider, and a real HTTP/2 socket to a
 * fake Cursor server that asks for the request context and records exactly what the client
 * answered. The only thing not real is the server.
 *
 * The two assertions are the two halves of one contract, and BOTH are needed:
 *  - the operator's bytes are in `requestContext.rules`, the only channel Cursor honors;
 *  - they are NOT in the system-prompt rule, because the prompt blobs the client sends are
 *    replaced by Cursor's own and inlining there would be a second copy that never arrives.
 */
import { afterEach, describe, expect, it } from "bun:test";
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
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { GLOBAL_BODY, PROFILE_BODY, useContextScopeFixture } from "./helpers/context-scope-fixture";

const GLOBAL_MARKER = "GLOBAL-SCOPE-BYTES-c3f1";
const PROFILE_MARKER = "PROFILE-SCOPE-BYTES-9a27";
/** The synthetic path the provider gives the system-prompt rule. */
const SYSTEM_PROMPT_RULE = "veyyon://system-prompt.mdc";
/** Bytes that exist only after the operator edits the global file mid-session. */
const EDITED_MARKER = "EDITED-GLOBAL-BYTES-5b0e";
/** Bytes from a repository's own AGENTS.md, which must reach neither channel. */
const PROJECT_MARKER = "PROJECT-SCOPE-BYTES-71da";

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
			if (ended || deliveredRules(frames).length === 0) return;
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
	resetCaches: () => void;
	writeFile: (target: string, body: string) => void;
}

describe("a cursor-agent turn carries the operator's instruction files", () => {
	let session: AgentSession | undefined;
	let srv: FakeCursorServer | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		await srv?.close();
		srv = undefined;
	});

	/**
	 * The operator's own situation: a plain directory, no repository, no project file, with the
	 * two files the operator owns written where discovery will find them.
	 */
	function operatorWorkspace(): OperatorWorkspace {
		const fx = fixture("work");
		fx.writeFile(fx.globalAgentsPath, GLOBAL_BODY);
		fx.writeFile(fx.profileAgentsPath, PROFILE_BODY);
		const cwd = path.join(fx.home, "tmp");
		fs.mkdirSync(cwd, { recursive: true });
		fx.resetCaches();
		return {
			cwd,
			home: fx.home,
			agentDir: fx.agentDir,
			globalAgentsPath: fx.globalAgentsPath,
			profileAgentsPath: fx.profileAgentsPath,
			resetCaches: fx.resetCaches,
			writeFile: fx.writeFile,
		};
	}

	async function startSession(ws: OperatorWorkspace, baseUrl: string): Promise<AgentSession> {
		const authStorage = await AuthStorage.create(path.join(ws.home, "auth.db"));
		authStorage.setRuntimeApiKey("cursor", "test-token");
		const created = await createAgentSession({
			cwd: ws.cwd,
			agentDir: ws.agentDir,
			sessionManager: SessionManager.create(ws.cwd, path.join(ws.home, "sessions")),
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
			workspaceTree: { rootPath: ws.cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
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
		return server.turns.filter(turn => deliveredRules(turn).length > 0);
	}

	/** Join the content of the rules on one turn whose path matches. */
	function ruleText(turn: Buffer[], matches: (rule: CursorRule) => boolean): string {
		return deliveredRules(turn)
			.filter(matches)
			.map(rule => rule.content)
			.join("\n\n");
	}

	it("puts the global and profile AGENTS.md on the wire and keeps them out of the discarded prompt", async () => {
		const ws = operatorWorkspace();
		srv = await startFakeCursor();
		session = await startSession(ws, srv.baseUrl);

		await session.prompt("what are my standing orders?");
		await session.waitForIdle();

		// EVERY request the session made, not merely the first: a session issues more than one
		// (the turn itself, plus whatever else runs on the same model), and one of them arriving
		// without the operator's files is the same failure wearing a different hat.
		const turns = answeredTurns(srv);
		expect(turns.length).toBeGreaterThan(0);
		for (const turn of turns) {
			expect(deliveredRules(turn).map(rule => rule.fullPath)).toEqual([
				SYSTEM_PROMPT_RULE,
				ws.profileAgentsPath,
				ws.globalAgentsPath,
			]);
		}
		// Both operator scopes arrived as their own rules, carrying their real paths and bytes.
		const operatorRules = ruleText(turns[0], rule => rule.fullPath !== SYSTEM_PROMPT_RULE);
		expect(operatorRules).toContain(GLOBAL_MARKER);
		expect(operatorRules).toContain(PROFILE_MARKER);

		// And they are not ALSO in the system prompt. Cursor's server replaces that blob with
		// its own, so a copy there is not redundancy, it is a copy that never arrives, and it
		// hides the fact that the rules channel is the only one that works.
		const systemPromptRule = ruleText(turns[0], rule => rule.fullPath === SYSTEM_PROMPT_RULE);
		expect(systemPromptRule).not.toContain(GLOBAL_MARKER);
		expect(systemPromptRule).not.toContain(PROFILE_MARKER);
	});

	it("delivers the operator's files as edited after the session re-roots, not as first read", async () => {
		// The resolver hands over whatever `promptContextFiles` holds AT REQUEST TIME. Capturing
		// that array once at session start would look identical on turn one and would then serve
		// the bytes from session start forever, so an operator who edits a file and re-roots is
		// told the new instructions are live while the model keeps reading the old ones.
		const ws = operatorWorkspace();
		srv = await startFakeCursor();
		session = await startSession(ws, srv.baseUrl);

		await session.prompt("first");
		await session.waitForIdle();
		expect(ruleText(answeredTurns(srv)[0], rule => rule.fullPath === ws.globalAgentsPath)).not.toContain(
			EDITED_MARKER,
		);

		ws.writeFile(ws.globalAgentsPath, `${GLOBAL_BODY}\nEdited: ${EDITED_MARKER}.`);
		const elsewhere = path.join(ws.home, "elsewhere");
		fs.mkdirSync(elsewhere, { recursive: true });
		ws.resetCaches();
		await session.setCwd(elsewhere);

		await session.prompt("second");
		await session.waitForIdle();

		const turns = answeredTurns(srv);
		expect(turns.length).toBeGreaterThanOrEqual(2);
		expect(ruleText(turns[turns.length - 1], rule => rule.fullPath === ws.globalAgentsPath)).toContain(EDITED_MARKER);
	});

	it("never puts a repository's own AGENTS.md on the wire", async () => {
		// Project files are excluded from BOTH channels on cursor-agent, deliberately: a
		// repository the operator merely opened does not get to instruct the agent through a
		// channel the operator cannot see. Excluding them from the prompt without also excluding
		// them from the rules would quietly promote every checked-in AGENTS.md to operator
		// authority, which is a worse fault than the one this suite exists for.
		const ws = operatorWorkspace();
		fs.writeFileSync(path.join(ws.cwd, "AGENTS.md"), `# Project\nMarker: ${PROJECT_MARKER}.\n`);
		ws.resetCaches();

		srv = await startFakeCursor();
		session = await startSession(ws, srv.baseUrl);

		await session.prompt("what are my standing orders?");
		await session.waitForIdle();

		const everything = ruleText(answeredTurns(srv)[0], () => true);
		expect(everything).toContain(GLOBAL_MARKER);
		expect(everything).not.toContain(PROJECT_MARKER);
	});
});
