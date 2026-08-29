import { XMLParser } from "fast-xml-parser";
import { createTurndown, normalizeTablesHtml } from "../../utils/turndown";
import { resolveArchiveMemberPath, unzip, unzipText } from "../../utils/zip";
import type { ConversionResult, Converter, StreamInfo } from "../types";
import type { ContainerDoc, Metadata, MetaValue, OpfDoc } from "./epub-helpers";

import { EXTENSIONS, MIMETYPES } from "./epub-helpers";
import { xmlNodeText } from "./xml-text";

export class EpubConverter implements Converter {
	name = "epub";

	accepts(streamInfo: StreamInfo): boolean {
		if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension)) return true;
		if (streamInfo.mimetype && MIMETYPES.some(m => streamInfo.mimetype?.startsWith(m))) return true;
		return false;
	}

	async convert(input: Buffer, _streamInfo: StreamInfo): Promise<ConversionResult> {
		const entries = unzip(input);
		const parser = new XMLParser({
			ignoreAttributes: false,
			attributeNamePrefix: "@_",
			textNodeName: "#text",
			processEntities: { maxTotalExpansions: 1_000_000 },
		});
		const containerXml = unzipText(entries, "META-INF/container.xml");
		if (!containerXml) throw new Error("Invalid EPUB: missing container.xml");
		const container = parser.parse(containerXml) as ContainerDoc;
		const rootfile = container.container?.rootfiles?.rootfile;
		const opfPath = Array.isArray(rootfile) ? rootfile[0]["@_full-path"] : rootfile?.["@_full-path"];
		if (!opfPath) throw new Error("Invalid EPUB: missing rootfile path");
		const opfXml = unzipText(entries, opfPath);
		if (!opfXml) throw new Error("Invalid EPUB: missing content.opf");
		const opf = parser.parse(opfXml) as OpfDoc;
		const meta: Metadata = opf.package?.metadata ?? {};
		const metadata: Record<string, string | undefined> = {
			title: this.getText(meta["dc:title"]),
			authors: this.getTextArray(meta["dc:creator"]).join(", ") || undefined,
			language: this.getText(meta["dc:language"]),
			publisher: this.getText(meta["dc:publisher"]),
			date: this.getText(meta["dc:date"]),
			description: this.getText(meta["dc:description"]),
		};
		const manifestItems = opf.package?.manifest?.item;
		const itemList = Array.isArray(manifestItems) ? manifestItems : manifestItems ? [manifestItems] : [];
		const manifest = new Map<string, string>();
		for (const item of itemList) {
			manifest.set(item["@_id"], item["@_href"]);
		}
		const spineItems = opf.package?.spine?.itemref;
		const spineList = Array.isArray(spineItems) ? spineItems : spineItems ? [spineItems] : [];
		const spineOrder = spineList.map(s => s["@_idref"]);
		const basePath = opfPath.includes("/") ? opfPath.substring(0, opfPath.lastIndexOf("/")) : "";
		const turndown = createTurndown();
		const sections: string[] = [];
		const metaLines: string[] = [];
		for (const key in metadata) {
			const value = metadata[key];
			if (value) metaLines.push(`**${key.charAt(0).toUpperCase() + key.slice(1)}:** ${value}`);
		}
		if (metaLines.length > 0) sections.push(metaLines.join("\n"));
		for (const idref of spineOrder) {
			const href = manifest.get(idref);
			if (!href) continue;
			const filePath = resolveArchiveMemberPath(basePath, href);
			const html = unzipText(entries, filePath);
			if (!html) continue;
			const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
			const md = turndown.turndown(normalizeTablesHtml(cleaned)).trim();
			if (md) sections.push(md);
		}
		return {
			markdown: sections.join("\n\n").trim(),
			title: metadata.title,
		};
	}

	getText(node: MetaValue | undefined): string | undefined {
		if (node == null) return undefined;
		if (Array.isArray(node)) return this.getText(node[0]);
		if (typeof node === "object" && node["#text"] == null) return undefined;
		return xmlNodeText(node);
	}

	getTextArray(node: MetaValue | undefined): (string | undefined)[] {
		if (!node) return [];
		const list = Array.isArray(node) ? node : [node];
		return list.map(n => this.getText(n)).filter(Boolean);
	}
}
