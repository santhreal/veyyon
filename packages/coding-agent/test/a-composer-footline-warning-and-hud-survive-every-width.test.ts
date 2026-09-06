import { beforeAll, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import { type Component, Container } from "@veyyon/tui";
import type { SlashCommand } from "@veyyon/utils/autocomplete";
import { PASTE_END, PASTE_START } from "@veyyon/utils/bracketed-paste";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { visibleWidth } from "@veyyon/utils/width";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { PromptActionAutocompleteProvider } from "../src/modes/terminal/autocomplete/prompt-action-autocomplete";
import {
	applyComposerChrome,
	COMPOSER_INSET_COLS,
	PRISTINE_COMPOSER_ACCENT_STATE,
	resolveComposerAccents,
} from "../src/modes/terminal/components/composer/composer-chrome";
import { CustomEditor } from "../src/modes/terminal/components/composer/custom-editor";
import { renderSubagentHudLines } from "../src/modes/terminal/components/dashboard/subagent-hud";
import { StatusLineComponent } from "../src/modes/terminal/components/status-line/component";
import {
	composeQuietRow,
	effectiveStatusLineSettings,
	gatherQuietSegments,
	statusLineSettingsFromConfig,
	subagentBadgeText,
} from "../src/modes/terminal/components/status-line/quiet-row";
import { launchSegmentContext } from "../src/modes/terminal/components/status-line/session-facts";
import type { ObservableSession } from "../src/modes/terminal/session-observer-registry";
import type { InteractiveModeContext } from "../src/modes/terminal/types";
import { UiHelpers } from "../src/modes/terminal/utils/ui-helpers";
import type { AgentSession } from "../src/session/agent-session";
import { getEditorTheme, initTheme } from "../src/theme/theme";
import { makeStatusLineSession } from "./helpers/status-line-session";

describe("Systematic UX Audit: Composer, Footline, Warning, HUD", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	describe("1. CustomEditor & Composer", () => {
		it("handles typing CJK and emoji text at various widths", () => {
			for (const width of [60, 100, 160]) {
				const editor = new CustomEditor(getEditorTheme());
				editor.handleInput("你好世界 🚀🎉");
				expect(editor.getText()).toBe("你好世界 🚀🎉");
				const rendered = editor.render(width);
				expect(rendered.length).toBeGreaterThan(0);
				for (const line of rendered) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		});

		it("handles multiline typing and continuation gutter", () => {
			for (const width of [60, 100, 160]) {
				const editor = new CustomEditor(getEditorTheme());
				const accents = resolveComposerAccents(PRISTINE_COMPOSER_ACCENT_STATE);
				applyComposerChrome(editor, accents);
				editor.insertText("first line\nsecond line\nthird line");
				expect(editor.getText()).toBe("first line\nsecond line\nthird line");
				const rendered = editor.render(width);
				expect(rendered.length).toBeGreaterThanOrEqual(3);
				for (const line of rendered) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		});

		it("handles pasting multi-line text with tabs", () => {
			for (const width of [60, 100, 160]) {
				const editor = new CustomEditor(getEditorTheme());
				const accents = resolveComposerAccents(PRISTINE_COMPOSER_ACCENT_STATE);
				applyComposerChrome(editor, accents);
				const pastePayload = `${PASTE_START}line 1\twith tabs\nline 2\twith\ttabs\nline 3${PASTE_END}`;
				editor.handleInput(pastePayload);
				expect(editor.getText()).toContain("line 1");
				const rendered = editor.render(width);
				for (const line of rendered) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		});

		it("handles history recall with Up when buffer is empty vs non-empty", () => {
			const editor = new CustomEditor(getEditorTheme());
			editor.addToHistory("historical command 1");
			editor.addToHistory("historical command 2");

			// Buffer is empty: Up recalls history
			editor.setText("");
			editor.handleInput("\x1b[A"); // Up arrow
			expect(editor.getText()).toBe("historical command 2");

			// Buffer is non-empty with multiline text
			editor.setText("line 1\nline 2");
			// cursor is at line 1 after setText
			expect(editor.getCursor().line).toBe(1);
			editor.handleInput("\x1b[A"); // Up arrow moves cursor to line 0
			expect(editor.getCursor().line).toBe(0);
			expect(editor.getText()).toBe("line 1\nline 2");
		});

		it("opens and dismisses slash-command autocomplete with partial, non-matching query, and ESC", async () => {
			vi.useFakeTimers();
			try {
				const editor = new CustomEditor(getEditorTheme());
				const commands: SlashCommand[] = [
					{ name: "help", description: "Show help" },
					{ name: "history", description: "Show history" },
					{ name: "model", description: "Select model" },
				];
				const provider = new PromptActionAutocompleteProvider(commands, process.cwd(), []);
				editor.setAutocompleteProvider(provider);

				let escaped = 0;
				editor.onEscape = () => {
					escaped++;
				};

				// Type "/he" -> trigger autocomplete
				editor.handleInput("/");
				for (let i = 0; i < 10; i++) await Promise.resolve();
				editor.handleInput("h");
				for (let i = 0; i < 10; i++) await Promise.resolve();
				editor.handleInput("e");
				for (let i = 0; i < 10; i++) await Promise.resolve();
				vi.advanceTimersByTime(150);
				for (let i = 0; i < 10; i++) await Promise.resolve();
				expect(editor.isShowingAutocomplete()).toBe(true);
				// Render at width 60, 100, 160 to ensure popup renders cleanly
				for (const width of [60, 100, 160]) {
					const rendered = editor.render(width);
					expect(rendered.length).toBeGreaterThan(1);
					for (const line of rendered) {
						expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					}
				}

				// Type non-matching query "/hex999" -> should dismiss autocomplete
				editor.handleInput("x");
				editor.handleInput("9");
				editor.handleInput("9");
				editor.handleInput("9");
				vi.advanceTimersByTime(150);
				for (let i = 0; i < 10; i++) await Promise.resolve();
				expect(editor.isShowingAutocomplete()).toBe(false);

				// Reset and re-open with "/he"
				editor.setText("");
				editor.handleInput("/");
				for (let i = 0; i < 10; i++) await Promise.resolve();
				editor.handleInput("h");
				for (let i = 0; i < 10; i++) await Promise.resolve();
				editor.handleInput("e");
				for (let i = 0; i < 10; i++) await Promise.resolve();
				vi.advanceTimersByTime(150);
				for (let i = 0; i < 10; i++) await Promise.resolve();
				expect(editor.isShowingAutocomplete()).toBe(true);

				// Press ESC once: should dismiss autocomplete, NOT call onEscape
				editor.handleInput("\x1b");
				expect(editor.isShowingAutocomplete()).toBe(false);
				expect(escaped).toBe(0);

				// Press ESC again: should fire onEscape
				editor.handleInput("\x1b");
				expect(escaped).toBe(1);
			} finally {
				vi.useRealTimers();
			}
		});
		it("handles bracketed paste of image path vs raw text", async () => {
			const editor = new CustomEditor(getEditorTheme());
			const pastedImagePaths: string[] = [];
			editor.onPasteImagePath = path => {
				pastedImagePaths.push(path);
			};

			// Paste an image path inside bracketed paste
			const imagePaste = `${PASTE_START}/tmp/screenshot.png${PASTE_END}`;
			editor.handleInput(imagePaste);
			for (let i = 0; i < 5; i++) await Promise.resolve();
			expect(pastedImagePaths).toEqual(["/tmp/screenshot.png"]);
			// Editor text should not have literal path because it was routed to image handler
			expect(editor.getText()).toBe("");

			// Paste plain text inside bracketed paste
			const textPaste = `${PASTE_START}some regular text${PASTE_END}`;
			editor.handleInput(textPaste);
			for (let i = 0; i < 5; i++) await Promise.resolve();
			expect(editor.getText()).toBe("some regular text");
		});
		it("deletes atomic placeholder tokens as a single unit on backspace", () => {
			const editor = new CustomEditor(getEditorTheme());
			editor.setText("see [Paste #1, +30 lines]");
			// Cursor is at end of text after setText (right after the placeholder token)
			expect(editor.getText()).toBe("see [Paste #1, +30 lines]");
			editor.handleInput("\x7f"); // Backspace
			expect(editor.getText()).toBe("see ");
		});
	});

	describe("2. Footline & Status Line", () => {
		it("renders footline at widths 60, 100, 160 and degrades gracefully", () => {
			const session = makeStatusLineSession({
				modelId: "claude-3-7-sonnet-20250219",
				modelName: "Claude 3.7 Sonnet",
				modelThinking: true,
				thinkingLevel: ThinkingLevel.High,
				contextUsage: { tokens: 50_000, contextWindow: 200_000 },
				usage: { cost: 1.25 },
			});
			const statusLine = new StatusLineComponent(session as unknown as AgentSession);

			for (const width of [160, 100, 60]) {
				const line = statusLine.renderQuietLine(width);
				expect(line).not.toBeNull();
				expect(visibleWidth(line ?? "")).toBeLessThanOrEqual(width);
			}
		});

		it("renders launch composer footline at widths 60, 100, 160", () => {
			const effectiveSettings = effectiveStatusLineSettings(statusLineSettingsFromConfig());
			for (const width of [160, 100, 60]) {
				const avail = width - COMPOSER_INSET_COLS;
				const groups = gatherQuietSegments({
					width: avail,
					effectiveSettings,
					gitEnabled: false,
					expansion: 0,
					buildContext: request =>
						launchSegmentContext({
							width: request.width,
							options: request.options,
							compactThinkingLevel: false,
							branch: "main",
							autoCompactEnabled: true,
							location: null,
						}),
					subagentBadge: subagentBadgeText(0),
					badgeSlot: null,
				});
				const row = composeQuietRow({
					...groups,
					width: avail,
					expansion: 0,
					badge: "",
					clock: "",
					expandedHalf: "path",
					locationRight: null,
				});
				expect(row.line).not.toBeNull();
				expect(visibleWidth(row.line ?? "")).toBeLessThanOrEqual(avail);
			}
		});
		it("renders footline with focused agent badge at widths 60, 100, 160", () => {
			const session = makeStatusLineSession({
				modelId: "claude-3-7-sonnet-20250219",
				modelName: "Claude 3.7 Sonnet",
			});
			const statusLine = new StatusLineComponent(session as unknown as AgentSession);
			statusLine.setSession(session as unknown as AgentSession, "subagent-worker-1");

			for (const width of [160, 100, 60]) {
				const line = statusLine.renderQuietLine(width);
				expect(line).not.toBeNull();
				expect(visibleWidth(line ?? "")).toBeLessThanOrEqual(width);
				expect(stripAnsi(line ?? "")).toContain("subagent-worker-1");
				expect(stripAnsi(line ?? "")).toContain("esc");
			}
		});

		it("renders and shrinks hook status line cleanly", () => {
			const session = makeStatusLineSession({});
			const statusLine = new StatusLineComponent(session as unknown as AgentSession);
			statusLine.setHookStatus("lsp", "TypeScript language server initializing indexing 450 files in workspace...");
			statusLine.setHookStatus("git", "Running pre-commit linter hooks in background...");

			for (const width of [160, 100, 60]) {
				const rendered = statusLine.render(width);
				expect(rendered.length).toBe(1);
				expect(visibleWidth(rendered[0] ?? "")).toBeLessThanOrEqual(width);
			}

			// Removing hook status clears the line
			statusLine.setHookStatus("lsp", undefined);
			statusLine.setHookStatus("git", undefined);
			expect(statusLine.render(100)).toEqual([]);
		});
	});

	describe("3. Warning & Notice Band", () => {
		function harness(): { ctx: InteractiveModeContext; helpers: UiHelpers } {
			const ctx = {
				chatContainer: new Container(),
				ui: { requestRender: vi.fn() },
				present: (content: Component | readonly Component[]) => {
					const items = Array.isArray(content) ? content : [content];
					for (const item of items) ctx.chatContainer.addChild(item);
					ctx.ui.requestRender();
				},
				lastStatusSpacer: undefined,
				lastStatusText: undefined,
				refreshComposerShortcuts: vi.fn(),
				dismissWelcome: vi.fn(),
			} as unknown as InteractiveModeContext;
			return { ctx, helpers: new UiHelpers(ctx) };
		}

		it("shows two different warnings then the same one again", () => {
			const { ctx, helpers } = harness();
			helpers.showWarning("Warning A");
			helpers.showWarning("Warning B");
			helpers.showWarning("Warning A");
			// Since Warning A is not immediately consecutive to the first Warning A (Warning B is between them),
			// all 3 should render.
			expect(ctx.chatContainer.children).toHaveLength(6); // 3 spacers + 3 texts
		});

		it("renders warning longer than terminal width at 60, 100, 160", () => {
			for (const width of [60, 100, 160]) {
				const { ctx, helpers } = harness();
				const longWarning = "A".repeat(200);
				helpers.showWarning(longWarning);
				const rendered = ctx.chatContainer.render(width);
				expect(rendered.length).toBeGreaterThan(0);
				for (const line of rendered) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		});
	});

	describe("4. Subagent HUD", () => {
		it("renders HUD with 0, 1, and 12 subagents at widths 60, 100, 160", () => {
			const makeSubagent = (id: string, description?: string, model?: string): ObservableSession =>
				({
					id,
					kind: "subagent",
					status: "active",
					detached: true,
					description,
					progress: model ? { resolvedModel: model } : undefined,
				}) as unknown as ObservableSession;

			// 0 subagents
			for (const width of [60, 100, 160]) {
				const lines0 = renderSubagentHudLines([], { columns: width, showModelBadge: true });
				expect(lines0).toEqual([]);
			}

			// 1 subagent with long label
			const oneSubagent = [
				makeSubagent(
					"subagent-alpha-long-id-123456789",
					"Very long description that describes a complex task spanning multiple files and modules",
					"claude-3-7-sonnet",
				),
			];
			for (const width of [60, 100, 160]) {
				const lines1 = renderSubagentHudLines(oneSubagent, { columns: width, showModelBadge: true });
				expect(lines1.length).toBeGreaterThan(0);
				for (const line of lines1) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}

			// 12 subagents with long labels
			const twelveSubagents = Array.from({ length: 12 }, (_, i) =>
				makeSubagent(
					`subagent-task-${i + 1}-extended-label`,
					`Refactoring database schema migration and updating api routes for service ${i + 1}`,
					i % 2 === 0 ? "claude-3-7-sonnet" : "gpt-4o",
				),
			);
			for (const width of [60, 100, 160]) {
				const lines12 = renderSubagentHudLines(twelveSubagents, { columns: width, showModelBadge: true });
				expect(lines12.length).toBeGreaterThan(0);
				// 1 empty line + 1 header line + 8 visible agents + 1 "more running" row = 11 lines
				expect(lines12.length).toBe(11);
				for (const line of lines12) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}

			// Subagent with NO description but model badge fits in remaining space
			const subagentNoDesc = [makeSubagent("task-1", undefined, "gpt-4o")];
			// At width 30: id="task-1", badge "gpt-4o" fits in remaining space.
			// Pre-fix dropped the badge because 9 < 14 (reserving room for non-existent description).
			// Post-fix retains the badge since there is no description competing for space.
			const linesNoDesc = renderSubagentHudLines(subagentNoDesc, { columns: 30, showModelBadge: true });
			expect(linesNoDesc.length).toBe(3);
			expect(stripAnsi(linesNoDesc[2] ?? "")).toContain("gpt-4o");
		});
	});
});
