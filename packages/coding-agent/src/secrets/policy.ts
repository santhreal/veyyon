/**
 * The length rules that decide whether a secret can be protected, and the one place
 * they are defined.
 *
 * TWO RULES, NOT ONE, EVEN THOUGH BOTH ARE 8 TODAY. The literal `8` used to appear in
 * three places (`obfuscator.ts` twice, `index.ts` once) answering two different
 * questions, so changing one silently left the others behind:
 *
 *   - {@link MIN_AUTODETECTED_ENV_VALUE_LENGTH} answers "does this environment
 *     variable look like it holds a secret at all". It guards a HEURISTIC. Nobody
 *     declared `PATH_TOKEN=abc` to be sensitive; the collector guessed from the name,
 *     and a short value is evidence the guess is wrong.
 *   - {@link MIN_OBFUSCATABLE_LENGTH} answers "is this string long enough that
 *     replacing every occurrence of it will not shred ordinary prose". It guards a
 *     SUBSTITUTION. A three-character secret like `esp` would blank out fragments of
 *     unrelated words in every message.
 *
 * They are named apart so that raising the heuristic (fewer false positives from the
 * environment) cannot quietly change what the obfuscator refuses to protect, and so a
 * reader looking at either call site learns which question is being asked.
 *
 * WHY A DECLARED SECRET UNDER THE FLOOR IS AN ERROR RATHER THAN A SKIP. The obfuscator
 * used to `continue` past a short entry: no mapping, no placeholder, and the value
 * therefore reached the provider verbatim. The operator had written the value into
 * `secrets.yml` and been told nothing, so the feature reported success and did the one
 * thing it exists to prevent. Security controls fail closed, so a declared entry that
 * cannot be protected is refused at the boundary that accepts it, with the remedy in
 * the message. `mode: replace` has no floor because it is one-way and does not need a
 * reversible placeholder, so it is always the answer for a genuinely short secret.
 */

/**
 * Shortest plain secret that `obfuscate` mode will accept.
 *
 * Below this, a reversible placeholder would replace so much incidental text that the
 * transcript becomes unreadable. Use `mode: replace` instead, which is one-way and
 * therefore has no floor.
 */
export const MIN_OBFUSCATABLE_LENGTH = 8;

/**
 * Shortest environment-variable value that the name-pattern heuristic will treat as a
 * secret.
 *
 * Separate from {@link MIN_OBFUSCATABLE_LENGTH} on purpose: this one decides whether to
 * BELIEVE a guess, not whether a declared secret can be protected. See the module note.
 */
export const MIN_AUTODETECTED_ENV_VALUE_LENGTH = 8;

/** Why a secret entry could not be protected. */
export type SecretRejectionReason =
	/** A plain `obfuscate` entry shorter than {@link MIN_OBFUSCATABLE_LENGTH}. */
	| "too-short-to-obfuscate"
	/** A `regex` entry whose pattern would not compile. */
	| "invalid-pattern";

/**
 * A declared secret the obfuscator refused, carried out to the caller rather than
 * dropped.
 *
 * Holds no secret material: `length` and the entry's position stand in for the value so
 * a rejection can be logged, rendered, or asserted without becoming the leak it is
 * reporting.
 */
export interface SecretRejection {
	reason: SecretRejectionReason;
	/** Position of the entry in the list handed to the obfuscator, for a precise message. */
	index: number;
	/** Length of the offending value. Never the value itself. */
	length: number;
	/** For `invalid-pattern`, the compiler's complaint. Patterns are not secret. */
	detail?: string;
}

/**
 * One sentence naming what was refused and what to do about it.
 *
 * Single owner so the wording is identical wherever a rejection surfaces: the startup
 * warning, a `/secret` refusal, and the loader's validation error. Error messages carry
 * the fix, not just the complaint.
 */
export function describeSecretRejection(rejection: SecretRejection): string {
	switch (rejection.reason) {
		case "too-short-to-obfuscate":
			return (
				`secret entry ${rejection.index} is ${rejection.length} characters, ` +
				`under the ${MIN_OBFUSCATABLE_LENGTH}-character minimum for "obfuscate" mode. ` +
				`Short values would replace fragments of ordinary text. ` +
				`Use "mode: replace" for this entry, which is one-way and has no minimum, or remove it.`
			);
		case "invalid-pattern":
			return (
				`secret entry ${rejection.index} is a regex that does not compile` +
				`${rejection.detail ? `: ${rejection.detail}` : ""}. ` +
				`Fix the pattern or remove the entry. An uncompilable pattern protects nothing.`
			);
	}
}

/** Count user-visible Unicode code points without allocating an intermediate array. */
export function secretCharacterLength(value: string): number {
	let characterLength = 0;
	for (const _character of value) characterLength++;
	return characterLength;
}

/**
 * Whether a plain value is long enough for reversible obfuscation.
 *
 * The predicate rather than a bare comparison, so no call site re-implements the rule
 * with its own inline `< 8`, which is how the three copies happened.
 */
export function canObfuscatePlainValue(value: string): boolean {
	return secretCharacterLength(value) >= MIN_OBFUSCATABLE_LENGTH;
}
