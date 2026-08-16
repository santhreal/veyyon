/**
 * Multi-line editor component for hooks and ask custom input.
 * Supports Ctrl+G for external editor.
 *
 * Two modes:
 * - Default (hook): Enter inserts newline, the `app.message.followUp` chord
 *   (Ctrl+Q / Ctrl+Enter) submits, bordered popup
 * - Prompt-style (ask): Enter submits, Shift+Enter inserts newline, legacy ask chrome
 */
import {
	Container,
	Editor,
	Ellipsis,
	matchesKey,
	padding,
	routeSgrMouseInput,
	type SgrMouseEvent,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@veyyon/tui";
import { getEditorTheme, theme } from "../../modes/theme/theme";
import { actionKeyHint } from "../../modes/utils/key-hint";
import {
	matchesAppExternalEditor,
	matchesAppFollowUp,
	matchesAppInterrupt,
} from "../../modes/utils/keybinding-matchers";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import {
	applyModalReveal,
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	ModalRevealDriver,
	type ModalShellGeometry,
	type ModalShortcut,
	planModalChrome,
	renderModalShell,
	sizingForArea,
} from "./modal-shell";

export interface HookEditorOptions {
	/** When true, use prompt-style keybindings with the legacy ask prompt chrome. */
	promptStyle?: boolean;
	/**
	 * `"card"` (default) is the standalone surface: a floating ModalShell over
	 * the transcript, with the keys as footer chips. `"embedded"` renders the
	 * title, editor and key line as bare rows for a host that already owns a
	 * card and mounts this inside its body (the advisor config's instructions
	 * screen), so the two frames never nest.
	 */
	presentation?: "card" | "embedded";
	/** Card presentation only: repaint request for chip hover paints. */
	onRequestRender?: () => void;
}

/**
 * Columns of padding on EACH side of the editor's title and hint rows in the
 * embedded presentation.
 *
 * Exported because a caller that pre-wraps or pre-truncates the title has to
 * know the width it will actually be rendered at, and the only other way to
 * know is to guess.
 */
export const HOOK_EDITOR_TEXT_PAD_COLS = 1;

export class HookEditorComponent extends Container {
	#editor: Editor;
	#onSubmitCallback: (value: string) => void;
	#onCancelCallback: () => void;
	#tui: TUI;
	#promptStyle: boolean;
	/** Floating card (default) versus bare rows inside a host's own card. */
	readonly #card: boolean;
	#cardTitle: string;
	#onRequestRender: (() => void) | undefined;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#reveal = new ModalRevealDriver();

	constructor(
		tui: TUI,
		title: string,
		prefill: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		options?: HookEditorOptions,
	) {
		super();

		this.#tui = tui;
		this.#onSubmitCallback = onSubmit;
		this.#onCancelCallback = onCancel;
		this.#promptStyle = options?.promptStyle ?? false;
		this.#card = options?.presentation !== "embedded";
		this.#onRequestRender = options?.onRequestRender;

		// The card's title bar takes the title's first line; the rest (the ask
		// prompt's option list, for one) is context and stays in the body.
		const [firstTitleLine = "", ...restTitleLines] = title.split("\n");
		this.#cardTitle = firstTitleLine;
		const bodyTitle = this.#card ? restTitleLines.join("\n") : title;
		if (bodyTitle.length > 0) {
			this.addChild(new Text(theme.fg("accent", bodyTitle), HOOK_EDITOR_TEXT_PAD_COLS, 0));
			this.addChild(new Spacer(1));
		}

		this.#editor = new Editor(getEditorTheme());
		if (this.#promptStyle) {
			this.#editor.setBorderVisible(false);
			this.#editor.setPromptGutter("> ");
			this.#editor.disableSubmit = true;
		}
		if (prefill) {
			this.#editor.setText(prefill);
		}
		this.addChild(this.#editor);

		// Embedded, the keys are a dim line under the editor, because the host's
		// card footer names its own. A card puts them in that footer instead.
		if (!this.#card) {
			this.addChild(new Spacer(1));
			this.addChild(
				new Text(
					theme.fg(
						"dim",
						this.#shortcuts()
							.map(shortcut => shortcut.label)
							.join("  "),
					),
					HOOK_EDITOR_TEXT_PAD_COLS,
					0,
				),
			);
		}
	}

	setOnRequestRender(callback: () => void): void {
		this.#onRequestRender = callback;
	}

	/**
	 * Footer chips. Both chords named here are remappable
	 * (`app.message.followUp` and `app.editor.external`) and the handlers read
	 * the binding, so the chip carries the live key rather than a written-out
	 * one that a rebind would leave lying.
	 */
	#shortcuts(): readonly ModalShortcut[] {
		const submit = actionKeyHint("app.message.followUp");
		const shortcuts: ModalShortcut[] = [
			{
				label: this.#promptStyle ? `enter${submit ? ` or ${submit}` : ""} submit` : `${submit || "enter"} submit`,
				clickable: true,
				id: "confirm",
			},
			{ label: "esc cancel", clickable: true, id: "close" },
		];
		const external = actionKeyHint("app.editor.external");
		if (external) shortcuts.push({ label: `${external} external editor` });
		return shortcuts;
	}

	#routeMouse(event: SgrMouseEvent): boolean {
		const chrome = hitTestModalChrome(this.#shellGeometry, event.row, event.col, {
			motion: event.motion,
			leftClick: event.leftClick,
		});
		if (
			consumeModalChipHover(chrome, this.#hoveredShortcutId, id => {
				this.#hoveredShortcutId = id;
				this.#onRequestRender?.();
			})
		) {
			return true;
		}
		if (event.motion) return true;
		if (
			chrome.kind === "close" ||
			chrome.kind === "outside" ||
			(chrome.kind === "shortcut" && chrome.id === "close")
		) {
			this.#onCancelCallback();
			return true;
		}
		if (chrome.kind === "shortcut" && chrome.id === "confirm") {
			this.#submitCurrentText();
			return true;
		}
		return true;
	}

	override render(width: number): readonly string[] {
		const renderWidth = Math.max(1, width);
		if (!this.#card) return super.render(renderWidth);

		const height = process.stdout.rows || 40;
		const sizing = sizingForArea(MODAL_SIZING_MEDIUM, height);
		const dims = computeModalDims(renderWidth, height, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return Array.from({ length: height }, () => padding(renderWidth));
		}

		const shortcuts = this.#shortcuts();
		const chrome = planModalChrome({
			sizing,
			modalHeight: dims.modalHeight,
			contentWidth: dims.contentWidth,
			shortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
		});

		const body: string[] = [];
		for (const child of this.children) {
			for (const line of child.render(dims.contentWidth)) body.push(line);
		}

		const shell = renderModalShell({
			title: truncateToWidth(this.#cardTitle, dims.contentWidth, Ellipsis.Unicode),
			sizing,
			areaWidth: renderWidth,
			areaHeight: height,
			body: body.slice(0, chrome.maxBodyRows),
			preferredBodyRows: body.length,
			shortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		return applyModalReveal(shell, renderWidth, this.#reveal.value);
	}

	handleInput(keyData: string): void {
		if (keyData.startsWith("\x1b[<")) {
			// Only the card paints a shell, so an embedded editor's geometry stays
			// null, every chrome hit-test misses, and the report is swallowed here
			// rather than typed into the text as literal escape bytes.
			routeSgrMouseInput(keyData, event => this.#routeMouse(event));
			return;
		}
		if (this.#promptStyle) {
			this.#handlePromptStyleInput(keyData);
		} else {
			this.#handleHookStyleInput(keyData);
		}
	}

	#submitCurrentText(): void {
		this.#onSubmitCallback(this.#editor.getExpandedText());
	}

	/** Route non-bracketed paste transports (e.g. kitty's OSC 5522 enhanced clipboard)
	 *  into the inner editor, mirroring bracketed-paste semantics. Without this hook,
	 *  enhanced-paste routing falls back to the main prompt editor hidden behind the
	 *  dialog (#2127 routing contract). */
	pasteText(text: string): void {
		this.#editor.pasteText(text);
	}

	/**
	 * Prompt-style: raw Enter submits; Editor owns newline-producing sequences.
	 * The follow-up chord (`app.message.followUp` → Ctrl+Q / Ctrl+Enter) also
	 * submits, so muscle memory from the main editor / hook-style surface works
	 * here and Windows Terminal — which can't deliver a distinct Ctrl+Enter
	 * event (#1903) — still has a working chord via Ctrl+Q (#3353).
	 */
	#handlePromptStyleInput(keyData: string): void {
		// Submit on the follow-up chord first so it wins over Editor's own
		// Ctrl+Enter newline handling. Mirrors #handleHookStyleInput.
		if (matchesAppFollowUp(keyData)) {
			this.#submitCurrentText();
			return;
		}

		// Prompt-style keeps Escape as an explicit cancel key and also honors app.interrupt remaps.
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc") || matchesAppInterrupt(keyData)) {
			this.#onCancelCallback();
			return;
		}

		// Ctrl+G for external editor
		if (matchesAppExternalEditor(keyData)) {
			void this.#openExternalEditor();
			return;
		}

		// Submit on any plain Enter encoding, including terminals that report unmodified Enter as LF.
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return")) {
			this.#submitCurrentText();
			return;
		}

		// Let Editor handle modified newline-producing variants (Shift+Enter, Ctrl+Enter, Alt+Enter, etc.)
		this.#editor.handleInput(keyData);
	}

	/** Hook-style: Enter=newline, app.message.followUp chord (Ctrl+Q/Ctrl+Enter) submits. */
	#handleHookStyleInput(keyData: string): void {
		// Submit on the follow-up chord. Uses the shared keybinding so Ctrl+Q works
		// on Windows Terminal (#1903) and any user remap of `app.message.followUp`
		// applies here too.
		if (matchesAppFollowUp(keyData)) {
			this.#submitCurrentText();
			return;
		}

		// Plain Enter inserts a new line in hook editor
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#editor.handleInput("\n");
			return;
		}

		// Escape to cancel
		if (matchesAppInterrupt(keyData)) {
			this.#onCancelCallback();
			return;
		}

		// Ctrl+G for external editor
		if (matchesAppExternalEditor(keyData)) {
			void this.#openExternalEditor();
			return;
		}

		// Forward to editor
		this.#editor.handleInput(keyData);
	}

	async #openExternalEditor(): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) return;

		const currentText = this.#editor.getExpandedText();
		try {
			this.#tui.stop();
			const result = await openInEditor(editorCmd, currentText);
			if (result !== null) {
				this.#editor.setText(result);
			}
		} finally {
			this.#tui.start();
			this.#tui.requestRender(true);
		}
	}
}
