/**
 * The bytes a graphical host writes, and the two boundaries it validates on the way out.
 *
 * A view carries a tool's text, a program's captured screen and a target somebody typed. None of
 * the three is markup, so every one of them is escaped here rather than at the call site: an
 * element is built from a tag, attributes and already-safe children, and the only way to produce a
 * child is to escape text or to build another element.
 */

/** Text as HTML character data, safe inside an element body and inside a double-quoted attribute. */
export function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/**
 * Every C0 and C1 control byte, which is what a captured screen is full of.
 *
 * A terminal replays the emphasis and the colour in a captured run; a document host has no screen
 * to replay them onto, so it keeps the text and drops the sequences, which is the branch
 * `ViewSpan.captured` states for a host that cannot replay them.
 */
const CONTROL_SEQUENCE =
	/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\-_]|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** A captured run as the words the program wrote, with every control sequence removed. */
export function stripControlSequences(text: string): string {
	return text.replace(CONTROL_SEQUENCE, "");
}

/**
 * The schemes a host will follow, and the reason this is a list rather than a check for `javascript:`.
 *
 * A URL in a view came from a tool, which got it from a model, a page or a file, so it is untrusted
 * input reaching an attribute a browser executes. Denying the schemes that are known to be dangerous
 * fails open on the next one; allowing the four that address a document fails closed on everything
 * else, including a scheme that does not exist yet.
 */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "file:"]);

/**
 * A target as an href, or `null` when the host will not follow it.
 *
 * A relative URL has no scheme and is resolved against whatever document the host mounts, so it is
 * answered against a base that is thrown away: the parse says whether the string addresses
 * something, and the original is what the attribute carries.
 */
export function safeHref(target: string): string | null {
	const trimmed = target.trim();
	if (trimmed === "") return null;
	let parsed: URL;
	try {
		parsed = new URL(trimmed, "https://veyyon.invalid/");
	} catch {
		return null;
	}
	if (!SAFE_SCHEMES.has(parsed.protocol)) return null;
	return trimmed;
}

/** An attribute value, or `undefined` for an attribute the element does not carry. */
export type AttributeValue = string | number | boolean | undefined;

/**
 * One element with its attributes escaped and its children already safe.
 *
 * `false` and `undefined` drop the attribute rather than writing an empty one, and `true` writes the
 * bare attribute HTML defines for a boolean, so a caller states presence without spelling a value.
 */
export function element(tag: string, attributes: Readonly<Record<string, AttributeValue>>, children = ""): string {
	let open = tag;
	for (const [name, value] of Object.entries(attributes)) {
		if (value === undefined || value === false) continue;
		if (value === true) {
			open += ` ${name}`;
			continue;
		}
		open += ` ${name}="${escapeHtml(String(value))}"`;
	}
	return `<${open}>${children}</${tag}>`;
}

/** A class attribute from the parts that are present, or `undefined` when none are. */
export function classes(...parts: readonly (string | undefined | false)[]): string | undefined {
	const present = parts.filter((part): part is string => typeof part === "string" && part !== "");
	return present.length === 0 ? undefined : present.join(" ");
}
