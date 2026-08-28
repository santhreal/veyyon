import { type Component, Container } from "@veyyon/tui";

export interface ChatBlockHost {
	requestComponentRender(component: Component): void;
}

export abstract class ChatBlock extends Container {
	#host: ChatBlockHost | undefined;
	#cleanups: Array<() => void> = [];
	#active = false;
	#disposed = false;

	onMount(): void {}

	onCleanup(cleanup: () => void): void {
		if (this.#disposed) {
			cleanup();
			return;
		}
		this.#cleanups.push(cleanup);
	}

	requestRender(): void {
		this.#host?.requestComponentRender(this);
	}

	get active(): boolean {
		return this.#active;
	}

	mount(host: ChatBlockHost): void {
		if (this.#host || this.#disposed) return;
		this.#host = host;
		this.#active = true;
		this.onMount();
	}

	finish(): void {
		if (!this.#active) return;
		this.#active = false;
		this.#runCleanups();
		this.requestRender();
	}

	override dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#active = false;
		this.#runCleanups();
		super.dispose();
		this.#host = undefined;
	}

	isTranscriptBlockFinalized(): boolean {
		return !this.#active;
	}

	#runCleanups(): void {
		const cleanups = this.#cleanups.splice(0);
		for (const cleanup of cleanups) cleanup();
	}
}
