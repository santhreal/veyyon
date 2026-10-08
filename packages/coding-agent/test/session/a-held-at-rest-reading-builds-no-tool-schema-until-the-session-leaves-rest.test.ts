/**
 * WHY: a top-level session measured its at-rest reading inside `createAgentSession`, and that
 * reading estimates the tool half of the prompt by building the ArkType schema of every active
 * tool: about 20 ms of a cold launch and 3.4 MiB of heap, plus the evaluation of `arktype`, all of it
 * before the session's first frame or an RPC launch's `ready`, for schemas only a prompt needs.
 * `createAgentSession` holds the reading of every top-level session (`deferAtRestReading`). The
 * session takes it (`takeHeldAtRestReading`) before its first turn appends a message, and the
 * interactive host takes it earlier, once the frame that draws the composer's first edit is
 * committed. A session left idle builds no schema at all. The status row renders while the reading
 * is held, so the hold is only worth anything if no path of the row's render measures: the gauge
 * draws the resting reading the last launch recorded, and the row's own recorder files no gauge,
 * since a recorded value drawn back is not a measurement.
 *
 * THE CLASS: every read the real status row and the real interactive host make while the session is
 * at rest builds no tool schema, observed as reads of each active tool's `parameters` through the
 * same objects the estimate walks. The suite renders the real `StatusLineComponent` and commits real
 * frames of a real `InteractiveMode` over a real session, so a new read either grows is covered by
 * the render rather than by a list of paths. The release arms are the positive control: the same
 * instrumentation sees the reads once the session leaves rest, so zero reads under the hold is the
 * guard and not a blind probe. Around it: creation files nothing, a session's first turn files the
 * reading at rest before its request reaches the provider, with no host involved, the edit takes the
 * reading after its frame and not inside the keystroke, a first keystroke that opens a popup (`/`,
 * `@`, `#`) builds no schema while the popup computes its rows (the slash popup evaluates every
 * command's description, and `/context` and `/compact` state no figure at rest), a submission takes
 * it before its message lands, the borrowed gauge is the recorded one for the default role and the
 * unknown for any other model, a resumed session states the resting usage its last stamped response
 * supports (the figure the measurement reaches while the stamped non-message size is current) in the
 * row and the slash popup without building a schema, a session whose messages carry no stamped size
 * measures as before, and the readings compaction and `/context` take measure whether or not the
 * reading is held.
 *
 * WHAT THIS DOES NOT CATCH: a host that reads `getContextUsage` before the first prompt, which
 * measures by design; the RPC launch census (`a-launch-evaluates-only-the-packages-it-uses`) observes
 * that `arktype` stays unevaluated through an RPC launch. It also does not prove the reading lands
 * after the edit's frame is flushed to the terminal, only after the frame is committed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { measureContextGauge } from "@veyyon/coding-agent/config/compaction-strategy";
import { readLaunchFacts, recordLaunchFacts, resetLaunchFactsForTest } from "@veyyon/coding-agent/config/launch-facts";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { settings } from "@veyyon/coding-agent/config/settings-instance";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/terminal/components/status-line/component";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { StatusPresentationProducer } from "@veyyon/coding-agent/presentation/status-producer";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { CreateAgentSessionOptions } from "@veyyon/coding-agent/session/factory-options";
import {
	computeNonMessageBreakdown,
	computeNonMessageTokens,
	isAtRestReadingDeferred,
	takeHeldAtRestReading,
} from "@veyyon/coding-agent/session/non-message-tokens";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/theme/theme";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";

const PROVIDER = "anthropic";
const MODEL_ID = "claude-sonnet-4-5";
/** The resting gauge the previous launch filed under the model, as a percentage spent. */
const RECORDED_PERCENT = 70;

function bundledModel(id = MODEL_ID): Model {
	const model = getBundledModel(PROVIDER, id);
	if (!model) throw new Error(`missing bundled model ${PROVIDER}/${id}`);
	return model as Model;
}

const sessions: AgentSession[] = [];
const rows: StatusLineComponent[] = [];
const tempDirs: string[] = [];
let sharedDir: string;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let isolated: IsolatedConfigRoot;

