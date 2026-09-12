import { HoverFade, type HoverFadeOptions } from "@veyyon/utils/motion";

/**
 * Manages hover state and transition cross-fades for interactive list/tab components.
 */
export class HoverController<K = number | string> {
	#key: K | null = null;
	#fade?: HoverFade<K>;

	get key(): K | null {
		return this.#key;
	}

	set(key: K | null): void {
		this.#key = key;
		this.#fade?.set(key);
	}

	setMotion(options: HoverFadeOptions): void {
		this.#fade?.dispose();
		this.#fade = new HoverFade<K>(options);
		if (this.#key !== null) this.#fade.set(this.#key);
	}

	dispose(): void {
		this.#fade?.dispose();
		this.#fade = undefined;
		this.#key = null;
	}

	strength(key: K): number {
		if (this.#fade !== undefined) return this.#fade.strengthAt(key);
		return this.#key === key ? 1 : 0;
	}
}
