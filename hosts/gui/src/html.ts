/**
 * The bytes a graphical host writes, and the two boundaries it validates on the way out.
 *
 * A view carries a tool's text, a program's captured screen and a target somebody typed. None of
 * the three is markup, so every one of them is escaped before it reaches an element: an element is
 * built from a tag, attributes and already-safe children, and the only way to produce a child is to
 * escape text or to build another element. The escaping, the control-sequence removal and the href
 * allowlist are the ones `@veyyon/tool-render/view-core` applies to every document host.
 */

import { escapeHtml } from "@veyyon/tool-render/view-core";

export { escapeHtml, safeHref, stripControlSequences } from "@veyyon/tool-render/view-core";

/** An attribute value, or `undefined` for an attribute the element does not carry. */
export type AttributeValue = string | number | undefined;

/**
 * One element with its attributes escaped and its children already safe.
 *
 * `undefined` drops the attribute rather than writing an empty one. A boolean is not a value here:
 * a bare `data-opens` reads back as the empty string, which is falsy, so a caller states a fact
 * either way as the string that says which, and the two HTML boolean attributes a card uses --
 * `disabled`, `checked` -- would state themselves the same way rather than by absence.
 */
export function element(tag: string, attributes: Readonly<Record<string, AttributeValue>>, children = ""): string {
	let open = tag;
	for (const [name, value] of Object.entries(attributes)) {
		if (value === undefined) continue;
		open += ` ${name}="${escapeHtml(String(value))}"`;
	}
	return `<${open}>${children}</${tag}>`;
}

/** A class attribute from the parts that are present, or `undefined` when none are. */
export function classes(...parts: readonly (string | undefined | false)[]): string | undefined {
	const present = parts.filter((part): part is string => typeof part === "string" && part !== "");
	return present.length === 0 ? undefined : present.join(" ");
}
