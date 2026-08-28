/** The AVAILABLE SECRETS section's text, rendered from the live secret runtime. OUTLIVES a session; the knowledge that it holds anything did not. The only place the */
import { prompt } from "@veyyon/utils";
import { sessionPrompts } from "../prompts/session/rows";

/** The section body for `names`, or `undefined` when there is nothing to advertise. `undefined` for both "protection is off" (the caller has no obfuscator, so it passes */
export function renderSecretInventory(names: readonly string[] | undefined): string | undefined {
	if (names === undefined || names.length === 0) return undefined;
	return prompt.render(sessionPrompts["session/secret-inventory"].text, { names }).trim();
}
