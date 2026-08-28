import * as crypto from "node:crypto";
import { isWellFormedUtf16 } from "@veyyon/utils/string-length";

export const VALUE_PLACEHOLDER_PREFIX = "0";

export const VALUE_PLACEHOLDER_HEX_LENGTH = 24;

export const VALUE_PLACEHOLDER_BODY_LENGTH = VALUE_PLACEHOLDER_PREFIX.length + VALUE_PLACEHOLDER_HEX_LENGTH;

export const MIN_SECRET_NAME_LENGTH = 5;

export const MAX_SECRET_NAME_LENGTH = 64;

const NAME_RE = new RegExp(`^[A-Z][A-Z0-9_]{${MIN_SECRET_NAME_LENGTH - 1},${MAX_SECRET_NAME_LENGTH - 1}}$`);

const VALUE_BODY_RE = new RegExp(`^${VALUE_PLACEHOLDER_PREFIX}[A-F0-9]{${VALUE_PLACEHOLDER_HEX_LENGTH}}$`);

export const PLACEHOLDER_RE = new RegExp(`#[A-Z0-9_]{4,${MAX_SECRET_NAME_LENGTH}}#`, "g");

export const PENDING_PLACEHOLDER_RE = new RegExp(`#[A-Z0-9_]{0,${MAX_SECRET_NAME_LENGTH}}$`);

export function buildValuePlaceholder(value: string, key: Uint8Array): string {
	if (!isWellFormedUtf16(value)) {
		throw new Error("Refusing to derive a secret placeholder from ill-formed UTF-16.");
	}
	const digest = crypto.createHmac("sha256", key).update(value, "utf8").digest("hex").toUpperCase();
	return `#${VALUE_PLACEHOLDER_PREFIX}${digest.slice(0, VALUE_PLACEHOLDER_HEX_LENGTH)}#`;
}

export function buildNamePlaceholder(name: string): string {
	return `#${name}#`;
}

export function placeholderSecretName(placeholder: string): string | undefined {
	if (!placeholder.startsWith("#") || !placeholder.endsWith("#")) return undefined;
	const body = placeholder.slice(1, -1);
	return isValidSecretName(body) ? body : undefined;
}

export function isValidSecretName(name: string): boolean {
	if (!NAME_RE.test(name)) return false;
	if (VALUE_BODY_RE.test(name)) return false;
	return true;
}

export function isSecretPlaceholder(value: string): boolean {
	if (!value.startsWith("#") || !value.endsWith("#")) return false;
	const body = value.slice(1, -1);
	return NAME_RE.test(body) || VALUE_BODY_RE.test(body);
}

export function describeInvalidSecretName(name: string): string {
	return (
		`"${name}" is not a usable secret name. Use ${MIN_SECRET_NAME_LENGTH} to ${MAX_SECRET_NAME_LENGTH} ` +
		`characters, starting with a letter, containing only A-Z, 0-9 and underscore. ` +
		`The name appears inside #...# in text the model reads, so it has to be unambiguous there.`
	);
}

export function assertNameRuleCoversValueForm(): void {
	const sample = `${VALUE_PLACEHOLDER_PREFIX}${"A".repeat(VALUE_PLACEHOLDER_HEX_LENGTH)}`;
	if (NAME_RE.test(sample)) {
		throw new Error(
			"Placeholder forms can collide: a vault name accepts the reserved numeric value-placeholder prefix.",
		);
	}
	if (MAX_SECRET_NAME_LENGTH < MIN_SECRET_NAME_LENGTH) {
		throw new Error("MAX_SECRET_NAME_LENGTH is below MIN_SECRET_NAME_LENGTH, so no name can be valid.");
	}
}
