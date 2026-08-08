import { Container, getKeybindings, Input, Spacer, Text, type TUI } from "@veyyon/tui";
import { theme } from "../../modes/theme/theme";
import { formatProviderName } from "../../slash-commands/helpers/format";
import { openPath } from "../../utils/open";
import { DynamicBorder } from "./dynamic-border";

/** What a login flow is currently asking the operator to paste. */
interface PromptState {
	message: string;
	placeholder?: string;
	/** Mask the value and take the paste byte for byte: the answer is a credential. */
	secret: boolean;
	/** Footer text for this prompt, because Esc does not mean the same thing in every one. */
	footer: string;
}

/** Where the operator has to go to authorize, once a flow knows. */
interface AuthState {
	url: string;
	launchUrl?: string;
	instructions?: string;
}

/**
 * The login surface: one frame, rebuilt from state, that replaces the editor while a provider flow
 * runs.
 *
 * WHY IT IS REBUILT rather than appended to. Every `show*` used to push rows onto one container, so
 * the frame was a log of everything the flow had ever said. An API-key login that failed validation
 * and asked again rendered two prompts, two "(Escape to cancel, Enter to submit)" footers, and its
 * second question BELOW the input it belonged to, because the input was already mounted from the
 * first one and only moved if it had never been added. Progress messages stacked the same way, so
 * "Validating API key..." accumulated one line per attempt.
 *
 * There are four things this frame can show, and each has exactly one place: where to authorize, what
 * is happening right now, what is being asked, and which keys work. Setting one replaces it.
 */
export class LoginDialogComponent extends Container {
	#contentContainer: Container;
	#input: Input;
	#tui: TUI;
	#abortController = new AbortController();
	#inputResolver?: (value: string) => void;
	#inputRejecter?: (error: Error) => void;
	#auth?: AuthState;
	#status?: string;
	#prompt?: PromptState;
	/**
	 * What Esc does to the prompt on screen. `cancel` aborts the whole login, which is right while a
	 * flow is still waiting for a credential. `skip` answers the question with nothing, for the
	 * optional name asked AFTER the credential is already stored: pressing Esc there must not read as
	 * "undo the login I just completed".
	 */
	#escapeMode: "cancel" | "skip" = "cancel";

