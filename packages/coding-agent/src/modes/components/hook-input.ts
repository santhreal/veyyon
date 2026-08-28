import {
	Container,
	Ellipsis,
	Input,
	Markdown,
	padding,
	routeSgrMouseInput,
	type SgrMouseEvent,
	Spacer,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@veyyon/tui";
import { getMarkdownTheme } from "../../modes/theme/markdown-theme";
import { theme } from "../../modes/theme/theme";
import { matchesAppInterrupt } from "../../modes/utils/keybinding-matchers";
import { CountdownTimer } from "./countdown-timer";
import {
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	type ModalShellGeometry,
	type ModalShortcut,
	type ModalSizing,
	modalWidthForContent,
	modalWidthForTitle,
	planModalChrome,
	renderModalShell,
	sizingForArea,
} from "./modal-shell";

export interface HookInputOptions {
	tui?: TUI;
	timeout?: number;
	onTimeout?: () => void;
	mask?: string;
	credentialMode?: boolean;
	hint?: string;
	onRequestRender?: () => void;
}

export class HookInputComponent extends Container {
	#input: Input;
	#onSubmitCallback: (value: string) => void;
	#onCancelCallback: () => void;
	#titleComponent: Markdown | undefined;
	#cardTitle: string;
	#countdownSuffix = "";
	#countdown: CountdownTimer | undefined;
	#hint: string | undefined;
	#onRequestRender: (() => void) | undefined;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;

	constructor(
		title: string,
		_placeholder: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		opts?: HookInputOptions,
	) {
		super();

		this.#onSubmitCallback = onSubmit;
		this.#onCancelCallback = onCancel;
		this.#hint = opts?.hint;
		this.#onRequestRender = opts?.onRequestRender;

		const [firstTitleLine = "", ...restTitleLines] = title.split("\n");
		this.#cardTitle = firstTitleLine;
		const bodyTitle = restTitleLines.join("\n");
		if (bodyTitle.length > 0) {
			this.#titleComponent = new Markdown(bodyTitle, 1, 0, getMarkdownTheme(), {
				color: t => theme.fg("accent", t),
			});
			this.addChild(this.#titleComponent);
			this.addChild(new Spacer(1));
		}

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.#countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				this,
				s => {
					this.#countdownSuffix = ` (${s}s)`;
					this.#onRequestRender?.();
				},
				() => {
					opts.onTimeout?.();
					this.#onCancelCallback();
				},
			);
		}

		this.#input = new Input();
		this.#input.mask = opts?.mask;
		this.#input.credentialMode = opts?.credentialMode ?? opts?.mask !== undefined;
		this.#input.isEscapeInput = matchesAppInterrupt;
		this.#input.onSubmit = value => this.#onSubmitCallback(value);
		this.#input.onEscape = () => this.#onCancelCallback();
		this.addChild(this.#input);
	}

	setOnRequestRender(callback: () => void): void {
		this.#onRequestRender = callback;
	}

	#shortcuts(): readonly ModalShortcut[] {
		const shortcuts: ModalShortcut[] = [];
		if (this.#hint !== undefined) shortcuts.push({ label: this.#hint });
		shortcuts.push({ label: "submit", keybindings: ["tui.select.confirm"], clickable: true, id: "confirm" });
		shortcuts.push({ label: "cancel", keybindings: ["tui.select.cancel"], clickable: true, id: "close" });
		return shortcuts;
	}

	handleInput(keyData: string): void {
		if (keyData.startsWith("\x1b[<")) {
			routeSgrMouseInput(keyData, event => this.#routeMouse(event));
			return;
		}
		this.#countdown?.reset();
		this.#input.handleInput(keyData);
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
			this.#countdown?.reset();
			this.#onSubmitCallback(this.#input.getValue());
			return true;
		}
		return true;
	}

	pasteText(text: string): void {
		this.#countdown?.reset();
		this.#input.pasteText(text);
	}

	#sizing(height: number): ModalSizing {
		const base = sizingForArea(MODAL_SIZING_MEDIUM, height);
		const needed = Math.max(
			modalWidthForTitle(visibleWidth(this.#cardTitle + this.#countdownSuffix)),
			this.#hint === undefined ? 0 : modalWidthForContent(visibleWidth(this.#hint), base),
		);
		return needed <= base.minWidth ? base : { ...base, minWidth: needed };
	}

	override render(width: number): readonly string[] {
		const renderWidth = Math.max(1, width);
		const height = process.stdout.rows || 40;
		const sizing = this.#sizing(height);
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
			title: truncateToWidth(this.#cardTitle + this.#countdownSuffix, dims.contentWidth, Ellipsis.Unicode),
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

	dispose(): void {
		this.#countdown?.dispose();
	}
}
