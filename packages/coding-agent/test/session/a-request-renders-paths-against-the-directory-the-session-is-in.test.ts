/**
 * A request renders paths relative to the directory the session is in, whatever moved it there.
 *
 * WHY THIS SUITE EXISTS. Every request of a session goes out through one provider wire, which
 * renders an absolute path under the session's working directory relative to it. The wire holds
 * the directory it renders against, and the session moves it on every directory transition. A
 * wire left behind after a move renders the new directory's paths absolute, re-sending the prefix
 * the relativization exists to leave out, and renders the old directory's paths relative, so
 * `src/app.ts` in a request names a file under a directory the tools no longer resolve against. A
 * wire moved by a transition that then failed and rolled back does the same in reverse.
 *
 * THE CLASS. Every transition that changes a session's working directory: `setCwd`, `moveToCwd`
 * and `switchSession` to a conversation recorded in another directory, each once completed and
 * once failed after the session manager already moved. The assertion is on the request a provider
 * receives, read through the transform the session installs on its agent, so a transition that
 * moves the session but not the wire, or restores the session but not the wire, fails here.
 * `switchSession` fails after it moved the wire, which is the one transition whose rollback
 * restores a moved wire rather than never moving it.
 *
 * WHAT IT DOES NOT CATCH. The transition table is hand-kept: a new public method that moves the
 * working directory is not enumerated until a row is added for it. Relativization itself, the
 * tool-call id handles and the prefix freeze after a move are proven in
 * `canonicalize-tool-call-ids.test.ts` and `a-cwd-change-does-not-rewrite-history-already-sent.test.ts`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Context, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { getProjectDir, setProjectDir, TempDir } from "@veyyon/utils";

type Transform = (context: Context, model: Model) => Context | Promise<Context>;

interface Harness {
	session: AgentSession;
	transform: Transform;
	origin: string;
	destination: string;
	/** A session directory for the destination, beside the origin's. */
	destinationSessions: string;
}

/**
 * A transition from the origin to the destination. `fail` makes the session's re-scope of the
 * destination fail, after the session manager already moved there.
 */
interface Transition {
	run(harness: Harness): Promise<unknown>;
	/** Fails the transition after the wire could have moved. */
	fail(harness: Harness): void;
}

const REJECTION = "the destination could not be re-scoped";

/** A re-scope that fails whenever the session manager stands in the destination. */
function failRescopeAtDestination({ session, destination }: Harness): void {
	vi.spyOn(session, "refreshBaseSystemPrompt").mockImplementation(async () => {
		if (session.sessionManager.getCwd() === destination) throw new Error(REJECTION);
		return [];
	});
}

const TRANSITIONS: Record<string, Transition> = {
	setCwd: {
		run: ({ session, destination }) => session.setCwd(destination),
		fail: failRescopeAtDestination,
	},
	moveToCwd: {
		run: ({ session, destination, destinationSessions }) => session.moveToCwd(destination, destinationSessions),
		fail: failRescopeAtDestination,
	},
	"switchSession to a conversation recorded in another directory": {
		run: async ({ session, destination, destinationSessions }) => {
			const other = SessionManager.create(destination, destinationSessions);
			other.appendMessage({ role: "user", content: [{ type: "text", text: "elsewhere" }], timestamp: 1 });
			other.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "answered" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 2,
			});
			await other.flush();
			const file = other.getSessionFile();
			if (!file) throw new Error("the other conversation has no file");
			return await session.switchSession(file);
		},
		// The switch moves the wire right after re-scoping, so a failure in the step after it is the
		// one that exercises the rollback of a moved wire.
		fail: ({ session }) => {
			vi.spyOn(session, "buildDisplaySessionContext").mockImplementationOnce(() => {
				throw new Error(REJECTION);
			});
		},
	},
};

