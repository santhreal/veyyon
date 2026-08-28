/** The length rules that decide whether a secret can be protected, and the one place they are defined. */

/** Shortest plain secret that `obfuscate` mode will accept. Below this, a reversible placeholder would replace so much incidental text that the */
export const MIN_OBFUSCATABLE_LENGTH = 8;

/** Shortest environment-variable value that the name-pattern heuristic will treat as a secret. */
export const MIN_AUTODETECTED_ENV_VALUE_LENGTH = 8;

/** Why a secret entry could not be protected. */
export type SecretRejectionReason =
	/** A plain `obfuscate` entry shorter than {@link MIN_OBFUSCATABLE_LENGTH}. */
	| "too-short-to-obfuscate"
	/** A `regex` entry whose pattern would not compile. */
	| "invalid-pattern";

/** A declared secret the obfuscator refused, carried out to the caller rather than dropped. */
export interface SecretRejection {
	reason: SecretRejectionReason;
	/** Position of the entry in the list handed to the obfuscator, for a precise message. */
	index: number;
	/** Length of the offending value. Never the value itself. */
	length: number;
	/** For `invalid-pattern`, the compiler's complaint. Patterns are not secret. */
	detail?: string;
}

/** One sentence naming what was refused and what to do about it. Single owner so the wording is identical wherever a rejection surfaces: the startup */
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

/** Whether a plain value is long enough for reversible obfuscation. The predicate rather than a bare comparison, so no call site re-implements the rule */
export function canObfuscatePlainValue(value: string): boolean {
	return secretCharacterLength(value) >= MIN_OBFUSCATABLE_LENGTH;
}