async function create(extra: Partial<CreateAgentSessionOptions>): Promise<AgentSession> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `held-at-rest-${Snowflake.next()}-`));
	tempDirs.push(tempDir);
	const cwd = path.join(tempDir, "project");
	fs.mkdirSync(cwd, { recursive: true });
	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(tempDir, "agent"),
		sessionManager: SessionManager.create(cwd, path.join(tempDir, "sessions")),
		settings: Settings.isolated(),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		modelRegistry,
		model: bundledModel(),
		...extra,
	});
	sessions.push(session);
	return session;
}

/**
 * Count every read of `parameters` on the session's active tools, the objects the tool-schema
 * estimate iterates. Each tool keeps its own getter or value; the counter wraps it on the instance.
 */
function countSchemaReads(session: AgentSession): { count: number } {
	const reads = { count: 0 };
	for (const tool of session.agent.state.tools) {
		let owner: object | null = tool;
		let descriptor: PropertyDescriptor | undefined;
		while (owner !== null && descriptor === undefined) {
			descriptor = Object.getOwnPropertyDescriptor(owner, "parameters");
			owner = Object.getPrototypeOf(owner);
		}
		if (!descriptor) throw new Error(`tool ${tool.name} has no parameters`);
		const found = descriptor;
		Object.defineProperty(tool, "parameters", {
			configurable: true,
			enumerable: true,
			get(): unknown {
				reads.count++;
				return found.get ? found.get.call(tool) : found.value;
			},
		});
	}
	return reads;
}

/** The session's status row as the interactive host mounts it. */
function mountRow(session: AgentSession): { row: StatusLineComponent; producer: StatusPresentationProducer } {
	const producer = new StatusPresentationProducer(session);
	const row = new StatusLineComponent(producer);
	rows.push(row);
	return { row, producer };
}

/** The rendered footline, ANSI stripped. */
function render(row: StatusLineComponent): string {
	return stripAnsi(row.renderQuietLine(200) ?? "");
}

/** Prompt tokens the reopened response reports beyond the non-message half. */
const ANCHOR_MESSAGE_TOKENS = 4_000;

/**
 * Reopen, held, a session whose last provider response was stamped by `stamp`, called with the
 * non-message size the same prompt measures now; `null` stamps nothing, as a response from before
 * the stamp existed. A user message the run never sent stands after it, so the resting figure has a
 * tail to estimate. The reopened session runs in the same project as the one that wrote the file,
 * so its prompt measures what the stamp recorded.
 */
async function resumeHeld(stamp: (nonMessageTokens: number) => number | null): Promise<AgentSession> {
	const writer = await create({});
	const current = computeNonMessageTokens(writer);
	const recorded = stamp(current);
	const model = bundledModel();
	const manager = writer.sessionManager;
	const promptTokens = current + ANCHOR_MESSAGE_TOKENS;
	manager.appendMessage({ role: "user", content: "hello", timestamp: 1_000 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "hello back" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: promptTokens,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: promptTokens + 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		...(recorded === null ? {} : { contextSnapshot: { promptTokens, nonMessageTokens: recorded } }),
		timestamp: 2_000,
	});
	manager.appendMessage({ role: "user", content: "a question the run never sent", timestamp: 3_000 });
	await manager.flush();
	const file = manager.getSessionFile();
	if (!file) throw new Error("the writer persisted no session file");
	const cwd = manager.getCwd();
	return create({
		cwd,
		agentDir: path.join(path.dirname(cwd), "agent"),
		sessionManager: await SessionManager.open(file, path.dirname(file)),
	});
}

beforeAll(async () => {
	sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "held-at-rest-"));
	authStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
	authStorage.setRuntimeApiKey(PROVIDER, "anthropic-test-key");
	modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir, "models.yml"));
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("theme unavailable");
	setThemeInstance(theme);
});

beforeEach(async () => {
	isolated = enterIsolatedConfigRoot("held-at-rest", { defaultProfile: true });
	resetSettingsForTest();
	resetLaunchFactsForTest();
	await Settings.init({ cwd: isolated.root });
	settings.setModelRole("default", `${PROVIDER}/${MODEL_ID}`);
	// The previous launch's reading, filed under the model only: this project was never measured.
	await recordLaunchFacts({ modelContextPercent: RECORDED_PERCENT });
});

