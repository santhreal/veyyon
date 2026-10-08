/**
 * The Claude device id: a SHA-256 of the install id, and of the account id when one is known, under a
 * fixed hash domain. Both the Anthropic Messages client and a session building request metadata derive
 * it, so it is defined apart from the client in `./anthropic`.
 */
import * as nodeCrypto from "node:crypto";

// Hash-domain constants are frozen at their pre-rebrand values: they are
// key-derivation inputs, and changing them would rotate every derived Claude
// device id in the wild.
const CLAUDE_DEVICE_ID_INSTALL_HASH_DOMAIN = "veyyon-claude-device-id-v1:";
const CLAUDE_DEVICE_ID_ACCOUNT_HASH_DOMAIN = "veyyon-claude-device-id-v2";

export function deriveClaudeDeviceId(installId: string, accountId?: string): string {
	const hash = nodeCrypto.createHash("sha256");
	if (accountId && accountId.length > 0) {
		return hash
			.update(CLAUDE_DEVICE_ID_ACCOUNT_HASH_DOMAIN)
			.update("\0")
			.update(installId)
			.update("\0")
			.update(accountId)
			.digest("hex");
	}
	return hash.update(CLAUDE_DEVICE_ID_INSTALL_HASH_DOMAIN).update(installId).digest("hex");
}
