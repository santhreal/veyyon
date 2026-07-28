/**
 * Simple text input component for hooks.
 */
import { Container, Input, Markdown, Spacer, Text, type TUI } from "@veyyon/tui";
import { getMarkdownTheme } from "../../modes/theme/markdown-theme";
import { theme } from "../../modes/theme/theme";
import { matchesAppInterrupt } from "../../modes/utils/keybinding-matchers";
import { CountdownTimer } from "./countdown-timer";
import { DynamicBorder } from "./dynamic-border";

export interface HookInputOptions {
	tui?: TUI;
	timeout?: number;
	onTimeout?: () => void;
	/**
	 * Render each character typed as this one instead of itself, for a credential.
	 *
	 * Handed straight to {@link Input.mask}, which is the single place a value becomes something
	 * a terminal can show. Nothing here reimplements editing, so a masked prompt keeps the same
	 * paste, word motion and kill-ring behaviour as every other input in the app.
	 */
	mask?: string;
	/**
	 * Preserve pasted credential payload code units exactly. Masked hooks enable
	 * this automatically; the explicit flag keeps the mode named and testable.
	 */
	credentialMode?: boolean;
}

export class HookInputComponent extends Container {
	#input: Input;
	#onSubmitCallback: (value: string) => void;
	#onCancelCallback: () => void;
	#titleComponent: Markdown;
	#baseTitle: string;
	#countdown: CountdownTimer | undefined;

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
		this.#baseTitle = title;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.#titleComponent = new Markdown(title, 1, 0, getMarkdownTheme(), { color: t => theme.fg("accent", t) });
		this.addChild(this.#titleComponent);
		this.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.#countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				this,
				s => this.#titleComponent.setText(`${this.#baseTitle} (${s}s)`),
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
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "enter submit  esc cancel"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		// Input owns paste framing as well as submit/cancel recognition. Routing
		// every chunk through it means a newline or interrupt byte in a
		// bracketed paste cannot be mistaken for a physical key by this wrapper.
		this.#countdown?.reset();
		this.#input.handleInput(keyData);
	}

	/** Route non-bracketed paste transports (e.g. kitty's OSC 5522 enhanced clipboard)
	 *  into the inner input, mirroring bracketed-paste semantics. Pasting counts as
	 *  interaction, so the timeout countdown resets like any keystroke. */
	pasteText(text: string): void {
		this.#countdown?.reset();
		this.#input.pasteText(text);
	}

	dispose(): void {
		this.#countdown?.dispose();
	}
}
