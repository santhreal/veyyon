import { readFileSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { Glob } from "bun";

const docsEmbed = process.env.VEYYON_DOCS_EMBED ?? "";

const gunzipAsync = promisify(gunzip);

export interface DocsIndex {
	readonly filenames: readonly string[];
	getBody(relativePath: string): Promise<string | undefined>;
}

export function decodeDocsIndex(embed: string): DocsIndex | null {
	const newline = embed.indexOf("\n");
	if (newline === -1) return null;
	const filenames = JSON.parse(embed.slice(0, newline)) as string[];
	let bodies: Promise<Record<string, string>> | undefined;
	return {
		filenames,
		getBody(relativePath: string): Promise<string | undefined> {
			bodies ??= (async () => {
				const inflated = await gunzipAsync(Buffer.from(embed.slice(newline + 1), "base64"));
				const decoded = JSON.parse(inflated.toString("utf8")) as string[];
				const map: Record<string, string> = {};
				for (let i = 0; i < filenames.length; i++) map[filenames[i]] = decoded[i];
				return map;
			})();
			return bodies.then(map => map[relativePath]);
		},
	};
}

function readDocsFromDisk(): DocsIndex {
	const docsDir = path.resolve(import.meta.dir, "../../../../docs");
	const filenames: string[] = [];
	const bodies: Record<string, string> = {};
	for (const relativePath of new Glob("**/*.md").scanSync(docsDir)) {
		const normalized = relativePath.split(path.sep).join("/");
		filenames.push(normalized);
		bodies[normalized] = readFileSync(path.join(docsDir, relativePath), "utf8");
	}
	filenames.sort();
	return { filenames, getBody: relativePath => Promise.resolve(bodies[relativePath]) };
}

let index: DocsIndex | undefined;
function getIndex(): DocsIndex {
	if (index !== undefined) return index;
	if (docsEmbed.length === 0) {
		index = readDocsFromDisk();
		return index;
	}
	const decoded = decodeDocsIndex(docsEmbed);
	if (decoded === null) {
		throw new Error(
			"Malformed embedded docs index: non-empty payload without a newline separator. " +
				"Rebuild the binary or bundle.",
		);
	}
	index = decoded;
	return index;
}

export function getDocFilenames(): readonly string[] {
	return getIndex().filenames;
}

export function getEmbeddedDoc(relativePath: string): Promise<string | undefined> {
	return getIndex().getBody(relativePath);
}
