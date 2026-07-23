/**
 * Transcript composition (extracted from interactive-mode, ARCH-2): the
 * optimistic user message, the local-echo signature registry, and the full
 * chat rebuild live here behind a narrow port. The invariants this module
 * owns are the subtle ones that shipped as bugs when they were scattered:
 * a mid-stream rebuild must not orphan the live streaming/tool components
 * (#3656), a pre-streaming rebuild must not erase the just-submitted user
 * message (#2372), and finishing a submission must only tear the optimistic
 * echo down once the stream has actually quiesced.
 */

import type { AgentMessage } from "@veyyon/agent-core";
import type { Component } from "@veyyon/tui";
import type { SessionContext } from "../../session/session-context";
import type { ToolExecutionHandle } from "../components/tool-execution";
import type { TranscriptContainer } from "../components/transcript-container";
import type { SubmittedUserInput } from "../types";

/** The host capabilities transcript composition is a function of. Rendering
 * stays with its owners (UiHelpers via the host's delegates); the composer
 * only decides WHAT is in the chat container and remembers what it added. */
export interface TranscriptComposerPort {
	chatContainer: TranscriptContainer;
	addMessageToChat(
		message: AgentMessage,
		options?: { populateHistory?: boolean; imageLinks?: readonly (string | undefined)[] },
	): void;
	renderSessionContext(context: SessionContext): void;
	/** The committed transcript context to replay on rebuild (the host applies
	 * its collapse-compacted display setting). */
	buildTranscriptContext(): SessionContext;
	/** Whether the VIEWED session is streaming (main or focused subagent). */
	isViewStreaming(): boolean;
	streamingComponent(): Component | undefined;
	pendingTools: Map<string, ToolExecutionHandle>;
	isKnownSlashCommand(text: string): boolean;
	/** The submission optimistically rendered but not yet committed, if any. */
	pendingSubmission(): SubmittedUserInput | undefined;
}

export class TranscriptComposer {
	/** Signatures of user texts submitted from THIS client, so the echo of our
	 * own `user` message event is not rendered twice. */
	readonly localEchoSignatures = new Set<string>();
	/** Signature of the currently displayed optimistic user message, or
	 * undefined when none is pending. */
	optimisticSignature: string | undefined;
	#optimisticDispose: (() => void) | undefined;
	#optimisticComponents: Component[] = [];

	constructor(private readonly port: TranscriptComposerPort) {}