afterEach(async () => {
	for (const row of rows.splice(0)) row.dispose();
	for (const session of sessions.splice(0).reverse()) await session.dispose();
	resetSettingsForTest();
	resetLaunchFactsForTest();
	isolated.restore();
});

afterAll(() => {
	for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
	authStorage.close();
	removeSyncWithRetries(sharedDir);
});

describe("a held at-rest reading builds no tool schema in the status row", () => {
	it("renders the row without reading any tool's schema, drawing the recorded resting gauge", async () => {
		const session = await create({});
		const reads = countSchemaReads(session);
		const { row } = mountRow(session);

		const line = render(row);

		expect(reads.count).toBe(0);
		expect(line).toContain(`${100 - RECORDED_PERCENT}% left`);
	});

	it("files no gauge from the row while the reading is held", async () => {
		const session = await create({});
		render(mountRow(session).row);

		// A later floor for the model shows through only when the row filed nothing for this project.
		await recordLaunchFacts({ modelContextPercent: 10 });

		expect(readLaunchFacts().contextPercent).toBe(10);
	});

	it("draws the unknown for a model that is not the default role the record is filed under", async () => {
		// The record stays filed under the default role; this session runs another model, by `--model`.
		const session = await create({ model: bundledModel("claude-opus-4-1") });
		const reads = countSchemaReads(session);

		const line = render(mountRow(session).row);

		expect(reads.count).toBe(0);
		expect(line).toContain("? left");
	});

	it("measures, redraws and files the reading once the host releases the hold", async () => {
		const session = await create({});
		const reads = countSchemaReads(session);
		const { row, producer } = mountRow(session);
		render(row);
		expect(reads.count).toBe(0);

		takeHeldAtRestReading(session);
		const line = render(row);

		expect(reads.count).toBeGreaterThan(0);
		const gauge = producer.getSnapshot().context;
		expect(gauge.usedTokens).toBe(session.getContextUsage()?.tokens ?? -1);
		const measured = gauge.contextPercent;
		if (measured === null) throw new Error("the released row measured no gauge");
		expect(Math.round(measured)).not.toBe(RECORDED_PERCENT);
		expect(line).not.toContain(`${100 - RECORDED_PERCENT}% left`);
		expect(readLaunchFacts().contextPercent).toBe(Math.round(measured));
	});

	it("measures the row of a held session that already holds a message", async () => {
		const session = await create({});
		session.agent.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const reads = countSchemaReads(session);

		const line = render(mountRow(session).row);

		expect(reads.count).toBeGreaterThan(0);
		expect(line).not.toContain(`${100 - RECORDED_PERCENT}% left`);
	});

	it("leaves the readings compaction and /context take measuring while the row is held", async () => {
		const held = await create({});
		const reads = countSchemaReads(held);

		const usage = held.getContextUsage();
		const breakdown = computeNonMessageBreakdown(held);

		expect(reads.count).toBeGreaterThan(0);
		expect(breakdown.toolsTokens).toBeGreaterThan(0);
		expect(usage?.tokens ?? 0).toBeGreaterThan(breakdown.toolsTokens);
	});
});

describe("a session takes its held reading when its first turn leaves rest", () => {
	/** A provider reply that ends the turn. */
	function stoppedReply(model: Model): AssistantMessageEventStream {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
		return stream;
	}

	it("holds the reading through creation and files nothing", async () => {
		const session = await create({});

		expect(isAtRestReadingDeferred(session)).toBe(true);
		expect(readLaunchFacts().contextPercent).toBe(RECORDED_PERCENT);
	});

	it("files the reading at rest before the first prompt reaches the provider, with no host", async () => {
		const session = await create({});
		const atRest = session.getContextUsage();
		if (!atRest) throw new Error("the session measured no usage at rest");
		const expected = Math.round(
			measureContextGauge(
				atRest.tokens,
				atRest.contextWindow,
				session.autoCompactionEnabled ? session.settings.getGroup("compaction") : undefined,
			).contextPercent ?? Number.NaN,
		);
		const atRequest: Array<{ held: boolean; filed: number | null }> = [];
		session.agent.streamFn = model => {
			atRequest.push({ held: isAtRestReadingDeferred(session), filed: readLaunchFacts().contextPercent });
			return stoppedReply(model);
		};

		await session.prompt("hello");

		// A gauge is filed only from a reading with no message, so the filed figure is the at-rest one.
		expect(expected).not.toBe(RECORDED_PERCENT);
		expect(atRequest).toEqual([{ held: false, filed: expected }]);
	});
});

