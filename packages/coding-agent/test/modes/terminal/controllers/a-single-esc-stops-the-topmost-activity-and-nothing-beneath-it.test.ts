/**
 * WHY. One Esc press stops one thing. The composer advertises "esc to cancel" on side-channel panels,
 * context maintenance, speech, loop mode, a focused agent view, a collab guest's host turn, a pending
 * submission, a bash command, an eval and a streaming turn, and several of these run at once. An Esc
 * that reached past the topmost activity killed work the reader did not point at; one that stopped
 * short left the advertised activity running.
 *
 * THE CLASS. Every combination of the activities Esc dispatches on, with a collab guest absent, idle
 * or streaming. For each, one press performs exactly the actions of the topmost activity, in the
 * documented order, and nothing else: no abort, mode change, editor write, render or double-Esc
 * arming from any activity beneath it. Main-view maintenance yields to a focused agent view (#2819).
 *
 * WHAT THIS SUITE DOES NOT CATCH. A second press: the draft discard and the double-Esc action are
 * defended by the Esc-Esc suites. A side-channel panel that declines its Esc, and a pending
 * submission that cannot be cancelled and restores its queue, are defended there too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InputController } from "@veyyon/coding-agent/modes/terminal/controllers/input-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { vocalizer } from "@veyyon/coding-agent/speech/tts/vocalizer";

/** Every activity Esc dispatches on that is either running or not, topmost first. */
const FLAGS = [
	"btw",
	"omfg",
	"compaction",
	"handoff",
	"retry",
	"speech",
	"loop",
	"focused",
	"pending",
	"bashRunning",
	"bashMode",
	"evalRunning",
	"pythonMode",
	"streaming",
	"draft",
] as const;
type Flag = (typeof FLAGS)[number];
type GuestState = "none" | "idle" | "streaming";
const GUEST_STATES: readonly GuestState[] = ["none", "idle", "streaming"];

interface Scene {
	readonly on: ReadonlySet<Flag>;
	readonly guest: GuestState;
}

/**
 * The documented precedence: the first row whose activity is running takes the press, and the
 * actions listed are all it does.
 */
const PRECEDENCE: ReadonlyArray<{
	readonly takes: (s: Scene) => boolean;
	readonly actions: (s: Scene) => string[];
}> = [
	{ takes: s => s.on.has("btw"), actions: () => ["btw:escape"] },
	{ takes: s => s.on.has("omfg"), actions: () => ["omfg:escape"] },
	{
		takes: s => !s.on.has("focused") && (s.on.has("compaction") || s.on.has("handoff") || s.on.has("retry")),
		actions: s =>
			(["compaction", "handoff", "retry"] as const).filter(kind => s.on.has(kind)).map(kind => `abort:${kind}`),
	},
	{ takes: s => s.on.has("speech"), actions: () => ["speech:clear", "lastEscapeTime=0"] },
	{
		takes: s => s.on.has("loop"),
		actions: s => ["loop:pause", s.on.has("streaming") ? "abort:turn" : "pending:cancel"],
	},
	{ takes: s => s.on.has("focused"), actions: s => (s.on.has("draft") ? ["editor:set:", "render"] : ["unfocus"]) },
	{
		takes: s => s.guest !== "none",
		actions: s => (s.guest === "streaming" || s.on.has("pending") ? ["guest:abort"] : []),
	},
	{ takes: s => s.on.has("pending"), actions: () => ["pending:cancel"] },
	{ takes: s => s.on.has("bashRunning"), actions: () => ["abort:bash"] },
	{
		takes: s => s.on.has("bashMode"),
		actions: s => ["editor:set:", `border:bash=false,python=${s.on.has("pythonMode")}`],
	},
	{ takes: s => s.on.has("evalRunning"), actions: () => ["abort:eval"] },
	{
		takes: s => s.on.has("pythonMode"),
		actions: s => ["editor:set:", `border:bash=${s.on.has("bashMode")},python=false`],
	},
	{ takes: s => s.on.has("streaming"), actions: () => ["abort:turn"] },
	{ takes: s => s.on.has("draft"), actions: () => ["lastEscapeTime=0"] },
	{ takes: () => true, actions: () => ["lastEscapeTime=now"] },
];

function expectedActions(scene: Scene): string[] {
	const row = PRECEDENCE.find(entry => entry.takes(scene));
	return row ? row.actions(scene) : [];
}

