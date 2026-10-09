import { logger } from "@veyyon/utils";
import type { AgentSession } from "../../../session/agent-session";
import { ComposerPredictor } from "../../../session/composer-prediction";
import type { InteractiveModeContext } from "../types";

export type ComposerPredictionContext = Pick<InteractiveModeContext, "editor" | "showWarning" | "ui" | "viewSession">;

/**
 * Shows composer predictions in the terminal: requests one when a turn ends,
 * paints it as ghost text in the empty composer, and drops it when anything
 * newer happens. A request in flight is aborted by the next turn, a session
 * switch or teardown, so a stale prediction never paints over fresh work.
 */
export class ComposerPredictionController {
	#abort: AbortController | undefined;
	/** Whether this controller put the prediction the editor holds. */
	#painted = false;
	#predictors = new WeakMap<AgentSession, ComposerPredictor>();
	/** Unavailability reasons already shown; each is shown once per process. */
	#reportedReasons = new Set<string>();

	constructor(private readonly ctx: ComposerPredictionContext) {}

	/**
	 * Request a prediction for the turn that just ended in the viewed session.
	 * Returns the request, which settles once it has painted or given up (it
	 * never rejects), or `undefined` when no request is made.
	 */
	request(): Promise<void> | undefined {
		this.cancel();
		const session = this.ctx.viewSession;
		if (session.settings.get("composer.predictions.mode") === "off") return undefined;
		if (session.isStreaming || session.isCompacting) return undefined;
		if (this.ctx.editor.getText().trim()) return undefined;
		const last = session.getLastAssistantMessage();
		if (!last || last.stopReason === "aborted" || last.stopReason === "error") return undefined;
		const abort = new AbortController();
		this.#abort = abort;
		return this.#run(session, abort);
	}

	/** Abort any request in flight and clear the prediction this controller painted. */
	cancel(): void {
		this.#abort?.abort();
		this.#abort = undefined;
		if (!this.#painted) return;
		this.#painted = false;
		this.ctx.editor.setPrediction(undefined);
		this.ctx.ui.requestRender();
	}

	async #run(session: AgentSession, abort: AbortController): Promise<void> {
		let predictor = this.#predictors.get(session);
		if (!predictor) {
			predictor = new ComposerPredictor(session, session.settings);
			this.#predictors.set(session, predictor);
		}
		try {
			const outcome = await predictor.predict(abort.signal);
			if (this.#abort !== abort || abort.signal.aborted) return;
			if (outcome.kind === "prediction") {
				if (session !== this.ctx.viewSession || session.isStreaming) return;
				// The user started writing while the request was in flight.
				if (this.ctx.editor.getText().trim()) return;
				this.ctx.editor.setPrediction(outcome.text);
				this.#painted = true;
				this.ctx.ui.requestRender();
			} else if (outcome.kind === "unavailable" && !this.#reportedReasons.has(outcome.reason)) {
				this.#reportedReasons.add(outcome.reason);
				this.ctx.showWarning(`Composer predictions: ${outcome.reason}`);
			}
		} catch (error) {
			if (!abort.signal.aborted) logger.warn("Composer prediction failed", { error: String(error) });
		} finally {
			if (this.#abort === abort) this.#abort = undefined;
		}
	}
}