describe("a resumed session's held reading states its resting usage without building a tool schema", () => {
	it("draws the figure the measurement reaches when the stamped size is current", async () => {
		const session = await resumeHeld(current => current);
		const reads = countSchemaReads(session);
		const { row, producer } = mountRow(session);

		render(row);
		const drawn = producer.getSnapshot().context.usedTokens;

		expect(reads.count).toBe(0);
		expect(isAtRestReadingDeferred(session)).toBe(true);
		const measured = session.getContextUsage()?.tokens;
		expect(reads.count).toBeGreaterThan(0);
		expect(drawn).toBe(measured ?? -1);
	});

	it("draws the stamped size while held and the measured one once the session leaves rest", async () => {
		// The prompt grew by 1,000 tokens outside the message list since the stamp.
		const session = await resumeHeld(current => current - 1_000);
		const { row, producer } = mountRow(session);
		render(row);
		const held = producer.getSnapshot().context.usedTokens;

		takeHeldAtRestReading(session);
		render(row);
		const released = producer.getSnapshot().context.usedTokens;

		expect(released).toBe(session.getContextUsage()?.tokens ?? -1);
		expect(held).toBe((released ?? 0) - 1_000);
	});

	it("measures a resumed session whose response stamped no size", async () => {
		const session = await resumeHeld(() => null);
		const reads = countSchemaReads(session);
		const { row, producer } = mountRow(session);

		render(row);

		expect(reads.count).toBeGreaterThan(0);
		expect(producer.getSnapshot().context.usedTokens).toBe(session.getContextUsage()?.tokens ?? -1);
	});
});

