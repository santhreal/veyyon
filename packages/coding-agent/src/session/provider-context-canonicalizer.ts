import type { Message } from "@veyyon/ai";
import { canonicalizeToolCallIdsInMessage, type ToolCallIdMap } from "./canonicalize-tool-call-ids";
import { createPathRelativizer, type PathRelativizer } from "./relativize-paths";

export interface CanonicalizedProviderMessages {
	messages: Message[];
	bytesSaved: number;
}

/**
 * Incrementally canonicalize an append-mostly provider history.
 *
 * Source message identity defines the reusable prefix. A change of roots swaps
 * the relativizer for everything canonicalized from then on and leaves that
 * prefix alone, so a message keeps the exact bytes it was already sent with and
 * a cwd change does not invalidate the provider's cached prefix. Re-rendering it
 * would not reproduce those bytes: only the active cwd is a root, so a path under
 * the previous one renders absolute once the session has moved.
 */
export class ProviderContextCanonicalizer {
	#map: ToolCallIdMap;
	#allocate: () => string;
	#relativizer: PathRelativizer | undefined;
	#source: Message[] = [];
	#output: Message[] = [];
	#savedPrefix: number[] = [0];
	#changedPrefix: number[] = [0];
	#roots: readonly string[] | undefined;
	constructor(map: ToolCallIdMap, allocate: () => string) {
		this.#map = map;
		this.#allocate = allocate;
	}

	transform(messages: Message[], roots: readonly string[]): CanonicalizedProviderMessages {
		if (this.#roots !== roots) {
			this.#roots = roots;
			this.#relativizer = createPathRelativizer(roots);
		}

		let common = 0;
		const commonLimit = Math.min(messages.length, this.#source.length);
		while (common < commonLimit && messages[common] === this.#source[common]) common += 1;

		if (common === messages.length && common === this.#source.length) {
			return {
				messages: this.#changedPrefix[common] === 0 ? messages : this.#output,
				bytesSaved: this.#savedPrefix[common] ?? 0,
			};
		}

		const output = this.#output.slice(0, common);
		const savedPrefix = this.#savedPrefix.slice(0, common + 1);
		const changedPrefix = this.#changedPrefix.slice(0, common + 1);
		const relativizer = this.#relativizer;
		if (!relativizer) throw new Error("Provider context canonicalizer has no path relativizer");

		for (let i = common; i < messages.length; i++) {
			const source = messages[i]!;
			const canonical = canonicalizeToolCallIdsInMessage(source, this.#map, this.#allocate);
			const relativized = relativizer.transform(canonical);
			output.push(relativized.message);
			savedPrefix.push((savedPrefix.at(-1) ?? 0) + relativized.bytesSaved);
			changedPrefix.push((changedPrefix.at(-1) ?? 0) + (relativized.message === source ? 0 : 1));
		}

		this.#source = messages;
		this.#output = output;
		this.#savedPrefix = savedPrefix;
		this.#changedPrefix = changedPrefix;
		return {
			messages: changedPrefix.at(-1) === 0 ? messages : output,
			bytesSaved: savedPrefix.at(-1) ?? 0,
		};
	}
}
