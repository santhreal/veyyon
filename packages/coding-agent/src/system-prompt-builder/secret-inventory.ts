/**
 * The AVAILABLE SECRETS section's text, rendered from the live secret runtime.
 *
 * WHY THIS EXISTS. The vault is scoped to a profile, a project or the machine, so it
 * OUTLIVES a session; the knowledge that it holds anything did not. The only place the
 * model was ever told a credential exists was the turn `/secret add` ran in, as a notice
 * in that turn's history. Start a new session against the same project and `GITHUB_TOKEN`
 * is still live, still obfuscating provider traffic, and completely invisible: the prompt
 * carried the generic `#XXXX#` redaction explainer and nothing that names a single
 * spendable credential. The model cannot use what it does not know is there, and asking
 * the user for a token they already stored is the worst possible outcome — it puts the
 * secret in the transcript, which is what the vault exists to prevent.
 *
 * WHY IT IS A SECTION AND NOT A NOTICE. A notice is a fact in history, so it is only true
 * for the session that saw it and stays in history after it stops being true. A runtime
 * section is rebuilt from the live obfuscator every time the base prompt is assembled, so
 * revocation and expiry need no plumbing of their own: a name that the obfuscator's
 * `namedSecretNames()` no longer returns simply stops being rendered on the next build,
 * and `refreshSecrets()` forces one.
 *
 * THE READ MUST BE LATE. Callers pass the names they read AT BUILD TIME.
 * `namedSecretNames()` expires stale entries as part of answering, so reading it while
 * assembling the prompt is what makes a credential that lapsed mid-session disappear from
 * the prompt. A list snapshotted when the runtime was constructed would go stale in exactly
 * the case this feature exists for.
 *
 * ORDER IS NOT DECIDED HERE. `namedSecretNames()` returns sorted names and its own suite
 * pins that. Sorting again would be a second ordering rule that nothing compares against
 * the first, and the reason the order matters at all is byte-stability: this section sits
 * in the provider's cached prompt, and bytes that shuffle between refreshes throw the cache
 * away for no gain.
 */
import { prompt } from "@veyyon/utils";
import { sessionPrompts } from "../prompts/session/rows";

/**
 * The section body for `names`, or `undefined` when there is nothing to advertise.
 *
 * `undefined` for both "protection is off" (the caller has no obfuscator, so it passes
 * nothing) and "the vault is readable but empty". The section is registered `optional`, so
 * `undefined` means it is not emitted at all — no banner, no heading. That distinction is
 * the whole reason this returns `string | undefined` rather than a possibly-empty string:
 * an `AVAILABLE SECRETS` banner over nothing tells the model a capability exists and then
 * declines to say what it is, which is strictly worse than silence.
 *
 * NEVER TAKES A VALUE. The parameter is names, and the template interpolates names, so
 * there is no path by which a credential reaches the prompt even if a caller were careless.
 */
export function renderSecretInventory(names: readonly string[] | undefined): string | undefined {
	if (names === undefined || names.length === 0) return undefined;
	return prompt.render(sessionPrompts["session/secret-inventory"].text, { names }).trim();
}
