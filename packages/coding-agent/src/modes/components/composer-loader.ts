import { CancellableLoader, Container, Spacer, Text, type TUI } from "@veyyon/tui";
import type { Theme } from "../../modes/theme/theme";
import { COMPOSER_INSET_COLS } from "./composer-chrome";

/**
 * A cancellable loader that takes the composer's place while a command runs.
 *
 * It sits in the composer zone, so it carries no rule and no box (see the
 * design language, "The composer has no box. Ever."): the spinner and the
 * `esc cancel` hint are on the same rail as the prompt they replaced.
 */
export class ComposerLoader extends Container {
	#loader: CancellableLoader;

	constructor(tui: TUI, theme: Theme, message: string) {
		super();
		this.#loader = new CancellableLoader(
			tui,
			s => theme.fg("accent", s),
			s => theme.fg("muted", s),
			message,
		);
		this.addChild(this.#loader);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "esc cancel"), COMPOSER_INSET_COLS, 0));
	}

	get signal(): AbortSignal {
		return this.#loader.signal;
	}

	set onAbort(fn: (() => void) | undefined) {
		this.#loader.onAbort = fn;
	}

	handleInput(data: string): void {
		this.#loader.handleInput(data);
	}

	dispose(): void {
		this.#loader.dispose();
	}
}
