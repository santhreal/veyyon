/**
 * The relay from an auth store's `credential_disabled` events to the extension runner of the session
 * that store serves.
 */

import type { CredentialDisabledEvent } from "@veyyon/ai";
import type { AuthStorage } from "@veyyon/ai/auth-storage";
import { errorMessage, logger } from "@veyyon/utils";
import type { ExtensionRunner } from "../extensibility/extensions";

function deliverCredentialDisabled(runner: ExtensionRunner, event: CredentialDisabledEvent, failure: string): void {
	void runner.emitCredentialDisabled(event).catch(error => {
		logger.warn(failure, { error: errorMessage(error) });
	});
}

/**
 * Delivers an auth store's `credential_disabled` events to the session's extension runner.
 *
 * Subscribed before any `getApiKey()` call, so a startup model probe cannot raise an event unseen. An
 * embedder's constructor handler makes the store's listener set non-empty from construction, which
 * defeats the store's own no-listener buffer, so events raised before the runner exists are held here
 * and delivered when it attaches. Delivery is not awaited: handler errors are isolated onto the runner's
 * `onError` listeners, and a failure of the runner itself is logged instead of reaching the
 * process-level rejection handler and ending the session over a notification.
 */
export class CredentialDisabledRelay {
	#runner: ExtensionRunner | undefined;
	readonly #pending: CredentialDisabledEvent[] = [];
	readonly #unsubscribe: () => void;

	constructor(authStorage: AuthStorage) {
		this.#unsubscribe = authStorage.onCredentialDisabled(event => {
			if (this.#runner) {
				deliverCredentialDisabled(
					this.#runner,
					event,
					"Failed to deliver a credential-disabled event to extensions",
				);
			} else {
				this.#pending.push(event);
			}
		});
	}

	/** Deliver the held events to `runner`, and every later one. */
	attach(runner: ExtensionRunner): void {
		this.#runner = runner;
		for (const event of this.#pending.splice(0)) {
			deliverCredentialDisabled(
				runner,
				event,
				"Failed to deliver a buffered credential-disabled event to extensions",
			);
		}
	}

	/** Stop listening. Idempotent. */
	dispose(): void {
		this.#unsubscribe();
	}
}
