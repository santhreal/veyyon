/**
 * WHY. The driver previously maintained a separate `DialogComponent` prototype
 * class with parallel state management and custom rendering that diverged from
 * production terminal components. `createDialogComponent` consolidates all
 * `DialogViewModel` presentation onto production `HookSelectorComponent` and
 * `HookInputComponent` instances.
 *
 * THE CLASS THIS CLOSES.
 * - Single-key shortcuts `y`/`n` immediately confirm/cancel or approve/deny in confirm and tool approval dialogs.
 * - Multi-select toggles options with Space and pointer click, returning all checked values on Enter.
 * - Duplicate label options are disambiguated by index, returning exact values.
 * - Confirm dialogs with identical confirm/cancel labels are disambiguated by index.
 * - Destructive confirm defaults to cancellation on Enter.
 * - Empty options and all-disabled option lists handle gracefully without crashing.
 * - Filtering narrows option lists and selects the exact filtered option value.
 * - Timeouts settle as cancelled even if onTimeout callback throws, exactly once.
 * - User interactions after initial settlement cannot trigger duplicate answer callbacks.
 * - Masked prompt inputs preserve credential mode and return raw entered values.
 * - Tool approvals support one-time approval, session remember, denial, and denial with reason.
 *
 * WHAT IT DOES NOT CATCH. Lower-level ANSI color blending and terminal resize reflows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createDialogComponent } from "@veyyon/coding-agent/modes/terminal/components/dialogs/dialog-factory";
import type { HookInputComponent } from "@veyyon/coding-agent/modes/terminal/components/dialogs/hook-input";
import { HookSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/hook-selector";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { DEFAULT_MASK_CHAR, TUI } from "@veyyon/tui";
import { setKeybindings } from "@veyyon/utils/keybindings";
import type {
	ConfirmDialog,
	DialogResult,
	PromptDialog,
	SelectDialog,
	ToolApprovalDialog,
} from "@veyyon/wire/presentation";
import { VirtualTerminal } from "../../../../../../hosts/terminal/engine/test/virtual-terminal";
import {
	beginSettingsTest,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../../../helpers/settings-test-state";

const WIDTH = 120;
const ROWS = 40;

function createTui(): TUI {
	return new TUI(new VirtualTerminal(WIDTH, ROWS));
}

let settingsState: SettingsTestState | undefined;
beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
	setKeybindings(KeybindingsManager.inMemory());
});

afterEach(() => {
	vi.useRealTimers();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

describe("createDialogComponent production dialog behaviors", () => {
	describe("confirm dialog shortcuts and defaults", () => {
		it("non-destructive confirm defaults to confirmLabel (index 0) and submits confirmed on Enter", () => {
			const answers: DialogResult[] = [];
			const dialog: ConfirmDialog = {
				kind: "confirm",
				id: "conf-1",
				title: "Save changes?",
				body: "This will write to disk.",
				confirmLabel: "Save",
				cancelLabel: "Discard",
				destructive: false,
			};

			const component = createDialogComponent(dialog, r => answers.push(r));
			component.handleInput?.("\r");
			expect(answers).toEqual([{ outcome: "confirmed" }]);
		});

		it("destructive confirm defaults to cancelLabel (index 1) and submits cancelled on Enter", () => {
			const answers: DialogResult[] = [];
			const dialog: ConfirmDialog = {
				kind: "confirm",
				id: "conf-2",
				title: "Delete file?",
				body: "This cannot be undone.",
				confirmLabel: "Delete",
				cancelLabel: "Cancel",
				destructive: true,
			};

			const component = createDialogComponent(dialog, r => answers.push(r));
			component.handleInput?.("\r");
			expect(answers).toEqual([{ outcome: "cancelled" }]);
		});

		it("answers confirmed immediately on 'y' key shortcut", () => {
			const answers: DialogResult[] = [];
			const dialog: ConfirmDialog = {
				kind: "confirm",
				id: "conf-y",
				title: "Proceed?",
				body: "",
				confirmLabel: "Yes",
				cancelLabel: "No",
				destructive: true, // Even if destructive, 'y' explicitly confirms
			};

			const component = createDialogComponent(dialog, r => answers.push(r));
			component.handleInput?.("y");
			expect(answers).toEqual([{ outcome: "confirmed" }]);
		});

		it("answers cancelled immediately on 'n' key shortcut", () => {
			const answers: DialogResult[] = [];
			const dialog: ConfirmDialog = {
				kind: "confirm",
				id: "conf-n",
				title: "Proceed?",
				body: "",
				confirmLabel: "Yes",
				cancelLabel: "No",
				destructive: false,
			};

			const component = createDialogComponent(dialog, r => answers.push(r));
			component.handleInput?.("n");
			expect(answers).toEqual([{ outcome: "cancelled" }]);
		});

		it("disambiguates confirm and cancel when both labels have identical text strings", () => {
			const answersConfirm: DialogResult[] = [];
			const dialogSame: ConfirmDialog = {
				kind: "confirm",
				id: "conf-same",
				title: "Action",
				body: "Message",
				confirmLabel: "Continue",
				cancelLabel: "Continue",
				destructive: false,
			};

			// Selecting index 0 (default on non-destructive) confirms
			const comp1 = createDialogComponent(dialogSame, r => answersConfirm.push(r));
			comp1.handleInput?.("\r");
			expect(answersConfirm).toEqual([{ outcome: "confirmed" }]);

			// Moving down to index 1 cancels despite identical label text
			const answersCancel: DialogResult[] = [];
			const comp2 = createDialogComponent(dialogSame, r => answersCancel.push(r));
			comp2.handleInput?.("\x1b[B"); // down arrow
			comp2.handleInput?.("\r");
			expect(answersCancel).toEqual([{ outcome: "cancelled" }]);
		});

		it("escape key cancels confirmation", () => {
			const answers: DialogResult[] = [];
			const dialog: ConfirmDialog = {
				kind: "confirm",
				id: "conf-3",
				title: "Continue?",
				body: "",
				confirmLabel: "Yes",
				cancelLabel: "No",
				destructive: false,
			};

			const component = createDialogComponent(dialog, r => answers.push(r));
			component.handleInput?.("\x1b");
			expect(answers).toEqual([{ outcome: "cancelled" }]);
		});
	});

	describe("select dialog", () => {
		it("selects option returning its underlying value", () => {
			const answers: DialogResult[] = [];
			const dialog: SelectDialog = {
				kind: "select",
				id: "sel-1",
				title: "Pick environment",
				options: [
					{ value: "env-prod", label: "Production", description: "Live" },
					{ value: "env-stage", label: "Staging", description: "Test" },
				],
				selectedIndex: 1,
				multi: false,
				filterable: false,
			};

			const component = createDialogComponent(dialog, r => answers.push(r));
			component.handleInput?.("\r");
			expect(answers).toEqual([{ outcome: "selected", values: ["env-stage"] }]);
		});

		it("disambiguates duplicate option labels by resolving exact option value by index", () => {
			const answers: DialogResult[] = [];
			const dialog: SelectDialog = {
				kind: "select",
				id: "sel-dup",
				title: "Choose branch",
				options: [
					{ value: "remote/main", label: "main" },
					{ value: "local/main", label: "main" },
				],
				selectedIndex: 1, // Pre-highlight local/main
				multi: false,
				filterable: false,
			};

			const component = createDialogComponent(dialog, r => answers.push(r));

			// Enter submits index 1 ("local/main") even though label is identical to index 0
			component.handleInput?.("\r");
			expect(answers).toEqual([{ outcome: "selected", values: ["local/main"] }]);
		});

		it("supports multi-select toggling with Space and submitting multiple values on Enter", () => {
			const answers: DialogResult[] = [];
			const dialog: SelectDialog = {
				kind: "select",
				id: "sel-multi",
				title: "Select features",
				options: [
					{ value: "feat-auth", label: "Authentication" },
					{ value: "feat-db", label: "Database" },
					{ value: "feat-cache", label: "Caching" },
				],
				selectedIndex: 0,
				multi: true,
				filterable: false,
			};

			const component = createDialogComponent(dialog, r => answers.push(r));

			// Toggle index 0 (Authentication)
			component.handleInput?.(" ");
			// Move down to index 1 (Database)
			component.handleInput?.("\x1b[B");
			// Toggle index 1 (Database)
			component.handleInput?.(" ");
			// Move down to index 2 (Caching)
			component.handleInput?.("\x1b[B");
			// Submit with Enter
			component.handleInput?.("\r");

			expect(answers).toEqual([{ outcome: "selected", values: ["feat-auth", "feat-db"] }]);
		});

		it.each([false, true])("submits no choices after every check is cleared, filtering: %s", filterable => {
			const answers: DialogResult[] = [];
			const component = createDialogComponent(
				{
					kind: "select",
					id: "empty-checks",
					title: "Features",
					options: [
						{ value: "first", label: "First" },
						{ value: "second", label: "Second" },
					],
					selectedIndex: 0,
					multi: true,
					filterable,
				},
				answer => answers.push(answer),
			);
			component.handleInput?.(" ");
			component.handleInput?.(" ");
			component.handleInput?.("\r");
			expect(answers).toEqual([{ outcome: "selected", values: [] }]);
		});

		it("does not check a disabled initially highlighted option", () => {
			const answers: DialogResult[] = [];
			const component = createDialogComponent(
				{
					kind: "select",
					id: "disabled-check",
					title: "Features",
					options: [
						{ value: "disabled", label: "Disabled", disabled: true },
						{ value: "enabled", label: "Enabled" },
					],
					selectedIndex: 0,
					multi: true,
					filterable: false,
				},
				answer => answers.push(answer),
			);
			component.handleInput?.(" ");
			component.handleInput?.("\r");
			expect(answers).toEqual([{ outcome: "selected", values: ["enabled"] }]);
		});

		it("preserves checkbox-marker menus without enabling multi-submit", () => {
			const answers: string[] = [];
			const component = new HookSelectorComponent(
				"Menu",
				["First", "Second"],
				value => answers.push(value),
				() => {},
				{ selectionMarker: "checkbox", checkedIndices: [0] },
			);
			component.handleInput("\x1b[B");
			component.handleInput("\r");
			expect(answers).toEqual(["Second"]);
		});

		it("skips disabled options when navigating", () => {
			const answers: DialogResult[] = [];
			const dialog: SelectDialog = {
				kind: "select",
				id: "sel-dis",
				title: "Items",
				options: [
					{ value: "opt-1", label: "Option 1", disabled: true },
					{ value: "opt-2", label: "Option 2" },
					{ value: "opt-3", label: "Option 3", disabled: true },
					{ value: "opt-4", label: "Option 4" },
				],
				selectedIndex: 0,
				multi: false,
				filterable: false,
			};

			const component = createDialogComponent(dialog, r => answers.push(r));

			// Coerced from 0 to 1 because 0 is disabled
			component.handleInput?.("\r");
			expect(answers).toEqual([{ outcome: "selected", values: ["opt-2"] }]);
		});

		it("handles all-disabled options gracefully by rejecting Enter and allowing Escape cancel", () => {
			const answers: DialogResult[] = [];
			const dialog: SelectDialog = {
				kind: "select",
				id: "sel-all-dis",
				title: "Disabled items",
				options: [
					{ value: "d1", label: "Disabled 1", disabled: true },
					{ value: "d2", label: "Disabled 2", disabled: true },
				],
				selectedIndex: 0,
				multi: false,
				filterable: false,
			};

			const component = createDialogComponent(dialog, r => answers.push(r));
			// Enter does nothing on disabled option
			component.handleInput?.("\r");
			expect(answers).toEqual([]);

			// Escape cancels
			component.handleInput?.("\x1b");
			expect(answers).toEqual([{ outcome: "cancelled" }]);
		});

		it("handles empty options list gracefully without throwing", () => {
			const answers: DialogResult[] = [];
			const dialog: SelectDialog = {
				kind: "select",
				id: "sel-empty",
				title: "Empty list",
				options: [],
				selectedIndex: -1,
				multi: false,
				filterable: false,
			};

			const component = createDialogComponent(dialog, r => answers.push(r));
			expect(() => component.render(WIDTH)).not.toThrow();

			component.handleInput?.("\r");
			expect(answers).toEqual([{ outcome: "cancelled" }]);
		});

		it("filters options when filterable is enabled and selects the matching option", () => {
			const answers: DialogResult[] = [];
			const dialog: SelectDialog = {
				kind: "select",
				id: "sel-filter",
				title: "Filterable list",
				options: [
					{ value: "apple", label: "Apple" },
					{ value: "banana", label: "Banana" },
					{ value: "cherry", label: "Cherry" },
				],
				selectedIndex: 0,
				multi: false,
				filterable: true,
			};

			const component = createDialogComponent(dialog, r => answers.push(r));

			// Type "gam" to filter
			component.handleInput?.("b");
			component.handleInput?.("a");
			component.handleInput?.("n");

			// Press Enter to select filtered item
			component.handleInput?.("\r");
			expect(answers).toEqual([{ outcome: "selected", values: ["banana"] }]);
		});

		it("escape cancels select dialog", () => {
			const answers: DialogResult[] = [];
			const dialog: SelectDialog = {
				kind: "select",
				id: "sel-esc",
				title: "Select",
				options: [{ value: "a", label: "A" }],
				selectedIndex: 0,
				multi: false,
				filterable: false,
			};

			const component = createDialogComponent(dialog, r => answers.push(r));
			component.handleInput?.("\x1b");
			expect(answers).toEqual([{ outcome: "cancelled" }]);
		});
	});

	describe("prompt dialog", () => {
		it("initializes with initialValue and returns entered value on submit", () => {
			const answers: DialogResult[] = [];
			const dialog: PromptDialog = {
				kind: "prompt",
				id: "pr-1",
				title: "Enter branch name",
				placeholder: "main",
				initialValue: "feature/login",
				masked: false,
			};

			const component = createDialogComponent(dialog, r => answers.push(r));
			component.handleInput?.("\r");
			expect(answers).toEqual([{ outcome: "entered", value: "feature/login" }]);
		});

		it("applies credential masking when masked is true and preserves typed characters", () => {
			const answers: DialogResult[] = [];
			const dialog: PromptDialog = {
				kind: "prompt",
				id: "pr-2",
				title: "Enter token",
				placeholder: "",
				initialValue: "secret-token",
				masked: true,
			};

			const component = createDialogComponent(dialog, r => answers.push(r));

			// Renders with mask characters, not plain secret text
			const lines = component.render(WIDTH);
			const renderedText = lines.join("\n");
			expect(renderedText).not.toContain("secret-token");
			expect(renderedText).toContain(DEFAULT_MASK_CHAR);

			component.handleInput?.("\r");
			expect(answers).toEqual([{ outcome: "entered", value: "secret-token" }]);
		});

		it("escape cancels prompt dialog", () => {
			const answers: DialogResult[] = [];
			const dialog: PromptDialog = {
				kind: "prompt",
				id: "pr-3",
				title: "Input",
				placeholder: "",
				initialValue: "",
				masked: false,
			};

			const component = createDialogComponent(dialog, r => answers.push(r));
			component.handleInput?.("\x1b");
			expect(answers).toEqual([{ outcome: "cancelled" }]);
		});
	});

	describe("tool approval shortcuts and choices", () => {
		it("approves once on selecting 'Approve'", () => {
			const answers: DialogResult[] = [];
			const dialog: ToolApprovalDialog = {
				kind: "tool-approval",
				id: "ta-1",
				toolCallId: "call-1",
				toolName: "bash",
				input: '{"command":"rm -rf /tmp/foo"}',
				impact: "Deletes temporary directory",
			};

			const component = createDialogComponent(dialog, r => answers.push(r));
			component.handleInput?.("\r");
			expect(answers).toEqual([{ outcome: "approved", remember: false }]);
		});

		it("approves once immediately on 'y' key shortcut", () => {
			const answers: DialogResult[] = [];
			const dialog: ToolApprovalDialog = {
				kind: "tool-approval",
				id: "ta-y",
				toolCallId: "call-y",
				toolName: "bash",
				input: '{"command":"ls"}',
			};

			const component = createDialogComponent(dialog, r => answers.push(r));
			component.handleInput?.("y");
			expect(answers).toEqual([{ outcome: "approved", remember: false }]);
		});

		it("denies immediately on 'n' key shortcut", () => {
			const answers: DialogResult[] = [];
			const dialog: ToolApprovalDialog = {
				kind: "tool-approval",
				id: "ta-n",
				toolCallId: "call-n",
				toolName: "bash",
				input: '{"command":"rm -rf /"}',
			};

			const component = createDialogComponent(dialog, r => answers.push(r));
			component.handleInput?.("n");
			expect(answers).toEqual([{ outcome: "rejected" }]);
		});

		it("approves for session on selecting 'Approve for session'", () => {
			const answers: DialogResult[] = [];
			const dialog: ToolApprovalDialog = {
				kind: "tool-approval",
				id: "ta-2",
				toolCallId: "call-2",
				toolName: "edit",
				input: '{"path":"src/index.ts"}',
			};

			const component = createDialogComponent(dialog, r => answers.push(r));
			component.handleInput?.("\x1b[B"); // down to index 1
			component.handleInput?.("\r");
			expect(answers).toEqual([{ outcome: "approved", remember: true }]);
		});

		it("denies call on selecting 'Deny'", () => {
			const answers: DialogResult[] = [];
			const dialog: ToolApprovalDialog = {
				kind: "tool-approval",
				id: "ta-3",
				toolCallId: "call-3",
				toolName: "fetch",
				input: '{"url":"https://example.com"}',
			};

			const component = createDialogComponent(dialog, r => answers.push(r));
			component.handleInput?.("\x1b[B");
			component.handleInput?.("\x1b[B"); // down to index 2
			component.handleInput?.("\r");
			expect(answers).toEqual([{ outcome: "rejected" }]);
		});

		it("denies for session on selecting 'Deny for session'", () => {
			const answers: DialogResult[] = [];
			const dialog: ToolApprovalDialog = {
				kind: "tool-approval",
				id: "ta-4",
				toolCallId: "call-4",
				toolName: "fetch",
				input: '{"url":"https://example.com"}',
			};

			const component = createDialogComponent(dialog, r => answers.push(r));
			component.handleInput?.("\x1b[B");
			component.handleInput?.("\x1b[B");
			component.handleInput?.("\x1b[B"); // down to index 3
			component.handleInput?.("\r");
			expect(answers).toEqual([{ outcome: "rejected", reason: "denied for session" }]);
		});

		it("escape cancels tool approval dialog", () => {
			const answers: DialogResult[] = [];
			const dialog: ToolApprovalDialog = {
				kind: "tool-approval",
				id: "ta-5",
				toolCallId: "call-5",
				toolName: "bash",
				input: '{"command":"ls"}',
			};

			const component = createDialogComponent(dialog, r => answers.push(r));
			component.handleInput?.("\x1b");
			expect(answers).toEqual([{ outcome: "cancelled" }]);
		});
	});

	describe("single-settlement, timeout and disposal guarantees", () => {
		it("settles only once even when multiple keys or interactions occur", () => {
			const answers: DialogResult[] = [];
			const dialog: ConfirmDialog = {
				kind: "confirm",
				id: "c-once",
				title: "Confirm once",
				body: "",
				confirmLabel: "Yes",
				cancelLabel: "No",
				destructive: false,
			};

			const component = createDialogComponent(dialog, r => answers.push(r));

			// First enter confirms
			component.handleInput?.("\r");
			// Second enter or escape should be ignored
			component.handleInput?.("\r");
			component.handleInput?.("\x1b");

			expect(answers).toHaveLength(1);
			expect(answers[0]).toEqual({ outcome: "confirmed" });
		});

		it("settles cancelled on timeout even if onTimeout throws", () => {
			vi.useFakeTimers();
			const answers: DialogResult[] = [];
			let timeoutCallbacks = 0;
			const throwingOnTimeout = (): void => {
				timeoutCallbacks += 1;
				throw new Error("Timeout callback failure");
			};
			const tui = createTui();

			const dialog: PromptDialog = {
				kind: "prompt",
				id: "pr-timeout",
				title: "Prompt",
				placeholder: "",
				initialValue: "",
				masked: false,
			};

			const component = createDialogComponent(dialog, r => answers.push(r), {
				tui,
				timeout: 5,
				onTimeout: throwingOnTimeout,
			}) as HookInputComponent;

			try {
				vi.advanceTimersByTime(4);
				expect(answers).toEqual([]);
				expect(() => vi.advanceTimersByTime(1)).toThrow("Timeout callback failure");
				expect(answers).toEqual([{ outcome: "cancelled" }]);
				component.handleInput("\r");
				vi.advanceTimersByTime(5_000);
				expect(answers).toEqual([{ outcome: "cancelled" }]);
				expect(timeoutCallbacks).toBe(1);
			} finally {
				component.dispose();
				tui.stop();
			}
		});
	});
});
