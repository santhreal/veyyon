/**
 * The autoswarm console a window holds open.
 *
 * `/autoswarm` builds one `LoopConsoleModel` and hands it to whichever surface
 * draws it. The terminal draws a card and reads keys; a window draws the
 * projection in `autoswarm-view` and sends back a field, an action or a
 * preset. Both drive the same model, so a blocked action is blocked for the
 * same reason on both, and the form the window edits is the form the model
 * builds: a row added there is a row the window draws without a change here.
 *
 * The console is per window. Its snapshot section carries the session it
 * belongs to, and a request that names a console no window has open is
 * refused rather than answered, so a stale window cannot change a setup it is
 * no longer looking at.
 */
import type * as net from "node:net";
import type { FormField } from "@veyyon/tui";
import { clamp } from "@veyyon/utils";
import { sanitizeSingleLine } from "@veyyon/utils/wrap";
import type { ConsoleAction, LoopConsoleModel } from "../autoresearch/console";
import { type AutoresearchUiDelegate, registerAutoresearchUi } from "../autoresearch/dashboard";
import type { AutoresearchRuntime } from "../autoresearch/types";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import { autoswarmConsoleView } from "./autoswarm-view";
import { writeFrame } from "./frames";
import type { AutoswarmAction, AutoswarmConsoleView, BackendError, SnapshotSection } from "./wire";

/** What a refused request states: the condition, then what moves past it. */
export type ConsoleRefusal = Omit<BackendError, "request" | "occurred_at_ms">;

/** The value a row takes, as the window sends it. */
export interface FieldValue {
	text?: string;
	number?: number;
	on?: boolean;
}

/** The handle the dashboard installs to repaint a console that moved on its own. */
export interface ConsoleMount {
	onMount: (handle: { requestRender: () => void }) => void;
	onDispose: () => void;
}

function refusal(code: string, message: string): ConsoleRefusal {
	return { scope: "Extension", code, message, retryable: false };
}

const NO_CONSOLE = refusal(
	"NO_CONSOLE",
	"This window has no autoswarm console open. Run /autoswarm to open one, then act on it.",
);

/**
 * One window's console: what it holds, what it publishes and what it accepts.
 *
 * `open` resolves when the console closes, which is what the command that
 * opened it awaits before it reads the action back.
 */
export class AutoswarmConsole {
	readonly #socket: net.Socket;
	readonly #session: () => string;
	#model: LoopConsoleModel | null = null;
	#runtime: AutoresearchRuntime | null = null;
	#fields: FormField[] = [];
	#open = false;
	#close: (() => void) | null = null;

	constructor(socket: net.Socket, session: () => string) {
		this.#socket = socket;
		this.#session = session;
	}

	/** True while a console is on the window. */
	get isOpen(): boolean {
		return this.#open;
	}

