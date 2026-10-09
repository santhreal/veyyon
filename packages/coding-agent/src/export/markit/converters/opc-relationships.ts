/**
 * OPC part relationships for the markit Office converters (PPTX, XLSX).
 *
 * A part's relationships are stored in `<dir>/_rels/<name>.rels`, and each internal `Target` is a URI
 * relative to the part's own directory. A converter reads a related part through the member path this
 * module resolves, never by joining a fixed prefix or by guessing a sibling part's name from its own.
 */
import * as path from "node:path";
import type { XMLParser } from "fast-xml-parser";
import { resolveArchiveMemberPath, type Unzipped, unzipText } from "../../../utils/zip";

interface RelationshipNode {
	"@_Id"?: string;
	"@_Type"?: string;
	"@_Target"?: string;
	"@_TargetMode"?: string;
}

interface RelationshipsDoc {
	Relationships?: { Relationship?: RelationshipNode | RelationshipNode[] };
}

/** One relationship of a part: its type URI and the archive member its target resolves to. */
export interface PartRelationship {
	type: string;
	member: string;
}

/**
 * The relationships of the part at `partPath`, keyed by `Id`. A relationship with no `Id` or no
 * `Target` is left out, and so is an external one (a hyperlink, a linked image), whose target names no
 * archive member. An absent `.rels` part yields an empty map.
 */
export function readPartRelationships(
	entries: Unzipped,
	parser: XMLParser,
	partPath: string,
): Map<string, PartRelationship> {
	const relationships = new Map<string, PartRelationship>();
	const dir = path.posix.dirname(partPath);
	const relsPath = `${dir === "." ? "" : `${dir}/`}_rels/${path.posix.basename(partPath)}.rels`;
	const relsXml = unzipText(entries, relsPath);
	if (!relsXml) return relationships;
	const list = (parser.parse(relsXml) as RelationshipsDoc).Relationships?.Relationship;
	for (const node of Array.isArray(list) ? list : list ? [list] : []) {
		const id = node["@_Id"];
		const target = node["@_Target"];
		if (!id || !target || node["@_TargetMode"] === "External") continue;
		relationships.set(id, {
			type: node["@_Type"] ?? "",
			member: resolveArchiveMemberPath(dir, target),
		});
	}
	return relationships;
}

/** The first relationship whose type URI ends in `/<kind>`, in transitional or strict OOXML. */
export function relationshipOfKind(
	relationships: Map<string, PartRelationship>,
	kind: string,
): PartRelationship | undefined {
	const suffix = `/${kind}`;
	for (const relationship of relationships.values()) {
		if (relationship.type.endsWith(suffix)) return relationship;
	}
	return undefined;
}
