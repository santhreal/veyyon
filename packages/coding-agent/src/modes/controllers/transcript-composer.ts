import type { AgentMessage } from "@veyyon/agent-core";
import type { Component } from "@veyyon/tui";
import type { SessionContext } from "../../session/session-context";
import type { ToolExecutionHandle } from "../components/tool-execution";
import type { TranscriptContainer } from "../components/transcript-container";
import type { SubmittedUserInput } from "../types";

export interface TranscriptComposerPort {
	chatContainer: TranscriptContainer;
	addMessageToChat(
		message: AgentMessage,
		options?: { populateHistory?: boolean; imageLinks?: readonly (string | undefined)[] },
	): void;
	renderSessionContext(context: SessionContext): void;
	buildTranscriptContext(): SessionContext;
	isViewStreaming(): boolean;
	streamingComponent(): Component | undefined;
	pendingTools: Map<string, ToolExecutionHandle>;
	isKnownSlashCommand(text: string): boolean;
	pendingSubmission(): SubmittedUserInput | undefined;
}

export class TranscriptComposer {
	readonly localEchoSignatures = new Set<string>();
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
		for (const [id, component] of livePendingTools) {
			this.port.pendingTools.set(id, component);
		}
		this.#replayOptimistic();
	}
}
