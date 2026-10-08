/**
 * WHY: the status row ran `git status` on any render once its last answer was a second old, and a
 * streaming turn renders every frame, so a turn ran one `git status` subprocess per second for a
 * marker that is one glyph. A 44-second streaming turn in a 12,000-file tree ran 41 of them, 1.9 s
 * of CPU in children against the session's own 3.2 s.
 *
 * Class closed: every way the marker is refreshed. With nothing that can have moved the tree, the
 * row runs `git status` once per GIT_STATUS_MAX_AGE_MS however often it renders. Each event that
 * can move the tree refreshes it on the next render instead: the turn's end, a `!` or `%`
 * command, and a HEAD change. A refresh asked for while a lookup is running looks again when that
 * lookup lands, because the running one may have read the tree before the move. The callers are
 * driven through the real controllers and the real watcher, so dropping a call site turns its
 * case red.
 *
 * Not caught: a new way the session can move the tree that does not call `refreshGitStatus`, such
 * as a tool's write in the middle of a turn, appears up to GIT_STATUS_MAX_AGE_MS late. That bound is
 * the first case here, not a refresh.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetLaunchFactsForTest } from "@veyyon/coding-agent/config/launch-facts";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { StatusLineSettings } from "@veyyon/coding-agent/modes/terminal/components/status-line";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/terminal/components/status-line";
import { CommandController } from "@veyyon/coding-agent/modes/terminal/controllers/command-controller";
import { EventController } from "@veyyon/coding-agent/modes/terminal/controllers/event-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { StatusPresentationProducer } from "@veyyon/coding-agent/presentation/status-producer";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { GitRefHead, GitStatusSummary } from "@veyyon/coding-agent/utils/git";
import * as git from "@veyyon/coding-agent/utils/git";
import { TERMINAL } from "@veyyon/tui";
import { getProjectDir, setProjectDir } from "@veyyon/utils";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../utils/test/helpers/isolated-config-root";
import { statusLineSessionParts } from "./helpers/status-line-session";

const originalProjectDir = getProjectDir();
let isolated: IsolatedConfigRoot;

/** The clock every render and every lookup reads; a case moves it by hand. */
const T0 = 1_000_000;
const clock = { now: T0 };

/** One spinner frame, the rate a streaming turn renders at. */
const FRAME_MS = 80;

const featureHead: GitRefHead = {
	kind: "ref",
	branchName: "feature",
	ref: "refs/heads/feature",
	commit: null,
	commonDir: "/repo/.git",
	gitDir: "/repo/.git",
	gitEntryPath: "/repo/.git",
	headPath: "/repo/.git/HEAD",
	repoRoot: "/repo",
	headContent: "ref: refs/heads/feature\n",
};

const CLEAN: GitStatusSummary = { staged: 0, unstaged: 0, untracked: 0, truncated: false };
const DIRTY: GitStatusSummary = { staged: 1, unstaged: 0, untracked: 0, truncated: false };

/** The git segment and nothing else that runs a subprocess, so `git status` is the one lookup. */
const gitRow: StatusLineSettings = { preset: "custom", leftSegments: ["git"], rightSegments: ["session_name"] };

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

beforeEach(() => {
	isolated = enterIsolatedConfigRoot("dirty-marker-cadence", { defaultProfile: true });
	resetLaunchFactsForTest();
	clock.now = T0;
	vi.spyOn(Date, "now").mockImplementation(() => clock.now);
	vi.spyOn(git.head, "resolveSync").mockReturnValue(featureHead);
	vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	resetLaunchFactsForTest();
	isolated.restore();
});

/** The clock reading at each `git status`, answered in turn by `answers`. */
function lookups(...answers: (() => Promise<GitStatusSummary | null>)[]): number[] {
	const at: number[] = [];
	vi.spyOn(git.status, "summary").mockImplementation(() => {
		at.push(clock.now);
		const answer = answers.shift();
		if (!answer) throw new Error(`git status #${at.length} has no answer`);
		return answer();
	});
	return at;
}

const answer = (status: GitStatusSummary) => async () => status;

/** Let a lookup that has answered land: its continuation, its `finally` and the repaint it asks for. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

/** A row on `cwd` whose repaints are recorded as the row each one drew. */
function mount(cwd = "/repo") {
	const parts = {
		...statusLineSessionParts({ sessionName: "dirty marker", messages: [], cwd: () => cwd }),
		state: { messages: [], model: undefined },
		model: undefined,
		getAsyncJobSnapshot: () => ({ running: [] }),
	};
	const component = new StatusLineComponent(new StatusPresentationProducer(parts as unknown as AgentSession));
	component.updateSettings(gitRow);
	const rows: (string | null)[] = [];
	component.watchGitState(() => {
		rows.push(component.renderQuietLine(120));
	});
	return { component, repaints: () => rows };
}