describe("the interactive host holds the reading until the session leaves rest", () => {
	const modes: InteractiveMode[] = [];
	let savedGeometry: Record<"columns" | "rows", PropertyDescriptor | undefined>;

	beforeEach(() => {
		// The host draws into a mocked terminal of fixed geometry; frames still compose and commit.
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		savedGeometry = {
			columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
			rows: Object.getOwnPropertyDescriptor(process.stdout, "rows"),
		};
		Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}
	});

	afterEach(() => {
		for (const mode of modes.splice(0)) mode.stop();
		for (const key of ["columns", "rows"] as const) {
			const descriptor = savedGeometry[key];
			if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
			else delete (process.stdout as unknown as Record<string, unknown>)[key];
		}
		vi.restoreAllMocks();
	});

	/** A real interactive host over `session`, initialised. */
	async function host(session: AgentSession): Promise<InteractiveMode> {
		const mode = new InteractiveMode(session, "test", () => {}, [], undefined, new EventBus());
		modes.push(mode);
		vi.spyOn(mode.statusLine, "watchGitState").mockImplementation(() => {});
		await mode.init();
		return mode;
	}

	/** Resolve once `mode` commits its next frame and the work that frame scheduled after itself ran. */
	async function committedFrame(mode: InteractiveMode): Promise<void> {
		const frame = Promise.withResolvers<void>();
		const previous = mode.ui.onFrameComposed;
		mode.ui.onFrameComposed = () => {
			mode.ui.onFrameComposed = previous;
			previous?.();
			frame.resolve();
		};
		// Forced, so an unchanged screen still commits a frame rather than skipping it.
		mode.ui.requestRender(true);
		await frame.promise;
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
	}

	/** Type `key` into the composer and resolve once the autocomplete it opened holds its suggestions. */
	async function typeIntoPopup(mode: InteractiveMode, key: string): Promise<void> {
		const updated = Promise.withResolvers<void>();
		const previous = mode.editor.onAutocompleteUpdate;
		mode.editor.onAutocompleteUpdate = () => {
			mode.editor.onAutocompleteUpdate = previous;
			previous?.();
			updated.resolve();
		};
		mode.editor.handleInput(key);
		await updated.promise;
	}

	/** The description the open slash popup draws for `/name`. */
	function popupDescription(mode: InteractiveMode, name: string): string | undefined {
		const item = mode.editor.getAutocompleteState()?.items.find(entry => entry.value === name);
		if (!item) throw new Error(`the popup lists no /${name}`);
		return item.description;
	}

	it("commits frames over an idle session without reading any tool's schema", async () => {
		const session = await create({});
		const reads = countSchemaReads(session);
		const mode = await host(session);

		await committedFrame(mode);
		await committedFrame(mode);

		expect(reads.count).toBe(0);
		expect(isAtRestReadingDeferred(session)).toBe(true);
	});

	it("takes the reading after the frame that draws the first edit, not inside the keystroke", async () => {
		const session = await create({});
		const reads = countSchemaReads(session);
		const mode = await host(session);
		await committedFrame(mode);

		mode.editor.handleInput("h");
		expect(reads.count).toBe(0);
		expect(isAtRestReadingDeferred(session)).toBe(true);

		await committedFrame(mode);
		expect(reads.count).toBeGreaterThan(0);
		expect(isAtRestReadingDeferred(session)).toBe(false);
		expect(readLaunchFacts().contextPercent).not.toBe(RECORDED_PERCENT);
	});

	it("takes the reading when a prompt is submitted with no edit before it", async () => {
		const session = await create({});
		const reads = countSchemaReads(session);
		const mode = await host(session);
		await committedFrame(mode);

		mode.startPendingSubmission({ text: "hello" });

		expect(reads.count).toBeGreaterThan(0);
		expect(isAtRestReadingDeferred(session)).toBe(false);
		expect(readLaunchFacts().contextPercent).not.toBe(RECORDED_PERCENT);
	});

	// The characters that open a popup on an empty composer (`Editor#insertCharacter`). The release the
	// keystroke queues after its frame is held off, so a read counted here is the popup's own.
	it.each(["/", "@", "#"])("opens the %s popup on a first keystroke without reading any tool's schema", async key => {
		const session = await create({});
		const reads = countSchemaReads(session);
		const mode = await host(session);
		await committedFrame(mode);
		vi.spyOn(mode, "takeAtRestReading").mockImplementation(() => {});

		await typeIntoPopup(mode, key);

		expect(reads.count).toBe(0);
		expect(isAtRestReadingDeferred(session)).toBe(true);
	});

	it("states no context figure in the slash popup a first keystroke opens", async () => {
		const session = await create({});
		const mode = await host(session);
		await committedFrame(mode);

		await typeIntoPopup(mode, "/");

		// The popup lands before the frame that releases the hold.
		expect(isAtRestReadingDeferred(session)).toBe(true);
		expect(popupDescription(mode, "context")).toBe("Show context usage breakdown");
		expect(popupDescription(mode, "compact")).toBe("Compact the session context");
	});

	it("states the measured context in the slash popup once the session left rest", async () => {
		const session = await create({});
		const mode = await host(session);
		await committedFrame(mode);
		mode.takeAtRestReading();
		const usage = session.getContextUsage();
		if (!usage) throw new Error("the released session measured no usage");

		await typeIntoPopup(mode, "/");

		expect(popupDescription(mode, "context")).toContain(
			`${usage.tokens.toLocaleString()}/${usage.contextWindow.toLocaleString()}`,
		);
		expect(popupDescription(mode, "compact")).toBe(
			`Compact the session context · ${Math.round(usage.percent)}% used`,
		);
	});

	it("commits a resumed session's frames and opens its slash popup stating the resting usage without reading any tool's schema", async () => {
		const session = await resumeHeld(current => current);
		const reads = countSchemaReads(session);
		const mode = await host(session);
		await committedFrame(mode);
		vi.spyOn(mode, "takeAtRestReading").mockImplementation(() => {});

		await typeIntoPopup(mode, "/");

		expect(reads.count).toBe(0);
		const context = popupDescription(mode, "context");
		const compact = popupDescription(mode, "compact");
		const usage = session.getContextUsage();
		if (!usage) throw new Error("the resumed session measured no usage");
		expect(context).toContain(`${usage.tokens.toLocaleString()}/${usage.contextWindow.toLocaleString()}`);
		expect(compact).toBe(`Compact the session context · ${Math.round(usage.percent)}% used`);
	});
});
