/**
 * Provider wire shaping: the per-request transform every request of a session runs after
 * `convertToLlm` and before the provider call.
 *
 * This is a session collaborator with no host. It holds the session-local tool-call id map, the root
 * outbound paths render relative to, and the bytes the shaping left out of every request so far. The
 * main turn, side requests, compaction and advisors all send through {@link ProviderWire.transform},
 * so they share one id map and prior history serializes byte-identically, which keeps the provider's
 * prompt cache.
 *
 * A request passes through, in order:
 *
 * 1. Tool-call id canonicalization to `tc_<n>` handles and path relativization under the active cwd
 *    ({@link ProviderContextCanonicalizer}). On resume the id map rebuilds from the stored history,
 *    walked in order.
 * 2. The thought-signature and thinking retention settings, read per request.
 * 3. The lost-payload notice for a blob the blob store no longer has.
 * 4. The image policy of the model serving the request.
 * 5. The caller's transform when one is configured, secret obfuscation otherwise.
 */
import type { Context, Model } from "@veyyon/ai";
import { elidedSignatureBytes, signaturePolicy } from "@veyyon/ai/providers/google-thought-signatures";
import type { Settings } from "../../config/settings";
import type { SecretRuntimeLease } from "../agent-session-types";
import { replaceLostBlobPayloads } from "../messages";
import { ProviderContextCanonicalizer } from "../provider-context-canonicalizer";
import { applyProviderImagePolicy } from "../provider-image-budget";
import { normalizeRoots } from "../relativize-paths";

/** A per-request provider context transform. */
export type ProviderContextTransform = (
	context: Context,
	model: Model,
	runtime?: SecretRuntimeLease,
) => Context | Promise<Context>;

/** How a session's wire starts. */
export interface ProviderWireOptions {
	/** Session settings, read on every request so a changed retention window applies on the next turn. */
	readonly settings: Settings;
	/** Working directory whose paths render relative. */
	readonly cwd: string;
	/** The caller's transform. When set, it runs last instead of secret obfuscation. */
	readonly upstream: ProviderContextTransform | undefined;
	/** Secret obfuscation, run last when no caller transform is configured. */
	readonly secrets: ProviderWireSecrets;
}

/** The secret obfuscation slice of the session. `SessionSecrets` satisfies this. */
export interface ProviderWireSecrets {
	/** Obfuscate `context` with `runtime`, or with the session's own runtime when it is `undefined`. */
	obfuscateContext(context: Context, runtime: SecretRuntimeLease | undefined): Context;
}

export class ProviderWire {
	readonly #settings: Settings;
	readonly #upstream: ProviderContextTransform | undefined;
	readonly #secrets: ProviderWireSecrets;
	readonly #canonicalizer: ProviderContextCanonicalizer;
	#toolCallIds = 0;
	/**
	 * Only the active cwd is a root. Accumulating earlier cwds would render paths from different
	 * directories to the same relative path, and distinct absolute paths would become
	 * indistinguishable.
	 */
	#roots: readonly string[];
	#pathBytesSaved = 0;
	#thoughtSignatureBytesSaved = 0;

	/** The transform, bound so every caller shares this wire's state. */
	readonly transform: ProviderContextTransform = (context, model, runtime) => this.#shape(context, model, runtime);

	constructor(options: ProviderWireOptions) {
		this.#settings = options.settings;
		this.#upstream = options.upstream;
		this.#secrets = options.secrets;
		this.#roots = normalizeRoots(options.cwd);
		this.#canonicalizer = new ProviderContextCanonicalizer(new Map(), () => {
			this.#toolCallIds += 1;
			return `tc_${this.#toolCallIds}`;
		});
	}

	/** The roots in effect, for {@link ProviderWire.restoreRoots} to put back. */
	get roots(): readonly string[] {
		return this.#roots;
	}

	/** Render paths under `cwd` relative from the next request on. */
	rootAt(cwd: string): void {
		this.#roots = normalizeRoots(cwd);
	}

	/** Put back roots {@link ProviderWire.roots} returned, after a directory change that failed. */
	restoreRoots(roots: readonly string[]): void {
		this.#roots = roots;
	}

	/** Cumulative outbound bytes path relativization left out, across every request. */
	get pathBytesSaved(): number {
		return this.#pathBytesSaved;
	}

	/** Cumulative outbound characters the thought-signature retention window left out, across every request. */
	get thoughtSignatureBytesSaved(): number {
		return this.#thoughtSignatureBytesSaved;
	}

	#shape(context: Context, model: Model, runtime: SecretRuntimeLease | undefined): Context | Promise<Context> {
		const canonicalized = this.#canonicalizer.transform(context.messages, this.#roots);
		this.#pathBytesSaved += canonicalized.bytesSaved;
		const messages = canonicalized.messages;
		const thoughtSignatureRetention = this.#settings.get("context.thoughtSignatureRetention");
		const thoughtSignatureMaxLength = this.#settings.get("context.thoughtSignatureMaxLength");
		const thinkingRetention = this.#settings.get("context.thinkingRetention");
		// Both signature rules resolve through one policy, so the bytes counted here are the bytes
		// the request leaves out.
		this.#thoughtSignatureBytesSaved += elidedSignatureBytes(
			messages,
			signaturePolicy(messages, { thoughtSignatureRetention, thoughtSignatureMaxLength }),
			message => message.provider === model.provider && message.model === model.id,
		);
		const next =
			messages === context.messages &&
			thoughtSignatureRetention === context.thoughtSignatureRetention &&
			thoughtSignatureMaxLength === context.thoughtSignatureMaxLength &&
			thinkingRetention === context.thinkingRetention
				? context
				: {
						...context,
						messages,
						thoughtSignatureRetention,
						thoughtSignatureMaxLength,
						thinkingRetention,
					};
		// A payload the blob store no longer has is still a reference after the load restored every
		// payload it could. An image block whose data is a hash is not base64, so the provider rejects
		// the request, and every later turn of the session the same way. The transcript keeps the
		// reference, so restoring the blobs directory restores the payload; the request states the
		// loss instead of sending the hash.
		const recovered = replaceLostBlobPayloads(next.messages);
		const carried = recovered === next.messages ? next : { ...next, messages: recovered };
		// The model serving this request sets which images it can read. The main turn, a side
		// request, compaction and an advisor each dispatch their own model, and this is the one
		// point every request passes with its model, so the whole image policy resolves here.
		const shaped = applyProviderImagePolicy(carried, model, {
			blockImages: Boolean(this.#settings.get("images.blockImages")),
		});
		if (this.#upstream) return this.#upstream(shaped, model, runtime);
		return this.#secrets.obfuscateContext(shaped, runtime);
	}
}
