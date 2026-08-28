/** What a secret placeholder looks like, defined once. A placeholder is the token that stands in for a secret in everything the model sees. */
import * as crypto from "node:crypto";
import { isWellFormedUtf16 } from "@veyyon/utils/string-length";

/** Prefix reserved for unnamed value-derived placeholders. Names must start with a letter. */
export const VALUE_PLACEHOLDER_PREFIX = "0";

/** HMAC hex retained in a value placeholder. Ninety-six bits makes accidental collision negligible. */
export const VALUE_PLACEHOLDER_HEX_LENGTH = 24;

/** Complete value-placeholder body width, including its reserved numeric prefix. */
export const VALUE_PLACEHOLDER_BODY_LENGTH = VALUE_PLACEHOLDER_PREFIX.length + VALUE_PLACEHOLDER_HEX_LENGTH;

/** Shortest vault name. Kept at five for the existing readable-name contract. */
export const MIN_SECRET_NAME_LENGTH = 5;

/** Longest vault name. Long enough to be descriptive, short enough to stay readable inline. */
export const MAX_SECRET_NAME_LENGTH = 64;

/** Characters a name may contain: uppercase, digits, underscore. Deliberately narrow. The name goes inside `#...#` in text the model reads and writes, so */
const NAME_RE = new RegExp(`^[A-Z][A-Z0-9_]{${MIN_SECRET_NAME_LENGTH - 1},${MAX_SECRET_NAME_LENGTH - 1}}$`);

/** Body of an unnamed value placeholder: starts with a digit, which a name may never do. */
const VALUE_BODY_RE = new RegExp(`^${VALUE_PLACEHOLDER_PREFIX}[A-F0-9]{${VALUE_PLACEHOLDER_HEX_LENGTH}}$`);

/** Matches either placeholder form. One expression for both, because deobfuscation walks text once and looks each token up in */
export const PLACEHOLDER_RE = new RegExp(`#[A-Z0-9_]{4,${MAX_SECRET_NAME_LENGTH}}#`, "g");

/** Matches a placeholder cut off by the end of a streamed chunk, anchored at the end. A provider streams text in arbitrary pieces, so a chunk can end mid-token: `...Bearer #GITHUB` */
export const PENDING_PLACEHOLDER_RE = new RegExp(`#[A-Z0-9_]{0,${MAX_SECRET_NAME_LENGTH}}$`);

/** Build a stable opaque placeholder for an unnamed secret. HMAC rather than a bare digest matters: a provider that sees the token cannot hash a */
export function buildValuePlaceholder(value: string, key: Uint8Array): string {
	if (!isWellFormedUtf16(value)) {
		throw new Error("Refusing to derive a secret placeholder from ill-formed UTF-16.");
	}
	const digest = crypto.createHmac("sha256", key).update(value, "utf8").digest("hex").toUpperCase();
	return `#${VALUE_PLACEHOLDER_PREFIX}${digest.slice(0, VALUE_PLACEHOLDER_HEX_LENGTH)}#`;
}

/** Build the placeholder for a named vault entry. */
export function buildNamePlaceholder(name: string): string {
	return `#${name}#`;
}

/** The name inside a placeholder, or nothing when it carries none. The inverse of {@link buildNamePlaceholder}, and the ONE place that decides whether a live */
export function placeholderSecretName(placeholder: string): string | undefined {
	if (!placeholder.startsWith("#") || !placeholder.endsWith("#")) return undefined;
	const body = placeholder.slice(1, -1);
	return isValidSecretName(body) ? body : undefined;
}

/** Whether a string is a usable vault name. */
export function isValidSecretName(name: string): boolean {
	if (!NAME_RE.test(name)) return false;
	// Structurally unreachable because value placeholders start with a digit and names with a letter.
	if (VALUE_BODY_RE.test(name)) return false;
	return true;
}

/** Whether a complete token has one of the two forms that can carry expansion rights. */
export function isSecretPlaceholder(value: string): boolean {
	if (!value.startsWith("#") || !value.endsWith("#")) return false;
	const body = value.slice(1, -1);
	return NAME_RE.test(body) || VALUE_BODY_RE.test(body);
}

/** One sentence saying why a name was refused, with the rule spelled out. */
export function describeInvalidSecretName(name: string): string {
	return (
		`"${name}" is not a usable secret name. Use ${MIN_SECRET_NAME_LENGTH} to ${MAX_SECRET_NAME_LENGTH} ` +
		`characters, starting with a letter, containing only A-Z, 0-9 and underscore. ` +
		`The name appears inside #...# in text the model reads, so it has to be unambiguous there.`
	);
}

/** Fail if the name rules could ever admit something shaped like a value placeholder. Called from a test rather than at import time, because it is a statement about the */
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