/** Builds a context in the scene's state whose every Esc-reachable action appends to `log`. */
function stage(scene: Scene, log: string[]): InteractiveModeContext {
	const on = (flag: Flag): boolean => scene.on.has(flag);
	let text = on("draft") ? "a draft" : "";
	let lastEscapeTime = 0;
	let isBashMode = on("bashMode");
	let isPythonMode = on("pythonMode");
	const ctx = {
		editor: {
			getText: () => text,
			setText: (value: string) => {
				text = value;
				log.push(`editor:set:${value}`);
			},
			discardDraft: () => log.push("editor:discard"),
			setActionKeys: () => {},
			setCustomKeyHandler: () => {},
			clearCustomKeyHandlers: () => {},
			pendingImages: [],
			pendingImageLinks: [],
		},
		ui: {
			requestRender: () => log.push("render"),
			resetDisplay: () => log.push("resetDisplay"),
			addInputListener: () => () => {},
			addStartListener: () => {},
		},
		keybindings: { getKeys: () => [] },
		session: {
			extensionRunner: undefined,
			isStreaming: on("streaming"),
			isBashRunning: on("bashRunning"),
			isEvalRunning: on("evalRunning"),
			abort: () => {
				log.push("abort:turn");
				return undefined;
			},
			abortBash: () => log.push("abort:bash"),
			abortEval: () => log.push("abort:eval"),
		},
		viewSession: {
			isCompacting: on("compaction"),
			isGeneratingHandoff: on("handoff"),
			isRetrying: on("retry"),
			abortCompaction: () => log.push("abort:compaction"),
			abortHandoff: () => log.push("abort:handoff"),
			abortRetry: () => log.push("abort:retry"),
		},
		hasActiveBtw: () => on("btw"),
		handleBtwEscape: () => {
			log.push("btw:escape");
			return true;
		},
		hasActiveOmfg: () => on("omfg"),
		handleOmfgEscape: () => {
			log.push("omfg:escape");
			return true;
		},
		loopModeEnabled: on("loop"),
		pauseLoop: () => log.push("loop:pause"),
		focusedAgentId: on("focused") ? "agent-1" : undefined,
		unfocusSession: async () => {
			log.push("unfocus");
		},
		collabGuest:
			scene.guest === "none"
				? undefined
				: {
						state: { isStreaming: scene.guest === "streaming" },
						sendAbort: () => log.push("guest:abort"),
					},
		loadingAnimation: on("pending") ? {} : undefined,
		cancelPendingSubmission: () => {
			log.push("pending:cancel");
			return on("pending");
		},
		get isBashMode() {
			return isBashMode;
		},
		set isBashMode(value: boolean) {
			isBashMode = value;
		},
		get isPythonMode() {
			return isPythonMode;
		},
		set isPythonMode(value: boolean) {
			isPythonMode = value;
		},
		updateEditorBorderColor: () => log.push(`border:bash=${isBashMode},python=${isPythonMode}`),
		get lastEscapeTime() {
			return lastEscapeTime;
		},
		set lastEscapeTime(value: number) {
			lastEscapeTime = value;
			log.push(`lastEscapeTime=${value === 0 ? "0" : "now"}`);
		},
		showTreeSelector: () => log.push("tree"),
		showUserMessageSelector: () => log.push("branch"),
	};
	return ctx as unknown as InteractiveModeContext;
}

/** What the spied vocalizer reports and where its `clear` lands, for the press in progress. */
let speech: { speaking: boolean; log: string[] } = { speaking: false, log: [] };

/** Presses Esc once on a fresh controller in `scene` and returns every action it took, in order. */
function pressEsc(scene: Scene): string[] {
	const log: string[] = [];
	speech = { speaking: scene.on.has("speech"), log };
	const ctx = stage(scene, log);
	new InputController(ctx).setupKeyHandlers();
	ctx.editor.onEscape?.();
	return log;
}

function* everyScene(): Generator<Scene> {
	for (let mask = 0; mask < 1 << FLAGS.length; mask++) {
		const on = new Set(FLAGS.filter((_, bit) => (mask & (1 << bit)) !== 0));
		for (const guest of GUEST_STATES) yield { on, guest };
	}
}

function describeScene(scene: Scene): string {
	return `${[...scene.on].join("+") || "idle"} guest=${scene.guest}`;
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	vi.spyOn(vocalizer, "isSpeaking").mockImplementation(() => speech.speaking);
	vi.spyOn(vocalizer, "clear").mockImplementation(() => {
		speech.log.push("speech:clear");
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("a single Esc stops the topmost activity and nothing beneath it", () => {
	it("every combination of running activities hands the press to the topmost one alone", () => {
		const mismatches: string[] = [];
		let scenes = 0;
		for (const scene of everyScene()) {
			scenes++;
			const actions = pressEsc(scene);
			const expected = expectedActions(scene);
			if (mismatches.length < 20 && JSON.stringify(actions) !== JSON.stringify(expected)) {
				mismatches.push(
					`${describeScene(scene)}: got ${JSON.stringify(actions)}, want ${JSON.stringify(expected)}`,
				);
			}
		}
		expect(mismatches).toEqual([]);
		expect(scenes).toBe((1 << FLAGS.length) * GUEST_STATES.length);
	});

	it("a focused agent view takes the press from main-view maintenance and aborts none of it", () => {
		for (const kind of ["compaction", "handoff", "retry"] as const) {
			expect(pressEsc({ on: new Set([kind, "focused"]), guest: "none" })).toEqual(["unfocus"]);
			expect(pressEsc({ on: new Set([kind]), guest: "none" })).toEqual([`abort:${kind}`]);
		}
	});
});
