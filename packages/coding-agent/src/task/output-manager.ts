import * as fs from "node:fs/promises";
import { ADVISOR_TRANSCRIPT_STEM } from "../advisor/transcript-recorder";

export class AgentOutputManager {
	#initialized = false;
	readonly #taken = new Set<string>();
	readonly #getArtifactsDir: () => string | null;
	readonly #parentPrefix: string | undefined;

	constructor(getArtifactsDir: () => string | null, options?: { parentPrefix?: string }) {
		this.#getArtifactsDir = getArtifactsDir;
		this.#parentPrefix = options?.parentPrefix;
		this.#taken.add(ADVISOR_TRANSCRIPT_STEM);
	}

	async #ensureInitialized(): Promise<void> {
		if (this.#initialized) return;
		this.#initialized = true;

		const dir = this.#getArtifactsDir();
		if (!dir) return;

		let files: string[];
		try {
			files = await fs.readdir(dir);
		} catch {
			return; // Directory doesn't exist yet
		}

		const prefix = this.#parentPrefix ? `${this.#parentPrefix}.` : "";
		for (const file of files) {
			if (!file.endsWith(".md")) continue;
			let rest = file.slice(0, -3); // drop ".md"
			if (prefix) {
				if (!rest.startsWith(prefix)) continue;
				rest = rest.slice(prefix.length);
			}
			const dot = rest.indexOf(".");
			const segment = dot === -1 ? rest : rest.slice(0, dot);
			if (segment) this.#taken.add(segment);
		}
	}

	#allocateUnique(id: string): string {
		let candidate = id;
		for (let n = 2; this.#taken.has(candidate); n++) {
			candidate = `${id}-${n}`;
		}
		this.#taken.add(candidate);
		return this.#parentPrefix ? `${this.#parentPrefix}.${candidate}` : candidate;
	}

	async allocate(id: string): Promise<string> {
		await this.#ensureInitialized();
		return this.#allocateUnique(id);
	}
}