describe("a request renders paths against the directory the session is in", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let tempDir: TempDir;
	let originalProjectDir = "";
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("veyyon-wire-root-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected the bundled anthropic model to exist");
		model = bundled;
	});

	afterAll(async () => {
		authStorage.close();
		await sharedDir.remove();
	});

	beforeEach(() => {
		// A re-scope calls `setProjectDir`, which moves the process. Put it back before the temp
		// tree is removed, or the next suite snapshots a deleted directory.
		originalProjectDir = getProjectDir();
		tempDir = TempDir.createSync("veyyon-wire-root-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
		setProjectDir(originalProjectDir);
		tempDir.removeSync();
	});

	function makeDir(name: string): string {
		const dir = path.join(tempDir.path(), name);
		fs.mkdirSync(dir, { recursive: true });
		return fs.realpathSync(dir);
	}

	/**
	 * A file-backed session in `origin`, and the transform it installed on its agent. The transform
	 * is captured where the session publishes it, so a session that never installs one fails here
	 * rather than passing on a private field.
	 */
	async function harness(): Promise<Harness> {
		const origin = makeDir("origin");
		const destination = makeDir("destination");
		const sessionManager = SessionManager.create(origin, makeDir("sessions-origin"));
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
		});
		let captured: Transform | undefined;
		const install = agent.setTransformProviderContext.bind(agent);
		agent.setTransformProviderContext = fn => {
			captured = fn ?? undefined;
			install(fn);
		};
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		sessions.push(session);
		if (!captured) throw new Error("AgentSession installed no provider context transform");
		return {
			session,
			transform: captured,
			origin,
			destination,
			destinationSessions: makeDir("sessions-destination"),
		};
	}

	/** The bytes a provider receives for a user message naming `file`. */
	async function rendered(transform: Transform, file: string): Promise<string> {
		const context = await transform(
			{ systemPrompt: ["Test"], messages: [{ role: "user", content: `open ${file}`, timestamp: 1 }] },
			model,
		);
		const content = context.messages[0]?.content;
		if (typeof content !== "string") throw new Error("the user message lost its text content");
		return content;
	}

	/** Requests render `stay`'s paths relative and `other`'s absolute. */
	async function expectRenderedAgainst(transform: Transform, stay: string, other: string): Promise<void> {
		expect(await rendered(transform, `${stay}/src/app.ts`)).toBe("open src/app.ts");
		expect(await rendered(transform, `${other}/src/app.ts`)).toBe(`open ${other}/src/app.ts`);
	}

	it("renders against the directory the session opened in", async () => {
		const { transform, origin, destination } = await harness();
		await expectRenderedAgainst(transform, origin, destination);
	});

	for (const [name, transition] of Object.entries(TRANSITIONS)) {
		it(`renders against the destination once ${name} completes`, async () => {
			const subject = await harness();
			vi.spyOn(subject.session, "refreshBaseSystemPrompt").mockResolvedValue([]);

			await transition.run(subject);

			expect(subject.session.sessionManager.getCwd()).toBe(subject.destination);
			await expectRenderedAgainst(subject.transform, subject.destination, subject.origin);
		});

		it(`renders against the origin when ${name} fails and rolls back`, async () => {
			const subject = await harness();
			vi.spyOn(subject.session, "refreshBaseSystemPrompt").mockResolvedValue([]);
			transition.fail(subject);

			await expect(transition.run(subject)).rejects.toThrow(REJECTION);

			expect(subject.session.sessionManager.getCwd()).toBe(subject.origin);
			await expectRenderedAgainst(subject.transform, subject.origin, subject.destination);
		});
	}

	/**
	 * The counters the context panel reads accumulate on the same wire the requests go through, so a
	 * transition that rebuilt the wire would reset them. Each request above that relativized a path
	 * adds the prefix it left out.
	 */
	it("keeps counting the bytes it left out across a directory change", async () => {
		const subject = await harness();
		vi.spyOn(subject.session, "refreshBaseSystemPrompt").mockResolvedValue([]);
		await rendered(subject.transform, `${subject.origin}/a.ts`);
		const beforeMove = subject.session.wirePathBytesSaved;
		expect(beforeMove).toBe(`${subject.origin}/`.length);

		await subject.session.setCwd(subject.destination);
		await rendered(subject.transform, `${subject.destination}/b.ts`);

		expect(subject.session.wirePathBytesSaved).toBe(beforeMove + `${subject.destination}/`.length);
	});
});
