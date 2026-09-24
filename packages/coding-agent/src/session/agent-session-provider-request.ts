/**
 * Shaping of the request the session sends to a provider: secret redaction of
 * the payload, the Anthropic `metadata` block, and the tool-order check that
 * keeps a reordered tool list from re-encoding the prompt prefix.
 */

import type { AuthStorage } from "@veyyon/ai/auth-storage";
import * as AIError from "@veyyon/ai/error";
import { deriveClaudeDeviceId } from "@veyyon/ai/providers/anthropic";
import { getInstallId } from "@veyyon/utils";
import { isProviderPayloadOversize, transformProviderPayload } from "../provider-boundary";
import type { SecretObfuscator } from "../secrets/obfuscator";

/**
 * Whether `next` is the same tool set as `current` in a different order.
 *
 * Order-only differences are the case worth catching: they cost a full prefix
 * re-encode and buy nothing, because the model selects a tool by name. A genuine
 * set change (a tool added, removed, or swapped) is NOT a permutation and must
 * reach the provider in the order the caller asked for.
 */
export function isToolOrderPermutation(current: readonly string[], next: readonly string[]): boolean {
	if (current.length !== next.length || current.length === 0) return false;
	let sameOrder = true;
	for (let index = 0; index < current.length; index++) {
		if (current[index] !== next[index]) {
			sameOrder = false;
			break;
		}
	}
	if (sameOrder) return false;
	const currentSet = new Set(current);
	if (currentSet.size !== current.length) return false;
	for (const name of next) {
		if (!currentSet.delete(name)) return false;
	}
	return currentSet.size === 0;
}

/**
 * Build the per-request `metadata` payload for the Anthropic provider, shaped
 * like real Claude Code's `getAPIMetadata` output (`{ session_id, account_uuid,
 * device_id }`) so the backend buckets requests under one session and attributes
 * them to the authenticated OAuth account when available. Resolved at request
 * time so token refreshes and login/logout transitions don't strand a stale
 * account UUID in memory. `account_uuid` and `device_id` are omitted for
 * non-Anthropic providers to avoid leaking the user's Claude identity to
 * third-party APIs (including Anthropic-format-compatible proxies such as
 * cloudflare-ai-gateway or gitlab-duo).
 *
 * `provider` is the target provider string (e.g. `"anthropic"`) and gates the
 * `account_uuid` and `device_id` lookups — only `"anthropic"` requests carry them.
 *
 * `sessionId` is forwarded to the auth-storage session-sticky lookup so that
 * multi-credential setups attribute to the same OAuth account used for the
 * actual API request rather than always picking the first credential.
 *
 * `authStorage` is treated as optional so test fixtures that stub `modelRegistry`
 * without a real storage layer still work; the resolver simply skips the lookup
 * and emits `{ session_id }` alone, matching the no-OAuth-credential path.
 */
export function buildSessionMetadata(
	sessionId: string,
	provider: string,
	authStorage: AuthStorage | undefined,
): Record<string, unknown> {
	const userId: Record<string, string> = { session_id: sessionId };
	// Only look up account_uuid when the request is going to Anthropic. Injecting
	// a Claude OAuth account_uuid into requests bound for other providers (including
	// Anthropic-format-compatible proxies like cloudflare-ai-gateway or gitlab-duo)
	// would leak the user's Anthropic identity to unrelated third-party APIs.
	if (provider === "anthropic") {
		const accountUuid = authStorage?.getOAuthAccountId("anthropic", sessionId);
		if (typeof accountUuid === "string" && accountUuid.length > 0) {
			userId.account_uuid = accountUuid;
			// Claude Code's `device_id` is a stable 64-hex account-scoped install
			// identifier. Include both veyyon's persistent install id and the Claude
			// account UUID so two accounts on the same install do not share a device.
			userId.device_id = deriveClaudeDeviceId(getInstallId(), accountUuid);
		}
	}
	return { user_id: JSON.stringify(userId) };
}

/**
 * Redact every string in a provider payload, object keys included, after
 * mutable request hooks. The bounded shared walker rejects transformed-key
 * collisions and unsupported/cyclic payloads; the boundary converts every
 * walker failure into a fail-closed confidentiality error.
 *
 * A refusal the boundary attributes to payload SIZE carries the context-overflow
 * flag out of here. The scan runs ahead of the send, so an oversized turn is
 * refused locally before any provider sees it, and a session whose turn outgrew
 * the scan limits used to stop at a confidentiality error it could not act on:
 * the one mechanism that shrinks a turn is reached by classifying the failure as
 * an overflow, and it was never reached because nothing said this was one. The
 * flag is attached rather than matched on the message text so `classify` latches
 * it off the chain and every reader of the id — the retry ladder, the compaction
 * rescue, `isContextOverflow` — gives the same answer without a second predicate.
 */
export function obfuscateProviderPayload(value: unknown, obfuscator: SecretObfuscator | undefined): unknown {
	if (!obfuscator?.hasSecrets()) return value;
	try {
		return transformProviderPayload(value, text => obfuscator.obfuscate(text), "AgentSession provider payload", {
			safeFailureDetails: true,
		});
	} catch (error) {
		if (isProviderPayloadOversize(error) && error instanceof Error) {
			throw AIError.attach(error, AIError.create(AIError.Flag.ContextOverflow));
		}
		throw error;
	}
}
