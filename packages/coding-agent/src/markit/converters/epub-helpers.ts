export const EXTENSIONS = [".epub"];
export const MIMETYPES = ["application/epub", "application/epub+zip", "application/x-epub+zip"];

export type MetaValue = string | number | boolean | MetaNode;
export interface MetaNode {
	"#text"?: string;
	[index: number]: MetaValue;
}
export interface Metadata {
	"dc:title"?: MetaValue;
	"dc:creator"?: MetaValue;
	"dc:language"?: MetaValue;
	"dc:publisher"?: MetaValue;
	"dc:date"?: MetaValue;
	"dc:description"?: MetaValue;
}
export interface ManifestItem {
	"@_id": string;
	"@_href": string;
}
export interface SpineItem {
	"@_idref": string;
}
export interface OpfDoc {
	package?: {
		metadata?: Metadata;
		manifest?: { item?: ManifestItem | ManifestItem[] };
		spine?: { itemref?: SpineItem | SpineItem[] };
	};
}
export interface Rootfile {
	"@_full-path": string;
}
export interface ContainerDoc {
	container?: { rootfiles?: { rootfile?: Rootfile | Rootfile[] } };
}
