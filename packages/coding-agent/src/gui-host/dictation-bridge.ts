import type * as net from "node:net";
import { logger } from "@veyyon/utils";
import { STTController, type SttState } from "../speech/stt/stt-controller";
import { writeFrame } from "./frames";
import type { ClientSessionState } from "./turns";
import type { DictationView, SnapshotSection } from "./wire";

/**
 * The composer slice `STTController` drives, kept as text rather than as a
 * cursor over a draft.
 *
 * The draft is in the window, not here: the host never holds what has been
 * typed, so an insert here appends to the dictation's own utterance and the
 * window writes that after whatever its composer already held. The controller
 * only ever inserts at the cursor and only ever deletes the submit phrase it
 * just committed, so the two agree without the host modelling a caret.
 */
class DictationEditor {
	utterance = "";
	partial = "";
	submit = false;
	readonly #changed: () => void;

	constructor(changed: () => void) {
		this.#changed = changed;
	}

	insertText(text: string): void {
		this.utterance += text;
		this.#changed();
	}

	setVolatileText(text: string): void {
		this.partial = text;
		this.#changed();
	}

	clearVolatileText(): void {
		this.partial = "";
		this.#changed();
	}

	commitVolatileText(text: string): void {
		this.partial = "";
		this.utterance += text;
		this.#changed();
	}

	/**
	 * Drop the spoken submit phrase the controller has already committed. The
	 * count is in characters of that commit, so it never reaches past what this
	 * dictation added into the draft the window started with.
	 */
	deleteBeforeCursor(count: number): void {
		if (count <= 0) return;
		this.utterance = count >= this.utterance.length ? "" : this.utterance.slice(0, -count);
		this.#changed();
	}

	submitTurn(): void {
		this.submit = true;
		this.#changed();
	}
}

/**
 * Speech the window collects, recognised on the host.
 *
 * One per client, because the microphone and the draft it fills both belong to
 * a window rather than to a session: a second window dictating starts its own
 * recording and fills its own composer.
 */
export class DesktopDictationBridge {
	#controller = new STTController();
	readonly #editor: DictationEditor;
	readonly #socket?: net.Socket;
	readonly #broadcast?: (section: SnapshotSection) => void;
	#state: SttState = "idle";
	#status: string | null = null;
	#error: string | null = null;
	#revision = 0;
	#disposed = false;

	constructor(socket?: net.Socket, broadcast?: (section: SnapshotSection) => void) {
		this.#socket = socket;
		this.#broadcast = broadcast;
		this.#editor = new DictationEditor(() => {
			this.#publish();
		});
	}

	get state(): SttState {
		return this.#state;
	}

	view(): DictationView {
		return {
			state: this.#state,
			utterance: this.#editor.utterance,
			partial: this.#editor.partial,
			submit: this.#editor.submit,
			status: this.#status,
			error: this.#error,
			revision: this.#revision,
		};
	}

	/**
	 * Open the microphone, or close it and transcribe what it heard. Resolves
	 * once the recogniser has settled, so a caller that reports a request as
	 * succeeded reports it after the words have been sent.
	 */
	async toggle(): Promise<void> {
		if (this.#disposed) return;
		if (this.#state === "idle") {
			// The window has applied the previous dictation by now, so a fresh one
			// starts from empty rather than resending what the draft already holds.
			this.#editor.utterance = "";
			this.#editor.partial = "";
			this.#editor.submit = false;
			this.#error = null;
			this.#status = null;
		}
		await this.#controller.toggle(
			{
				insertText: text => this.#editor.insertText(text),
				setVolatileText: text => this.#editor.setVolatileText(text),
				clearVolatileText: () => this.#editor.clearVolatileText(),
				commitVolatileText: text => this.#editor.commitVolatileText(text),
				submit: () => this.#editor.submitTurn(),
				deleteBeforeCursor: count => this.#editor.deleteBeforeCursor(count),
			},
			{
				showWarning: message => {
					this.#error = message;
					logger.warn("dictation", { message });
					this.#publish();
				},
				showStatus: message => {
					this.#status = message.length > 0 ? message : null;
					this.#publish();
				},
				onStateChange: state => {
					this.#state = state;
					this.#publish();
				},
				requestRender: () => {
					this.#publish();
				},
			},
		);
	}

	/**
	 * Close the microphone and discard what it heard. The controller has no
	 * abort short of disposal, so the recogniser is torn down and replaced by
	 * the next toggle.
	 */
	cancel(): void {
		if (this.#state === "idle" && this.#editor.utterance.length === 0 && this.#editor.partial.length === 0) {
			return;
		}
		// `dispose()` is the controller's only abort, and it is terminal: a
		// disposed controller ignores every later toggle. Replace it so the next
		// dictation has a live recogniser.
		this.#controller.dispose();
		this.#controller = new STTController();
		this.#state = "idle";
		this.#editor.utterance = "";
		this.#editor.partial = "";
		this.#editor.submit = false;
		this.#status = null;
		this.#publish();
	}

	dispose(): void {
		this.#disposed = true;
		this.#controller.dispose();
		this.#state = "idle";
	}

	#publish(): void {
		if (this.#disposed) return;
		this.#revision += 1;
		const section: SnapshotSection = { Dictation: this.view() };
		if (this.#broadcast) {
			this.#broadcast(section);
		} else if (this.#socket && !this.#socket.destroyed) {
			writeFrame(this.#socket, { Snapshot: section });
		}
	}
}

/** The one dictation this client speaks into, made on first use. */
export function dictationForClient(
	state: ClientSessionState,
	socket?: net.Socket,
	broadcast?: (section: SnapshotSection) => void,
): DesktopDictationBridge {
	if (!state.dictation) {
		state.dictation = new DesktopDictationBridge(socket, broadcast);
	}
	return state.dictation;
}
