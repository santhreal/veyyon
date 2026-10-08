/**
 * Regenerates the session title when the model re-plans with a fresh todo board.
 *
 * This is a session collaborator. It holds the `TITLE_SYSTEM.md` override every automatic title
 * request uses and the one refresh allowed in flight, and reaches the session only through
 * {@link ReplanTitleRefreshHost}. A title the user set is never replaced.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import type { Api, Model } from "@veyyon/ai";
import type { SessionTitleSource } from "@veyyon/kernel/session/session-entries";
import type { SideCompleteImpl } from "@veyyon/kernel/session/side-complete";
import { errorMessage, logger } from "@veyyon/utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { formatTitleConversationContext, type TitleConversationTurn } from "../../tiny/message-preproc";
import { generateSessionTitle } from "../../utils/title-generator";
import { titleConversationTurnFromMessage } from "../agent-session-message-shapes";
import type { SessionNameTrigger } from "../agent-session-types";

/** Conversation turns, newest last, the refreshed title is generated from. */
const CONTEXT_TURN_LIMIT = 6;

/** The agent slice the refresh reads. `Agent` satisfies this structurally. */
export interface ReplanTitleAgent {
	readonly state: { readonly messages: readonly AgentMessage[] };
	metadataForProvider(provider: string): Record<string, unknown> | undefined;
}

/** The session log slice that holds the title. `SessionManager` satisfies this. */
export interface ReplanTitleStore {
	readonly titleSource: SessionTitleSource | undefined;
	getSessionId(): string;
	setSessionName(name: string, source: SessionTitleSource, trigger: SessionNameTrigger): Promise<boolean>;
}

/** What {@link ReplanTitleRefresh} needs from the session that holds it. */
export interface ReplanTitleRefreshHost {
	readonly agent: ReplanTitleAgent;
	readonly sessionStore: ReplanTitleStore;
	/** `title.refreshOnReplan` is read when the refresh starts and again before the title is written. */
	readonly settings: Settings;
	readonly modelRegistry: ModelRegistry;
	model(): Model<Api> | undefined;
	obfuscateProviderText(text: string): string;
	readonly sideComplete: SideCompleteImpl;
}

export class ReplanTitleRefresh {
	readonly #host: ReplanTitleRefreshHost;
	#inFlight: Promise<void> | undefined;
	/**
	 * Resolved `TITLE_SYSTEM.md` override applied to every automatic session-title generation path,
	 * or undefined when the bundled prompt is in effect.
	 */
	systemPrompt: string | undefined;

	constructor(host: ReplanTitleRefreshHost, systemPrompt: string | undefined) {
		this.#host = host;
		this.systemPrompt = systemPrompt;
	}

	/**
	 * Start a title refresh from the latest conversation turns, unless one is already running, the
	 * setting is off, the user named the session, or there is no conversation to title.
	 */
	schedule(): void {
		if (this.#inFlight) return;
		const { settings, sessionStore } = this.#host;
		if (!settings.get("title.refreshOnReplan")) return;
		if (sessionStore.titleSource === "user") return;
		const context = this.#conversationContext();
		if (!context) return;
		const sessionId = sessionStore.getSessionId();
		const refresh = this.#refresh(context, sessionId)
			.catch(err => {
				logger.warn("title-generator: replan refresh failed", {
					sessionId,
					error: errorMessage(err),
				});
			})
			.finally(() => {
				if (this.#inFlight === refresh) this.#inFlight = undefined;
			});
		this.#inFlight = refresh;
	}

	#conversationContext(): string {
		const messages = this.#host.agent.state.messages;
		const turns: TitleConversationTurn[] = [];
		for (let i = messages.length - 1; i >= 0 && turns.length < CONTEXT_TURN_LIMIT; i--) {
			const message = messages[i];
			if (!message) continue;
			const turn = titleConversationTurnFromMessage(message);
			if (turn) turns.push(turn);
		}
		turns.reverse();
		return formatTitleConversationContext(turns);
	}

	async #refresh(context: string, sessionId: string): Promise<void> {
		const host = this.#host;
		const title = await generateSessionTitle(
			context,
			host.modelRegistry,
			host.settings,
			sessionId,
			host.model(),
			provider => host.agent.metadataForProvider(provider),
			this.systemPrompt,
			text => host.obfuscateProviderText(text),
			host.sideComplete,
		);
		if (!title) return;
		const { settings, sessionStore } = host;
		// The session may have moved on while the title was generated.
		if (sessionStore.getSessionId() !== sessionId) return;
		if (!settings.get("title.refreshOnReplan")) return;
		if (sessionStore.titleSource === "user") return;
		await sessionStore.setSessionName(title, "auto", "replan");
	}
}
