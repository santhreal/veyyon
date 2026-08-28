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
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_LARGE,
	type ModalShellGeometry,
	type ModalShortcut,
	renderModalShell,
	sizingForArea,
} from "./modal-shell";

interface PromptState {
	message: string;
	placeholder?: string;
	secret: boolean;
	submitVerb: string;
}

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
	#escapeMode: "cancel" | "skip" = "cancel";
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#getTerminalRows: () => number;

	constructor(
		tui: TUI,
		providerId: string,
		private onComplete: (success: boolean, message?: string) => void,
		options?: { getTerminalRows?: () => number },
	) {
		this.#tui = tui;
		this.#title = `Login to ${formatProviderName(providerId)}`;
		this.#getTerminalRows = options?.getTerminalRows ?? (() => process.stdout.rows || 40);
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

	invalidate(): void {}

	render(width: number): string[] {
		const termHeight = Math.max(14, this.#getTerminalRows());
		const sizing = sizingForArea(MODAL_SIZING_LARGE, termHeight);
		const dims = computeModalDims(width, termHeight, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return new Array(termHeight).fill(padding(width));
		}

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
		return shell.lines;
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

	showAuth(url: string, instructions?: string, launchUrl?: string): void {
		this.#auth = { url, ...(launchUrl ? { launchUrl } : {}), ...(instructions ? { instructions } : {}) };
		this.#tui.requestRender();
		openPath(url);
	}

	showProgress(message: string): void {
		this.#status = message;
		this.#tui.requestRender();
	}

	showPrompt(prompt: { message: string; placeholder?: string; secret?: boolean }): Promise<string> {
		return this.#ask({
			message: prompt.message,
			...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
			secret: prompt.secret !== false,
			submitVerb: "submit",
		});
	}

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

	pasteText(text: string): void {
		this.#input.pasteText(text);
	}

	dispose(): void {}
}
