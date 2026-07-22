/**
 * The one owner of "get the text out of a fast-xml-parser node" for the markit
 * Office converters (xlsx, pptx, epub).
 *
 * fast-xml-parser number-parses tag text by default, and wraps an element that
 * also carries attributes as a `{ "#text": ... }` node instead of a bare value.
 * Both facts trip up the obvious hand-rolled extraction, and each converter had
 * grown its own slightly-different copy. Two coercions have to be right:
 *
 *   - A value like the cell/run text "0", "1984", or "true" arrives as a JS
 *     number or boolean, not a string, so it must be stringified rather than
 *     dropped (the `typeof === "string"`-only path silently lost it).
 *   - A `#text` of the number `0` (a "0" run/cell that also has an attribute
 *     such as `xml:space="preserve"`) is a real value. It must be read with a
 *     null check; `node["#text"] || ""` discards a legitimate 0, turning the
 *     text "0" into "".
 */

/** A text-bearing node as fast-xml-parser produces it: a bare scalar, or a `{ "#text" }` node when the element also has attributes. */
export type XmlTextNode = string | number | boolean | { "#text"?: unknown } | null | undefined;

/**
 * Text of a fast-xml-parser text node, or `""` when the node holds no text.
 *
 * Handles the number/boolean coercion and the `{ "#text" }` attribute-node
 * shape, and keeps a `#text` of the number `0`. Does not recurse into arrays:
 * a converter that can see a repeated element (EPUB's `dc:creator`) selects the
 * element first, then calls this on the scalar.
 *
 * The EPUB metadata reader needs to distinguish "absent" (skip the line) from
 * "empty", so it keeps a thin `getText` wrapper that returns `undefined` for a
 * missing value and delegates the scalar coercion here.
 */
export function xmlNodeText(node: XmlTextNode): string {
	if (node == null) return "";
	if (typeof node === "string") return node;
	if (typeof node === "number" || typeof node === "boolean") return String(node);
	const text = node["#text"];
	if (text == null) return "";
	return typeof text === "string" ? text : String(text);
}
