/**
 * What a secret placeholder looks like, defined once.
 *
 * A placeholder is the token that stands in for a secret in everything the model sees.
 * There are two kinds, and they have to share one definition because a collision between
 * them would hand the model one token meaning two different credentials.
 *
 *   - VALUE form, `#0A1B2C...#`: an HMAC-derived body for an unnamed secret. The HMAC key
 *     stays local, so the token is stable across restarts without giving the provider an
 *     offline dictionary oracle for low-entropy credentials.
 *   - NAME form, `#GITHUB_TOKEN#`: the vault entry's own name. The model can tell which
 *     credential belongs in which command, which is the difference between redaction and a
 *     vault the agent can use on purpose. Stable across sessions, because it is derived
 *     from the name rather than from load order.
 *
 * THE COLLISION RULE IS STRUCTURAL. Value placeholders begin with a digit and vault names
 * begin with a letter. {@link assertNameRuleCoversValueForm} fails loudly if those rules
 * ever stop being disjoint.
 */
import * as crypto from "node:crypto";

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

/**
 * Characters a name may contain: uppercase, digits, underscore.
 *
 * Deliberately narrow. The name goes inside `#...#` in text the model reads and writes, so
 * anything that could be confused with surrounding punctuation, or that would need quoting
 * in a shell, is excluded. It also has to start with a letter, so a name never reads as a
 * number.
 */
const NAME_RE = new RegExp(`^[A-Z][A-Z0-9_]{${MIN_SECRET_NAME_LENGTH - 1},${MAX_SECRET_NAME_LENGTH - 1}}$`);

/** Body of an unnamed value placeholder: starts with a digit, which a name may never do. */
const VALUE_BODY_RE = new RegExp(`^${VALUE_PLACEHOLDER_PREFIX}[A-F0-9]{${VALUE_PLACEHOLDER_HEX_LENGTH}}$`);

/**
 * Matches either placeholder form.
 *
 * One expression for both, because deobfuscation walks text once and looks each token up in
 * a single map. A token that is not in the map is left exactly as it was, so a literal
 * `#HELLO#` an operator typed survives untouched.
 */
export const PLACEHOLDER_RE = new RegExp(`#[A-Z0-9_]{4,${MAX_SECRET_NAME_LENGTH}}#`, "g");

/**
 * Matches a placeholder cut off by the end of a streamed chunk, anchored at the end.
 *
 * A provider streams text in arbitrary pieces, so a chunk can end mid-token: `...Bearer #GITHUB`
 * with the rest arriving next. Emitting that to the display would show a mangled fragment and
 * the completed token would never be substituted as a unit, so the caller holds back everything
 * from the match onwards until the next chunk closes it.
 *
 * DERIVED FROM THE SAME CHARSET AND WIDTH as a real placeholder, and living here rather than
 * inline at the call site, because it WAS inline: `agent-session.ts` carried its own
 * `/#[A-Z0-9]{0,4}$/`, which encoded a four-character body with no underscore. That was correct
 * for index placeholders and silently wrong the moment names arrived, since `#GITHUB_TOK` is
 * neither. Two definitions of one shape, and only one of them got updated. Not global: the
 * caller needs `match.index`.
 */
export const PENDING_PLACEHOLDER_RE = new RegExp(`#[A-Z0-9_]{0,${MAX_SECRET_NAME_LENGTH}}$`);

/**
 * Build a stable opaque placeholder for an unnamed secret.
 *
 * HMAC rather than a bare digest matters: a provider that sees the token cannot hash a
 * wordlist and recover a short credential. Callers reject the astronomically unlikely
 * event that two values produce the same retained body instead of overwriting a mapping.
 */
function isWellFormedUtf16(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			if (index + 1 >= value.length) return false;
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index++;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

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

/**
 * Fail if the name rules could ever admit something shaped like a value placeholder.
 *
 * Called from a test rather than at import time, because it is a statement about the
 * constants in this file and not about any particular run.
 */
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
