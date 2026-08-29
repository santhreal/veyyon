import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createAutoresearchExtension } from "@veyyon/coding-agent/autoresearch";
import { closeAllAutoresearchStorages, openAutoresearchStorage } from "@veyyon/coding-agent/autoresearch/storage";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionStartEvent,
} from "@veyyon/coding-agent/extensibility/extensions";
import * as git from "@veyyon/coding-agent/utils/git";
import { TempDir } from "@veyyon/utils";

// Reproduces issue #3665: when the upstream system prompt resolution leaves
// `event.systemPrompt` unset, the autoresearch handler must still render its
// own block instead of crashing with `event.systemPrompt.join is not a function`.

interface CapturedHandlers {
	session_start?: ExtensionHandler<SessionStartEvent>;
	before_agent_start?: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
}

function buildHarness(): { handlers: CapturedHandlers; activeTools: string[] } {
	const handlers: CapturedHandlers = {};
	const activeTools: string[] = [];
	const api = {
		appendEntry(): void {},
		exec: async () => ({ code: 0, stderr: "", stdout: "" }),
		on(event: string, handler: ExtensionHandler<unknown, unknown>): void {
			(handlers as Record<string, ExtensionHandler<unknown, unknown>>)[event] = handler;
		},
		registerCommand(): void {},
		registerShortcut(): void {},
		registerTool(): void {},
		getActiveTools: (): string[] => [...activeTools],
		setActiveTools: async (names: string[]): Promise<void> => {
			activeTools.splice(0, activeTools.length, ...names);
		},
		sendUserMessage(): void {},
		sendMessage(): void {},
	} as unknown as ExtensionAPI;
	createAutoresearchExtension(api);
	return { handlers, activeTools };
}

function makeCtx(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		hasPendingMessages: () => false,
		sessionManager: {
			getSessionId: () => "session-bas-test",
			getBranch: () => [
				{
					type: "custom",
					customType: "autoresearch-control",
					id: "ctrl-1",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					data: { mode: "on", goal: "speed up the thing" },
				},
			],
		},
	} as unknown as ExtensionContext;
}

describe("autoresearch before_agent_start handler", () => {
	let dbDir: TempDir;
	let cwdDir: TempDir;

	beforeEach(() => {
		dbDir = TempDir.createSync("@pi-autoresearch-bas-test-");
		process.env.VEYYON_AUTORESEARCH_DB_DIR = dbDir.path();
		cwdDir = TempDir.createSync("@pi-autoresearch-bas-cwd-");
		vi.spyOn(git.branch, "current").mockResolvedValue("autoresearch/test");
		vi.spyOn(git.repo, "root").mockResolvedValue(cwdDir.path());
	});

	afterEach(() => {
		delete process.env.VEYYON_AUTORESEARCH_DB_DIR;
		closeAllAutoresearchStorages();
		cwdDir.removeSync();
		dbDir.removeSync();
		vi.restoreAllMocks();
	});

	it("renders an autoresearch block when event.systemPrompt is undefined (issue #3665)", async () => {
		const { handlers } = buildHarness();
		if (!handlers.session_start || !handlers.before_agent_start) {
			throw new Error("Autoresearch extension should register both session_start and before_agent_start");
		}

		const ctx = makeCtx(cwdDir.path());
		await handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);

		// Crash repro: upstream leaves event.systemPrompt unset; handler must
		// not throw, and the rendered block must still contain the autoresearch
		// header so the model gets its mode-specific instructions.
		const event = {
			type: "before_agent_start",
			prompt: "kick off",
			images: undefined,
			systemPrompt: undefined,
		} as unknown as BeforeAgentStartEvent;

		const result = (await handlers.before_agent_start(event, ctx)) as BeforeAgentStartEventResult;
		expect(result).toBeDefined();
		expect(Array.isArray(result.systemPrompt)).toBe(true);
		const blocks = result.systemPrompt as string[];
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain("Autoresearch Mode");
	});

	it("joins event.systemPrompt blocks into the rendered base prompt", async () => {
		const { handlers } = buildHarness();
		if (!handlers.session_start || !handlers.before_agent_start) {
			throw new Error("Autoresearch extension should register both session_start and before_agent_start");
		}

		const ctx = makeCtx(cwdDir.path());
		await handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);

		const event: BeforeAgentStartEvent = {
			type: "before_agent_start",
			prompt: "kick off",
			systemPrompt: ["alpha block", "beta block"],
		};

		const result = (await handlers.before_agent_start(event, ctx)) as BeforeAgentStartEventResult;
		expect(result).toBeDefined();
		const rendered = (result.systemPrompt as string[])[0];
		expect(rendered.startsWith("alpha block\n\nbeta block")).toBe(true);
	});

	// Breadth is only reachable through the prompt: the tools exist, but nothing
	// tells the model to build arms unless the rendered block says so. These pin
	// that the section appears exactly when the session asks for it.
	async function renderWithBreadth(breadth: number): Promise<string> {
		const storage = await openAutoresearchStorage(cwdDir.path());
		storage.openSession({
			name: "breadth render",
			goal: "speed up the thing",
			primaryMetric: "ms",
			metricUnit: "ms",
			direction: "lower",
			preferredCommand: "bash autoresearch.sh",
			branch: "autoresearch/test",
			baselineCommit: null,
			maxIterations: null,
			scopePaths: [],
			offLimits: [],
			constraints: [],
			secondaryMetrics: [],
			breadth,
			attempts: 1,
			maxParallel: breadth,
			certify: true,
		});
		const { handlers } = buildHarness();
		if (!handlers.session_start || !handlers.before_agent_start) throw new Error("handlers missing");
		const ctx = makeCtx(cwdDir.path());
		await handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);
		const result = (await handlers.before_agent_start(
			{ type: "before_agent_start", prompt: "go", systemPrompt: [] },
			ctx,
		)) as BeforeAgentStartEventResult;
		return (result.systemPrompt as string[])[0];
	}

	it("leaves the serial protocol alone when breadth is 1", async () => {
		const rendered = await renderWithBreadth(1);
		expect(rendered).toContain("One coherent experiment per iteration");
		expect(rendered).not.toContain("### Breadth");
		expect(rendered).not.toContain("certify_arms");
	});

	it("instructs the model to build arms and cross-review them when breadth is above 1", async () => {
		const rendered = await renderWithBreadth(3);
		expect(rendered).toContain("### Breadth");
		expect(rendered).toContain("Breadth is `3`");
		expect(rendered).toContain("3 candidate arms");
		expect(rendered).toContain("certify_arms");
		expect(rendered).not.toContain("One coherent experiment per iteration");
	});
});