	recordLocalSubmission(text: string, imageCount = 0): () => void {
		if (this.port.isKnownSlashCommand(text)) {
			return () => {};
		}
		const signature = `${text}\u0000${imageCount}`;
		this.localEchoSignatures.add(signature);
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			this.localEchoSignatures.delete(signature);
		};
	}

	#captureAddedChatComponents(render: () => void): Component[] {
		const start = this.port.chatContainer.children.length;
		render();
		return this.port.chatContainer.children.slice(start);
	}

	#renderOptimistic(submission: SubmittedUserInput): void {
		this.port.addMessageToChat(
			{
				role: "user",
				content: [{ type: "text", text: submission.text }, ...(submission.images ?? [])],
				attribution: "user",
				timestamp: Date.now(),
			},
			{ imageLinks: submission.imageLinks },
		);
	}

	/** Optimistically render `submission` as the user's message and remember
	 * everything needed to replace or retract it when the real event lands. */
	showOptimistic(submission: SubmittedUserInput): void {
		const imageCount = submission.images?.length ?? 0;
		this.optimisticSignature = `${submission.text}\u0000${imageCount}`;
		this.#optimisticDispose = this.recordLocalSubmission(submission.text, imageCount);
		this.#optimisticComponents = this.#captureAddedChatComponents(() => this.#renderOptimistic(submission));
	}

	clearOptimistic(): void {
		this.optimisticSignature = undefined;
		this.#optimisticDispose?.();
		this.#optimisticDispose = undefined;
		this.#optimisticComponents = [];
	}

	/** Swap the optimistic rendering for the committed message: remove exactly
	 * the components the optimistic render added, then render the real one. */
	replaceOptimistic(message: AgentMessage, options?: { imageLinks?: readonly (string | undefined)[] }): void {
		this.optimisticSignature = undefined;
		this.#optimisticDispose?.();
		this.#optimisticDispose = undefined;
		for (const component of this.#optimisticComponents) {
			this.port.chatContainer.removeChild(component);
		}
		this.#optimisticComponents = [];
		this.port.addMessageToChat(message, options);
	}

	/**
	 * A submission's prompt() call returned. When this composer still owns
	 * that submission's echo (`owned`), detach the dispose so a later clear
	 * cannot double-run it — but only tear the optimistic state down when the
	 * stream has fully quiesced (`quiesced`): with tokens still flowing, the
	 * `message_start` event is the one that retires the echo, not this return.
	 */
	onSubmissionFinished(opts: { owned: boolean; quiesced: boolean }): void {
		const dispose = this.#optimisticDispose;
		if (opts.owned) this.#optimisticDispose = undefined;
		if (opts.owned && opts.quiesced) {
			this.optimisticSignature = undefined;
			dispose?.();
			this.#optimisticComponents = [];
		}
	}

	#replayOptimistic(): void {
		if (!this.optimisticSignature) return;
		const submission = this.port.pendingSubmission();
		if (!submission || submission.cancelled || submission.customType) return;
		this.#optimisticComponents = this.#captureAddedChatComponents(() => this.#renderOptimistic(submission));
	}

	rebuild(): void {
		// Mid-stream rebuilds (e.g. `/shake`, theme/setting changes that touch the
		// transcript) replay only committed `state.messages`. The agent's in-flight
		// `streamMessage` and its still-pending tool calls live OUTSIDE
		// `state.messages` until `message_end`, so a plain clear+replay detaches
		// their UI components while keeping the `streamingComponent` / `pendingTools`
		// references — subsequent `message_update`/`message_end` events would then
		// update orphaned components that never re-render and the live LLM output
		// vanishes from the chat (#3656). Snapshot the in-flight components,
		// clear+replay, then re-append them in their original chat-container order
		// and restore the `pendingTools` map so streaming routes back into them.
		const liveComponents: Component[] = [];
		const livePendingTools = new Map<string, ToolExecutionHandle>();
		if (this.port.isViewStreaming()) {
			const liveSet = new Set<Component>();
			const streaming = this.port.streamingComponent();
			if (streaming) liveSet.add(streaming);
			for (const [id, component] of this.port.pendingTools) {
				livePendingTools.set(id, component);
				liveSet.add(component as unknown as Component);
			}
			if (liveSet.size > 0) {
				for (const child of this.port.chatContainer.children) {
					if (liveSet.has(child)) liveComponents.push(child);
				}
			}
		}
		this.port.chatContainer.clear();
		this.port.renderSessionContext(this.port.buildTranscriptContext());
		for (const child of liveComponents) {
			this.port.chatContainer.addChild(child);
		}
		// `renderSessionContext` clears `pendingTools` at start AND end so the
		// reconstructed historical tool components don't leak into live tracking.
		// Restore the in-flight entries afterwards so the next streamed tool-call
		// delta is routed into the preserved component instead of stacking a
		// duplicate ToolExecutionComponent below it.
		for (const [id, component] of livePendingTools) {
			this.port.pendingTools.set(id, component);
		}
		// During the pre-streaming window — after the optimistic render of the
		// user's message but before the user `message_start` event lands it in
		// `session` entries — any rebuild (e.g. Ctrl+T
		// toggleThinkingBlockVisibility, theme selector) would otherwise erase
		// the user's just-submitted message until the first assistant token
		// arrived (#2372). Once `message_start` fires the signature is cleared
		// by `EventController`, so this replay is a no-op post-streaming and
		// cannot duplicate.
		this.#replayOptimistic();
	}
}
