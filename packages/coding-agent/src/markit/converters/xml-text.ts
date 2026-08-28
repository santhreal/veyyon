/** The one owner of "get the text out of a fast-xml-parser node" for the markit Office converters (xlsx, pptx, epub). */

/** A text-bearing node as fast-xml-parser produces it: a bare scalar, or a `{ "#text" }` node when the element also has attributes. */
export type XmlTextNode = string | number | boolean | { "#text"?: unknown } | null | undefined;

/** Text of a fast-xml-parser text node, or `""` when the node holds no text. Handles the number/boolean coercion and the `{ "#text" }` attribute-node */
export function xmlNodeText(node: XmlTextNode): string {
	if (node == null) return "";
	if (typeof node === "string") return node;
	if (typeof node === "number" || typeof node === "boolean") return String(node);
	const text = node["#text"];
	if (text == null) return "";
	return typeof text === "string" ? text : String(text);
}