describe("the dirty marker on a row that renders every frame", () => {
	it("runs `git status` once per GIT_STATUS_MAX_AGE_MS while nothing can have moved the tree", async () => {
		const answers = Array.from({ length: 7 }, () => answer(CLEAN));
		const at = lookups(...answers);
		const { component } = mount();

		for (; clock.now <= T0 + 60_000; clock.now += FRAME_MS) {
			component.renderQuietLine(120);
			await settle();
		}

		// One lookup per GIT_STATUS_MAX_AGE_MS of frames, not one per second of them.
		expect(at.map(time => time - T0)).toEqual([0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000]);
		component.dispose();
	});

	it("runs `git status` on the render a refresh asks for, then returns to its cadence", async () => {
		const at = lookups(answer(CLEAN), answer(DIRTY), answer(DIRTY));
		const { component, repaints } = mount();
		component.renderQuietLine(120);
		await settle();

		clock.now += FRAME_MS;
		component.refreshGitStatus();
		await settle();

		expect(at).toEqual([T0, T0 + FRAME_MS]);
		// The repaint the refresh asked for, then the one its answer moved.
		expect(repaints()).toEqual([expect.not.stringContaining("*"), expect.stringContaining("*")]);

		// The answered refresh is spent: the frames after it wait out the age bound again.
		const refreshedAt = clock.now;
		for (clock.now += FRAME_MS; clock.now <= refreshedAt + 10_000; clock.now += FRAME_MS) {
			component.renderQuietLine(120);
			await settle();
		}
		expect(at).toEqual([T0, T0 + FRAME_MS, refreshedAt + 10_000]);
		component.dispose();
	});

	it("looks again when a lookup lands that started before the refresh", async () => {
		const running = Promise.withResolvers<GitStatusSummary | null>();
		const at = lookups(() => running.promise, answer(DIRTY));
		const { component, repaints } = mount();
		component.renderQuietLine(120);

		clock.now += FRAME_MS;
		component.refreshGitStatus();
		expect(at).toEqual([T0]);

		// The running lookup read the tree before the move and answers clean.
		running.resolve(CLEAN);
		await settle();

		expect(at).toEqual([T0, T0 + FRAME_MS]);
		expect(repaints().at(-1)).toContain("*");
		component.dispose();
	});

	it("runs `git status` when HEAD changes", async () => {
		const repo = path.join(isolated.root, "repo");
		fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
		const head = path.join(repo, ".git", "HEAD");
		fs.writeFileSync(head, "ref: refs/heads/feature\n");
		const lookedAgain = Promise.withResolvers<void>();
		const at = lookups(
			answer(CLEAN),
			async () => {
				lookedAgain.resolve();
				return DIRTY;
			},
			answer(DIRTY),
			answer(DIRTY),
		);
		// The branch's pull request lookup answers at once and asks for a repaint of its own, so a repaint
		// lands before the watcher reports the write. Only a refresh starts a lookup on a frozen clock.
		vi.spyOn(git.github, "run").mockResolvedValue({ exitCode: 1, stdout: "", stderr: "" });
		vi.spyOn(git.branch, "default").mockResolvedValue(null);
		const { component } = mount(repo);
		try {
			component.renderQuietLine(120);
			await settle();

			fs.writeFileSync(head, "ref: refs/heads/other\n");
			await lookedAgain.promise;

			expect(at.slice(0, 2)).toEqual([T0, T0]);
		} finally {
			component.dispose();
		}
	});
});

/** The context members a turn's end reaches, with the real row in it. */
function turnContext(statusLine: StatusLineComponent): InteractiveModeContext {
	return {
		isInitialized: true,
		settings: { get: () => false },
		statusLine,
		pendingTools: new Map<string, unknown>(),
		settledToolCalls: new Set<string>(),
		hideThinkingBlock: false,
		setWorkingMessage: vi.fn(),
		clearPinnedError: vi.fn(),
		loadingAnimation: undefined,
		clearWorkingLoader: () => false,
		retryLoader: undefined,
		streamingComponent: undefined,
		streamingMessage: undefined,
		statusContainer: { clear: vi.fn(), disposeChildren: vi.fn() },
		chatContainer: { removeChild: vi.fn() },
		flushPendingModelSwitch: vi.fn(async () => {}),
		editor: { getText: () => "" },
		sessionManager: { getSessionName: () => "dirty marker" },
		ensureLoadingAnimation: vi.fn(),
		ui: { requestRender: vi.fn() },
		viewSession: { isCompacting: false, getLastAssistantMessage: () => undefined },
		session: { isStreaming: false, getToolByName: () => undefined },
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;
}

/** The context members a `!` or `%` command reaches, with the real row in it. */
function shortcutContext(statusLine: StatusLineComponent): InteractiveModeContext {
	const container = () => ({ children: [] as unknown[], addChild: vi.fn() });
	const result = {
		output: "",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
	};
	return {
		statusLine,
		session: { isStreaming: false, executeBash: async () => result, executePython: async () => result },
		chatContainer: container(),
		pendingMessagesContainer: container(),
		pendingBashComponents: [],
		pendingPythonComponents: [],
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		present: vi.fn(),
		showError: vi.fn(),
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;
}

describe("the events that can move the tree refresh the dirty marker", () => {
	it("refreshes it when the turn ends", async () => {
		const at = lookups(answer(CLEAN), answer(DIRTY));
		const { component, repaints } = mount();
		component.renderQuietLine(120);
		await settle();

		clock.now += FRAME_MS;
		await new EventController(turnContext(component)).handleEvent({
			type: "agent_end",
			messages: [],
		} as unknown as AgentSessionEvent);
		await settle();

		expect(at).toEqual([T0, T0 + FRAME_MS]);
		expect(repaints().at(-1)).toContain("*");
		component.dispose();
	});

	it.each(["handleBashCommand", "handlePythonCommand"] as const)("refreshes it after %s", async handler => {
		const at = lookups(answer(CLEAN), answer(DIRTY));
		const { component, repaints } = mount();
		component.renderQuietLine(120);
		await settle();

		clock.now += FRAME_MS;
		await new CommandController(shortcutContext(component))[handler]("touch file", false);
		await settle();

		expect(at).toEqual([T0, T0 + FRAME_MS]);
		expect(repaints().at(-1)).toContain("*");
		component.dispose();
	});
});
