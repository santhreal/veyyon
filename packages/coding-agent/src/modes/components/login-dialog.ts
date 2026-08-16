import {
	type Component,
	getKeybindings,
	Input,
	padding,
	routeSgrMouseInput,
	type SgrMouseEvent,
	type TUI,
	wrapTextWithAnsi,
} from "@veyyon/tui";
import { theme } from "../../modes/theme/theme";
import { formatProviderName } from "../../slash-commands/helpers/format";
import { openPath } from "../../utils/open";
import {
	applyModalReveal,
	beginModalExit,
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_LARGE,
	ModalRevealDriver,
	type ModalShellGeometry,
	type ModalShortcut,
	renderModalShell,
	sizingForArea,
} from "./modal-shell";

/** What a login flow is currently asking the operator to paste. */
interface PromptState {
	message: string;
	placeholder?: string;
	/** Mask the value and take the paste byte for byte: the answer is a credential. */
	secret: boolean;
	/** The verb Enter performs in this prompt ("submit" a credential, "save" a name). */
	submitVerb: string;
}

/** Where the operator has to go to authorize, once a flow knows. */
interface AuthState {
	url: string;
	launchUrl?: string;
	instructions?: string;
}

const LOGIN_CANCEL_CHIPS: readonly ModalShortcut[] = [
	{ label: "cancel", keybindings: ["tui.select.cancel"], clickable: true, id: "cancel" },
];

function loginPromptChips(submitVerb: string, cancelVerb: string): readonly ModalShortcut[] {
	return [
		{ label: submitVerb, keybindings: ["tui.select.confirm"] },
		{ label: cancelVerb, keybindings: ["tui.select.cancel"], clickable: true, id: "cancel" },
	];
}

/**
 * The login surface: one floating ModalShell card, rebuilt from state, hosted
 * as a fullscreen overlay while a provider flow runs.
 *
 * WHY IT IS REBUILT rather than appended to. Every `show*` used to push rows
 * onto one container, so the frame was a log of everything the flow had ever
 * said. An API-key login that failed validation and asked again rendered two
 * prompts, two footers, and its second question BELOW the input it belonged
 * to. There are four things this card can show, and each has exactly one
 * place: where to authorize, what is happening right now, what is being
 * asked, and which keys work. Setting one replaces it.
 */
