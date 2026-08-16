/**
 * Single-field text prompt for hooks, drawn as a floating ModalShell card.
 */
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
} from "@veyyon/tui";
import { getMarkdownTheme } from "../../modes/theme/markdown-theme";
import { theme } from "../../modes/theme/theme";
import { matchesAppInterrupt } from "../../modes/utils/keybinding-matchers";
import { CountdownTimer } from "./countdown-timer";
import {
	applyModalReveal,
	beginModalExit,
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

export interface HookInputOptions {
	tui?: TUI;
	timeout?: number;
	onTimeout?: () => void;
	/**
	 * Render each character typed as this one instead of itself, for a credential.
	 * The value still submits verbatim; only the painted glyphs change, so a key
	 * pasted into a shared screen recording is not readable from the frame.
	 */
	mask?: string;
	/**
	 * Preserve pasted credential payload code units exactly. Masked hooks enable
	 * this automatically; the explicit flag keeps the mode named and testable.
	 */
	credentialMode?: boolean;
	/**
	 * Mechanical facts about the field, shown as the first footer chip rather
	 * than in the title: what the field accepts, or where its value ends up.
	 */
	hint?: string;
	/** Repaint request for hover paints and the countdown tick. */
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
	#reveal = new ModalRevealDriver();
	/**
	 * Fade out on the shared clock before the host drops this card. The overlay stack keeps painting
	 * it and stops routing input to it the moment this is called.
	 */
	beginOverlayExit(requestRender: () => void, done: () => void): boolean {
		return beginModalExit(this.#reveal, requestRender, done);
	}

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

		// The card's title bar takes the title's first line; anything under it is
		// context the caller wrote for the field and stays in the body.
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

	/** The field's own hint leads, because it describes THIS field; the keys are
	 *  the same two bindings every dialog in the app carries. */
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
		// Input owns paste framing as well as submit/cancel recognition. Routing
		// every chunk through it means a newline or interrupt byte in a
		// bracketed paste cannot be mistaken for a physical key by this wrapper.
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
			// The submit chip answers with what is typed, exactly as Enter does.
			this.#countdown?.reset();
			this.#onSubmitCallback(this.#input.getValue());
			return true;
		}
		return true;
	}

	/** Route non-bracketed paste transports (e.g. kitty's OSC 5522 enhanced clipboard)
	 *  into the inner input, mirroring bracketed-paste semantics. Pasting counts as
	 *  interaction, so the timeout countdown resets like any keystroke. */
	pasteText(text: string): void {
		this.#countdown?.reset();
		this.#input.pasteText(text);
	}

	override render(width: number): readonly string[] {
		const renderWidth = Math.max(1, width);
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
		return applyModalReveal(shell, renderWidth, this.#reveal.value);
	}

	dispose(): void {
		this.#countdown?.dispose();
	}
}