	/** The console as the window holds it, or null while none is open. */
	view(): AutoswarmConsoleView | null {
		if (!this.#open) return null;
		return autoswarmConsoleView(this.#session(), this.#model, this.#fields, this.#runtime);
	}

	/** The section a snapshot carries, whether or not a console is open. */
	section(): SnapshotSection {
		return { AutoswarmConsole: { session: this.#session(), console: this.view() } };
	}

	/**
	 * Draw `model` on the window until it closes. A console already open is
	 * closed first: one window draws one console, and the command whose console
	 * was replaced unwinds rather than waiting on a surface nothing shows.
	 */
	open(runtime: AutoresearchRuntime | null, model: LoopConsoleModel | null, mount?: ConsoleMount): Promise<void> {
		this.close();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#model = model;
		this.#runtime = runtime;
		this.#open = true;
		this.#close = () => {
			this.#open = false;
			this.#model = null;
			this.#runtime = null;
			this.#fields = [];
			this.#close = null;
			this.#publish();
			mount?.onDispose();
			resolve();
		};
		mount?.onMount({ requestRender: () => this.refresh() });
		this.refresh();
		return promise;
	}

	/** Close the console and let the command that opened it go on. */
	close(): void {
		this.#close?.();
	}

	/** Rebuild the form from the model and publish what the window draws. */
	refresh(): void {
		if (this.#open && this.#model) {
			const model = this.#model;
			this.#fields = model.formFields({ onAction: action => this.#perform(model, action) });
		}
		this.#publish();
	}

	/**
	 * Set the row `field` from what the window sent. The refusal states which
	 * value the row takes when the request carries the wrong one, so a client
	 * that stepped a text row is told what to send rather than silently ignored.
	 */
	setField(field: string, value: FieldValue): ConsoleRefusal | null {
		if (!this.#open) return NO_CONSOLE;
		const row = this.#fields.find(entry => entry.id === field);
		if (!row) {
			return refusal("FIELD_NOT_FOUND", `The console has no '${field}' row. Send a row the console states.`);
		}
		if (row.kind === "text") {
			if (typeof value.text !== "string") return wrongValue(field, "text");
			row.onChange(sanitizeSingleLine(value.text));
		} else if (row.kind === "segmented") {
			if (typeof value.text !== "string") return wrongValue(field, "text");
			if (!row.options.some(option => option.value === value.text)) {
				return refusal("OPTION_NOT_FOUND", `'${value.text}' is not an option on '${field}'. Send one it offers.`);
			}
			row.onChange(value.text);
		} else if (row.kind === "stepper") {
			if (typeof value.number !== "number" || !Number.isFinite(value.number)) return wrongValue(field, "number");
			row.onChange(clamp(Math.floor(value.number), row.min, row.max));
		} else if (row.kind === "toggle") {
			if (typeof value.on !== "boolean") return wrongValue(field, "on");
			row.onChange(value.on);
		} else {
			return refusal("FIELD_NOT_EDITABLE", `'${field}' states a value and takes none. Act on it instead.`);
		}
		this.refresh();
		return null;
	}

	/**
	 * Run `action`. A blocked action is refused with what the model states
	 * blocks it, which is the text the window already draws under the button.
	 */
	act(action: AutoswarmAction): ConsoleRefusal | null {
		if (!this.#open || !this.#model) return NO_CONSOLE;
		const blocker = this.#model.blocker(action);
		if (blocker !== null) {
			return refusal("ACTION_BLOCKED", `${action} cannot run: ${blocker}.`);
		}
		this.#perform(this.#model, action);
		return null;
	}

	/** Save the setup on the window under `name`. */
	savePreset(name: string): ConsoleRefusal | null {
		if (!this.#open || !this.#model) return NO_CONSOLE;
		this.#model.presetName = name;
		if (!this.#model.savePreset()) {
			// The name stays on the row: the window keeps what was typed, so a
			// name the store rejected is corrected rather than retyped.
			this.refresh();
			return refusal("PRESET_NOT_SAVED", "The preset was not saved. Type a name the setup can be saved under.");
		}
		this.refresh();
		return null;
	}

	/** Remove the saved preset the rows currently equal. */
	deletePreset(): ConsoleRefusal | null {
		if (!this.#open || !this.#model) return NO_CONSOLE;
		if (!this.#model.deletePresetInForce()) {
			return refusal("PRESET_NOT_DELETED", "The rows match no saved preset. Choose a saved preset, then delete it.");
		}
		this.refresh();
		return null;
	}

	#perform(model: LoopConsoleModel, action: ConsoleAction): void {
		if (model.perform(action) === "close") this.close();
		else this.refresh();
	}

	#publish(): void {
		if (this.#socket.destroyed) return;
		writeFrame(this.#socket, { Snapshot: this.section() });
	}
}

function wrongValue(field: string, expected: "text" | "number" | "on"): ConsoleRefusal {
	return refusal("INVALID_ARGUMENTS", `The '${field}' row takes a ${expected} value. Send ${expected} with it.`);
}

/**
 * The console each window's UI context holds. The command that opens one is
 * handed an `ExtensionContext`, and the context it carries is the window's own
 * UI context, so that object is what a console is found by: the delegate below
 * draws in the window the command runs in and in no other.
 */
const consoles = new WeakMap<ExtensionUIContext, AutoswarmConsole>();

export function attachAutoswarmConsole(ui: ExtensionUIContext, surface: AutoswarmConsole): void {
	consoles.set(ui, surface);
}

/** The window host's autoswarm surfaces: the run ledger and the launcher. */
export const guiAutoswarmUi: AutoresearchUiDelegate = {
	claims: ctx => consoles.has(ctx.ui),
	async showScreen(ctx, runtime, model, options) {
		await consoles.get(ctx.ui)?.open(runtime, model, options);
	},
	async showLauncher(ctx, model) {
		// The launcher opens on a branch carrying no swarm, so there is no
		// ledger to report beside the setup rows.
		await consoles.get(ctx.ui)?.open(null, model);
	},
};

registerAutoresearchUi(guiAutoswarmUi);