export class LoginDialogComponent implements Component {
	#input: Input;
	#tui: TUI;
	#title: string;
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
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#getTerminalRows: () => number;
	#reveal = new ModalRevealDriver();
	/**
	 * Fade out on the shared clock before the host drops this card. The overlay stack keeps painting
	 * it and stops routing input to it the moment this is called.
	 */
	beginOverlayExit(requestRender: () => void, done: () => void): boolean {
		return beginModalExit(this.#reveal, requestRender, done);
	}

	constructor(
		tui: TUI,
		providerId: string,
		private onComplete: (success: boolean, message?: string) => void,
		options?: { getTerminalRows?: () => number; reveal?: boolean },
	) {
		this.#tui = tui;
		// One label owner for provider names, the same one the status line, the account card and the
		// logout dialog use. Reading the browser-login table here printed a raw slug (`Login to groq`)
		// for every provider that authenticates with a pasted key, since that table has no row for one.
		this.#title = `Login to ${formatProviderName(providerId)}`;
		this.#getTerminalRows = options?.getTerminalRows ?? (() => process.stdout.rows || 40);
		if (options?.reveal) {
			// The driver anchors its clock at first paint, so starting here never
			// skips the unfold.
			this.#reveal.start(() => this.#tui.requestRender());
		}

		this.#input = new Input();
		this.#input.onSubmit = () => {
			this.#settlePrompt(this.#input.getValue());
		};
		this.#input.onEscape = () => {
			this.#escape();
		};
	}

	get signal(): AbortSignal {
		return this.#abortController.signal;
	}

	/** Hand the pending prompt its answer and take the question off the card. */
	#settlePrompt(value: string): void {
		const resolve = this.#inputResolver;
		this.#inputResolver = undefined;
		this.#inputRejecter = undefined;
		this.#prompt = undefined;
		this.#escapeMode = "cancel";
		this.#tui.requestRender();
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

	#chips(): readonly ModalShortcut[] {
		const prompt = this.#prompt;
		if (!prompt) return LOGIN_CANCEL_CHIPS;
		return loginPromptChips(prompt.submitVerb, this.#escapeMode === "skip" ? "skip" : "cancel");
	}

	invalidate(): void {
		// Stateless: the card is laid out from fields on every render.
	}

	render(width: number): string[] {
		const termHeight = Math.max(14, this.#getTerminalRows());
		// LARGE, not MEDIUM: the authorize URL is a copy target and a narrow card
		// wraps it mid-token, so the card takes the wider sizing to keep a typical
		// URL on one row.
		const sizing = sizingForArea(MODAL_SIZING_LARGE, termHeight);
		const dims = computeModalDims(width, termHeight, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return Array.from({ length: termHeight }, () => padding(width));
		}

		// Lay the card out from state: where to go, what is happening, what is
		// being asked. One blank line between blocks and none inside one, so the
		// card reads the same however many times a flow re-asked. Body lines wrap
		// rather than clip: the authorize URL is a copy target, and a clipped
		// tail silently drops OAuth query parameters.
		const body: string[] = [];
		const say = (line: string): void => {
			body.push(...wrapTextWithAnsi(line, dims.contentWidth));
		};
		const auth = this.#auth;
		if (auth) {
			say(theme.fg("accent", auth.url));
			const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
			body.push(theme.fg("dim", `\x1b]8;;${auth.url}\x07${clickHint}\x1b]8;;\x07`));
			if (auth.launchUrl && auth.launchUrl !== auth.url) {
				say(theme.fg("dim", `Local shortcut (this machine only): ${auth.launchUrl}`));
			}
			if (auth.instructions) {
				body.push("");
				say(theme.fg("warning", auth.instructions));
			}
		}

		if (this.#status) {
			if (body.length > 0) body.push("");
			say(theme.fg("dim", this.#status));
		}

		const prompt = this.#prompt;
		if (prompt) {
			if (body.length > 0) body.push("");
			say(theme.fg("text", prompt.message));
			body.push(...this.#input.render(dims.contentWidth));
			if (prompt.placeholder) {
				body.push(theme.fg("dim", `looks like ${prompt.placeholder}`));
			}
		}

		const shell = renderModalShell({
			title: this.#title,
			sizing,
			areaWidth: width,
			areaHeight: termHeight,
			body,
			shortcuts: this.#chips(),
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		return applyModalReveal(shell, width, this.#reveal.value);
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouse(event));
			return;
		}

		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.#escape();
			return;
		}

		this.#input.handleInput(data);
	}

	#routeMouse(event: SgrMouseEvent): boolean {
		const chrome = hitTestModalChrome(this.#shellGeometry, event.row, event.col, {
			motion: event.motion,
			leftClick: event.leftClick,
		});
		if (
			consumeModalChipHover(chrome, this.#hoveredShortcutId, id => {
				this.#hoveredShortcutId = id;
				this.#tui.requestRender();
			})
		) {
			return true;
		}
		if (event.motion) return true;
		if (
			chrome.kind === "close" ||
			chrome.kind === "outside" ||
			(chrome.kind === "shortcut" && chrome.id === "cancel")
		) {
			this.#escape();
			return true;
		}
		return true;
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
		this.#tui.requestRender();
		// Best-effort: a relayout must never open a second tab.
		openPath(url);
	}

	/**
	 * Called by the `onProgress` callback. One status line, replaced rather than appended: three
	 * validation attempts are three states of one login, not three things to read.
	 */
	showProgress(message: string): void {
		this.#status = message;
		this.#tui.requestRender();
	}

	/** Ask for a credential (or a pasted code) and wait. Replaces any question already on screen. */
	showPrompt(prompt: { message: string; placeholder?: string; secret?: boolean }): Promise<string> {
		return this.#ask({
			message: prompt.message,
			...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
			// Absent means masked: a flow that wants a readable field says so.
			secret: prompt.secret !== false,
			submitVerb: "submit",
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
			submitVerb: "save",
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
		this.#tui.requestRender();

		const { promise, resolve, reject } = Promise.withResolvers<string>();
		this.#inputResolver = resolve;
		this.#inputRejecter = reject;
		return promise;
	}

	/** Route non-bracketed paste transports into the active login input. */
	pasteText(text: string): void {
		this.#input.pasteText(text);
	}

	/** Settle the reveal so no timer outlives a dismissed card. */
	dispose(): void {
		this.#reveal.stop();
	}
}
