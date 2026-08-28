export const MIN_OBFUSCATABLE_LENGTH = 8;

export const MIN_AUTODETECTED_ENV_VALUE_LENGTH = 8;

export type SecretRejectionReason = "too-short-to-obfuscate" | "invalid-pattern";

export interface SecretRejection {
	reason: SecretRejectionReason;
	index: number;
	length: number;
	detail?: string;
}

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

export function secretCharacterLength(value: string): number {
	let characterLength = 0;
	for (const _character of value) characterLength++;
	return characterLength;
}

export function canObfuscatePlainValue(value: string): boolean {
	return secretCharacterLength(value) >= MIN_OBFUSCATABLE_LENGTH;
}
