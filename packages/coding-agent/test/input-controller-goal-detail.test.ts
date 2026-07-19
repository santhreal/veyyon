import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InputController } from "@veyyon/coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";

/**
 * GMI-2: down-arrow on an empty composer opens the goal detail/action menu, but
 * only while a goal is active or paused and the editor is focused — it must never
 * steal `down` during ordinary editing. Assert exact call behavior of the input
 * listener, not `!is_empty`.
 */

const DOWN = "\x1b[B";

// A permissive fake editor: `setupKeyHandlers` assigns many `on*` handlers and
// calls several no-op setters. A Proxy absorbs all of those without enumerating
// every member, while `getText`/`setText` back the one field the listener reads.
function createFakeEditor(): { editor: unknown; setText: (t: string) => void } {
	let text = "";
	const editor = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === "getText") return () => text;
				if (prop === "setText")
					return (t: string) => {
						text = t;
					};
				// Any other access (setActionKeys, clearCustomKeyHandlers, ...) is a no-op fn.
				return () => {};
			},
			set() {
				return true;
			},
		},
	);
	return {
		editor,
		setText: (t: string) => {
			text = t;
		},
	};
}

function createContext(opts: { goalModeEnabled?: boolean; goalModePaused?: boolean; focused?: boolean }): {
	ctx: InteractiveModeContext;
	openGoalDetail: ReturnType<typeof vi.fn>;
	setText: (t: string) => void;
	feedDown: () => { consume?: boolean } | undefined;
} {
	const { editor, setText } = createFakeEditor();
	const inputListeners: Array<(data: string) => { consume?: boolean } | undefined> = [];
	const openGoalDetail = vi.fn(async () => {});
	const focusedTarget = opts.focused === false ? {} : editor;

	// Permissive ui: setupKeyHandlers touches several ui methods (addStartListener,
	// onDebug, ...). Only addInputListener (collect) and getFocused (focus check)
	// need real behavior; everything else is an absorbed no-op.
	const ui = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === "addInputListener") {
					return (listener: (data: string) => { consume?: boolean } | undefined) => {
						inputListeners.push(listener);
						return () => {};
					};
				}
				if (prop === "getFocused") return () => focusedTarget;
				return () => {};
			},
			set() {
				return true;
			},
		},
	);

	const ctx = {
		editor,
		ui,
		keybindings: { getKeys: () => [] },
		session: { extensionRunner: undefined },
		goalModeEnabled: opts.goalModeEnabled ?? false,
		goalModePaused: opts.goalModePaused ?? false,
		openGoalDetail,
		canBranchBtw: () => false,
		canCopyBtw: () => false,
		focusedAgentId: undefined,
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		openGoalDetail,
		setText,
		feedDown: () => {
			let result: { consume?: boolean } | undefined;
			for (const listener of inputListeners) {
				const r = listener(DOWN);
				if (r && result === undefined) result = r;
			}
			return result;
		},
	};
}

beforeEach(async () => {
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("InputController goal-detail down-arrow affordance", () => {
	it("opens the goal detail menu on down-arrow when a goal is active and the composer is empty", () => {
		const { ctx, openGoalDetail, feedDown } = createContext({ goalModeEnabled: true });
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		const result = feedDown();
		expect(openGoalDetail).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ consume: true });
	});

	it("opens the goal detail menu on down-arrow when a goal is paused", () => {
		const { ctx, openGoalDetail, feedDown } = createContext({ goalModePaused: true });
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		feedDown();
		expect(openGoalDetail).toHaveBeenCalledTimes(1);
	});

	it("ignores down-arrow when no goal is active or paused (does not steal the key)", () => {
		const { ctx, openGoalDetail, feedDown } = createContext({ goalModeEnabled: false, goalModePaused: false });
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		const result = feedDown();
		expect(openGoalDetail).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
	});

	it("ignores down-arrow when the composer has a draft", () => {
		const { ctx, openGoalDetail, setText, feedDown } = createContext({ goalModeEnabled: true });
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		setText("half-written prompt");

		const result = feedDown();
		expect(openGoalDetail).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
	});

	it("ignores down-arrow when the editor is not focused", () => {
		const { ctx, openGoalDetail, feedDown } = createContext({ goalModeEnabled: true, focused: false });
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		const result = feedDown();
		expect(openGoalDetail).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
	});
});
