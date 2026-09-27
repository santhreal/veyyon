/**
 * The secret lease each request in flight was admitted under.
 *
 * A main-agent request pins the committed lease when its context is transformed, before the
 * first async extension hook. Every array, message and context derived from that request is
 * recorded against the same lease, so provider serialization redacts with the authority the
 * request started with even when a reload commits a newer lease while the request is in flight.
 * A request that arrives with no recorded lease uses the one the latest main request pinned.
 */

import type { AgentMessage } from "@veyyon/agent-core";
import type { Context, Message } from "@veyyon/ai";
import type { SecretRuntimeLease } from "../session/agent-session-types";
import type { SessionSecretRuntime } from "./session-runtime";

export class SecretRequestLeases {
	readonly #runtime: Pick<SessionSecretRuntime, "lease" | "acquire">;
	readonly #leaseByObject = new WeakMap<object, SecretRuntimeLease>();
	#mainRequest: SecretRuntimeLease;

	constructor(runtime: Pick<SessionSecretRuntime, "lease" | "acquire">) {
		this.#runtime = runtime;
		this.#mainRequest = runtime.lease;
	}

	/** The lease the latest main request pinned; the committed lease before the first one. */
	get mainRequest(): SecretRuntimeLease {
		return this.#mainRequest;
	}

	/** Pin the lease a new main request runs under and record it against `messages`. */
	async admit(messages: AgentMessage[]): Promise<SecretRuntimeLease> {
		const lease = await this.#runtime.acquire();
		this.#mainRequest = lease;
		this.bind(messages, lease);
		return lease;
	}

	/** Record `value`, and every object element when it is an array, as derived under `lease`. */
	bind(value: unknown, lease: SecretRuntimeLease): void {
		if (typeof value !== "object" || value === null) return;
		this.#leaseByObject.set(value, lease);
		if (!Array.isArray(value)) return;
		for (const item of value) {
			if (typeof item === "object" && item !== null) this.#leaseByObject.set(item, lease);
		}
	}

	/** The lease recorded for `context`, its message array, or the first of its messages that has one. */
	forContext(context: Context): SecretRuntimeLease | undefined {
		const direct = this.#leaseByObject.get(context) ?? this.#leaseByObject.get(context.messages);
		if (direct) return direct;
		for (const message of context.messages) {
			const lease = this.#leaseByObject.get(message);
			if (lease) return lease;
		}
		return undefined;
	}

	/** The lease a provider request for `context` redacts with. */
	requestLease(context: Context): SecretRuntimeLease {
		return this.forContext(context) ?? this.#mainRequest;
	}

	/** Redact `converted`, the provider messages built from `source`, under the lease `source` was admitted with. */
	redactMessages(source: AgentMessage[], converted: Message[]): Message[] {
		const lease = this.#leaseByObject.get(source) ?? this.#mainRequest;
		const redacted = lease.obfuscateMessages(converted);
		this.bind(converted, lease);
		this.bind(redacted, lease);
		return redacted;
	}

	/** Redact a provider context under `requestLease` when given, else the lease recorded for it. */
	redactContext(context: Context, requestLease?: SecretRuntimeLease): Context {
		const lease = requestLease ?? this.requestLease(context);
		const redacted = lease.obfuscateContext(context);
		this.bind(context, lease);
		this.bind(redacted, lease);
		this.bind(redacted.messages, lease);
		return redacted;
	}
}
