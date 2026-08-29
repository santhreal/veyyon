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
import type { HookEditorOptions } from "./hook-editor-helpers";

import { HOOK_EDITOR_TEXT_PAD_COLS } from "./hook-editor-helpers";
import {
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	type ModalShellGeometry,
	type ModalShortcut,
	planModalChrome,
	renderModalShell,
	sizingForArea,
} from "./modal-shell";

export { HOOK_EDITOR_TEXT_PAD_COLS };

export class HookEditorComponent extends Container {
	#editor: Editor;
	#onSubmitCallback: (value: string) => void;
	#onCancelCallback: () => void;
	#tui: TUI;
	#promptStyle: boolean;
	readonly #card: boolean;
	#cardTitle: string;
	#onRequestRender: (() => void) | undefined;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;

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
			return new Array(height).fill(padding(renderWidth));
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
		for (let ci = 0; ci < this.children.length; ci++) {
			const childLines = this.children[ci]!.render(dims.contentWidth);
			for (let li = 0; li < childLines.length; li++) body.push(childLines[li]!);
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
		return shell.lines;
	}

	handleInput(keyData: string): void {
		if (keyData.startsWith("\x1b[<")) {
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

	pasteText(text: string): void {
		this.#editor.pasteText(text);
	}

	#handlePromptStyleInput(keyData: string): void {
		if (matchesAppFollowUp(keyData)) {
			this.#submitCurrentText();
			return;
		}

		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc") || matchesAppInterrupt(keyData)) {
			this.#onCancelCallback();
			return;
		}

		if (matchesAppExternalEditor(keyData)) {
			void this.#openExternalEditor();
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return")) {
			this.#submitCurrentText();
			return;
		}

		this.#editor.handleInput(keyData);
	}

	#handleHookStyleInput(keyData: string): void {
		if (matchesAppFollowUp(keyData)) {
			this.#submitCurrentText();
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#editor.handleInput("\n");
			return;
		}

		if (matchesAppInterrupt(keyData)) {
			this.#onCancelCallback();
			return;
		}

		if (matchesAppExternalEditor(keyData)) {
			void this.#openExternalEditor();
			return;
		}

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