	constructor(
		tui: TUI,
		providerId: string,
		private onComplete: (success: boolean, message?: string) => void,
	) {
		super();
		this.#tui = tui;

		this.addChild(new DynamicBorder());
		// One label owner for provider names, the same one the status line, the account card and the
		// logout dialog use. Reading the browser-login table here printed a raw slug (`Login to groq`)
		// for every provider that authenticates with a pasted key, since that table has no row for one.
		this.addChild(new Text(theme.fg("warning", `Login to ${formatProviderName(providerId)}`), 1, 0));

		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		this.#input = new Input();
		this.#input.onSubmit = () => {
			this.#settlePrompt(this.#input.getValue());
		};
		this.#input.onEscape = () => {
			this.#escape();
		};

		this.addChild(new DynamicBorder());
		this.#rebuild();
	}

	get signal(): AbortSignal {
		return this.#abortController.signal;
	}

	/** Hand the pending prompt its answer and take the question off the frame. */
	#settlePrompt(value: string): void {
		const resolve = this.#inputResolver;
		this.#inputResolver = undefined;
		this.#inputRejecter = undefined;
		this.#prompt = undefined;
		this.#escapeMode = "cancel";
		this.#rebuild();
		resolve?.(value);
	}

	#escape(): void {
		if (this.#escapeMode === "skip") {
			// The credential is already stored; this question was optional.
			this.#settlePrompt("");
			return;
		}
		this.#cancel();
	}

	#cancel(): void {
		this.#abortController.abort();
		if (this.#inputRejecter) {
			this.#inputRejecter(new Error("Login cancelled"));
			this.#inputResolver = undefined;
			this.#inputRejecter = undefined;
		}
		this.onComplete(false, "Login cancelled");
	}

	/**
	 * Lay the frame out from state: where to go, what is happening, what is being asked, which keys
	 * work. One blank line between blocks and none inside one, so the frame reads the same however
	 * many times a flow re-asked.
	 */
	#rebuild(): void {
		this.#contentContainer.clear();
		const auth = this.#auth;
		if (auth) {
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("accent", auth.url), 1, 0));
			const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
			this.#contentContainer.addChild(
				new Text(theme.fg("dim", `\x1b]8;;${auth.url}\x07${clickHint}\x1b]8;;\x07`), 1, 0),
			);
			if (auth.launchUrl && auth.launchUrl !== auth.url) {
				this.#contentContainer.addChild(
					new Text(theme.fg("dim", `Local shortcut (this machine only): ${auth.launchUrl}`), 1, 0),
				);
			}
			if (auth.instructions) {
				this.#contentContainer.addChild(new Spacer(1));
				this.#contentContainer.addChild(new Text(theme.fg("warning", auth.instructions), 1, 0));
			}
		}

		if (this.#status) {
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("dim", this.#status), 1, 0));
		}

		const prompt = this.#prompt;
		if (prompt) {
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("text", prompt.message), 1, 0));
			this.#contentContainer.addChild(this.#input);
			if (prompt.placeholder) {
				this.#contentContainer.addChild(new Text(theme.fg("dim", `looks like ${prompt.placeholder}`), 1, 0));
			}
		}

		// The footer is last and there is one of it. It names the keys that work on the frame as it
		// stands, which is why it is rebuilt with the frame rather than appended by whoever spoke last.
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("dim", prompt?.footer ?? "Esc  cancel"), 1, 0));
		this.#tui.requestRender();
	}

	/**
	 * Called by the OAuth `onAuth` callback. Renders the full authorization URL as the primary copy
	 * target: that works from any machine, including SSH/WSL/headless sessions where the veyyon-hosted
	 * `launchUrl` would resolve against the user's local browser and fail. When `launchUrl` is present
	 * it is offered as an additional local shortcut so narrow local terminals still have a
	 * truncation-safe copy target (viewport clipping on a long authorize URL silently drops trailing
	 * OAuth query parameters, e.g. `code_challenge_method=S256`). The OSC 8 hyperlink carries the full
	 * URL for terminals that support click-through.
	 */
	showAuth(url: string, instructions?: string, launchUrl?: string): void {
		this.#auth = { url, ...(launchUrl ? { launchUrl } : {}), ...(instructions ? { instructions } : {}) };
		this.#rebuild();
		// Best-effort, and deliberately outside `#rebuild`: a relayout must never open a second tab.
		openPath(url);
	}

	/**
	 * Called by the `onProgress` callback. One status line, replaced rather than appended: three
	 * validation attempts are three states of one login, not three things to read.
	 */
	showProgress(message: string): void {
		this.#status = message;
		this.#rebuild();
	}

	/** Ask for a credential (or a pasted code) and wait. Replaces any question already on screen. */
	showPrompt(prompt: { message: string; placeholder?: string; secret?: boolean }): Promise<string> {
		return this.#ask({
			message: prompt.message,
			...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
			secret: prompt.secret === true,
			footer: "Enter  submit    Esc  cancel",
		});
	}

	/**
	 * Ask what to call the account that was just stored, where Esc means "leave it unnamed".
	 *
	 * Naming belongs at creation: the operator has just watched a login land and knows which account
	 * it was, while `n` on the account card asks them to recognize it later among the others. Esc here
	 * resolves nothing rather than cancelling, because the credential is already saved and there is
	 * nothing left to abandon.
	 */
	askOptionalName(message: string, placeholder?: string): Promise<string | undefined> {
		const answered = this.#ask({
			message,
			...(placeholder ? { placeholder } : {}),
			secret: false,
			footer: "Enter  save    Esc  skip",
		});
		this.#escapeMode = "skip";
		return answered.then(value => {
			const trimmed = value.trim();
			return trimmed.length > 0 ? trimmed : undefined;
		});
	}

	#ask(prompt: PromptState): Promise<string> {
		this.#prompt = prompt;
		this.#escapeMode = "cancel";
		this.#input.credentialMode = prompt.secret;
		this.#input.setValue("");
		this.#rebuild();

		const { promise, resolve, reject } = Promise.withResolvers<string>();
		this.#inputResolver = resolve;
		this.#inputRejecter = reject;
		return promise;
	}

	/** Route non-bracketed paste transports into the active login input. */
	pasteText(text: string): void {
		this.#input.pasteText(text);
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			this.#escape();
			return;
		}

		this.#input.handleInput(data);
	}
}
