/**
 * Speech as a side effect of the turn: which streamed deltas and finished
 * messages reach the vocalizer under each `speech.mode`, and the enhancer that
 * rewrites spoken blocks with the session's model registry.
 */
import type { AssistantMessage } from "@veyyon/ai";
import { extractTextContent } from "../../../commit/utils";
import { settings } from "../../../config/settings-instance";
import type { AgentSession } from "../../../session/agent-session";
import type { AgentSessionEvent } from "../../../session/agent-session-types";
import { SpeechEnhancer } from "../../../speech/tts/speech-enhancer";
import { vocalizer } from "../../../speech/tts/vocalizer";

/**
 * Enhanced speech (`speech.enhanced`) rewrites blocks through the speech
 * helper with this session's registry and credentials; the vocalizer falls
 * back to mechanical cleanup when unset. Tolerates partial sessions (tests,
 * minimal embeddings) by installing null.
 */
export function installSpeechEnhancer(session: AgentSession | undefined): void {
	vocalizer.setEnhancer(
		session?.modelRegistry && session.agent && session.settings
			? new SpeechEnhancer({
					settings: session.settings,
					registry: session.modelRegistry,
					sessionId: session.sessionId,
					currentModel: () => session.model,
					thinkingLevel: () => session.thinkingLevel,
					metadataResolver: provider => session.agent.metadataForProvider(provider),
					obfuscateProviderText: text => session.obfuscateProviderText(text),
				})
			: null,
	);
}

/** A new turn interrupts any speech still queued/playing from the previous one. */
export function vocalizeTurnStart(): void {
	vocalizer.clear();
}

/**
 * Speak streamed assistant output as a side effect of the turn. The mode
 * decides which deltas feed the vocalizer (the vocalizer re-checks enabled):
 * assistant|all speak text; all also speaks thinking; yield speaks nothing
 * live (the final message is spoken at turn end).
 */
export function vocalizeDelta(event: Extract<AgentSessionEvent, { type: "message_update" }>): void {
	if (!settings.get("speech.enabled")) return;
	const mode = settings.get("speech.mode");
	const delta = event.assistantMessageEvent;
	if (delta.type === "text_delta" && (mode === "assistant" || mode === "all")) {
		vocalizer.pushDelta(delta.delta);
	} else if (delta.type === "thinking_delta" && mode === "all") {
		vocalizer.pushDelta(delta.delta);
	}
}

/**
 * End-of-message vocalization: an abort (Esc, Ctrl+C, interrupt) stops speech now and drops the trailing partial;
 * assistant and all modes speak the last partial sentence of a completed message, while yield mode speaks the whole
 * final message at turn end.
 */
export function vocalizeMessageEnd(message: AssistantMessage): void {
	if (!settings.get("speech.enabled")) return;
	if (message.stopReason === "aborted") {
		vocalizer.clear();
		return;
	}
	const mode = settings.get("speech.mode");
	if (mode === "assistant" || mode === "all") vocalizer.flush();
}

/**
 * End-of-turn vocalization: yield mode speaks the final assistant message in
 * one shot here (the only mode that is post-hoc); every other mode just makes
 * sure the live buffer's trailing partial gets flushed.
 */
export function vocalizeTurnEnd(event: Extract<AgentSessionEvent, { type: "turn_end" }>): void {
	if (!settings.get("speech.enabled")) return;
	if (settings.get("speech.mode") !== "yield") {
		vocalizer.flush();
		return;
	}
	if (event.message.role !== "assistant") return;
	if (event.message.stopReason === "aborted") return; // interrupted: never speak the aborted partial
	const text = extractTextContent(event.message);
	if (text) vocalizer.speak(text);
}
