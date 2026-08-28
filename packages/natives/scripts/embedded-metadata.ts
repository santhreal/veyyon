export interface EmbeddedAddonEntry {
	variant: "modern" | "baseline" | "default";
	filename: string;
	size: number;
}

export interface EmbeddedMetadataInput {
	platformTag: string;
	version: string;
	archiveFilename: string;
	files: EmbeddedAddonEntry[];
}

const TYPEDEFS = `/** @typedef {"modern" | "baseline" | "default"} EmbeddedAddonVariant */



 */`;

export const STUB_METADATA_MODULE = `

${TYPEDEFS}

export const embeddedAddon = null;
`;

export function populatedMetadataModule(input: EmbeddedMetadataInput): string {
	const files = input.files
		.map(
			addon =>
				`\t\t{ variant: ${JSON.stringify(addon.variant)}, filename: ${JSON.stringify(addon.filename)}, size: ${addon.size} },`,
		)
		.join("\n");
	return `

${TYPEDEFS}

import archivePath from ${JSON.stringify(`../native/${input.archiveFilename}`)} with { type: "file" };

export const embeddedAddon = {
\tplatformTag: ${JSON.stringify(input.platformTag)},
\tversion: ${JSON.stringify(input.version)},
\tarchive: {
\t\tformat: "tar.gz",
\t\tfilename: ${JSON.stringify(input.archiveFilename)},
\t\tfilePath: archivePath,
\t},
\tfiles: [
${files}
\t],
};
`;
}

export function metadataModuleFor(argv: readonly string[], input: EmbeddedMetadataInput): string {
	return argv.includes("--stub-metadata") ? STUB_METADATA_MODULE : populatedMetadataModule(input);
}
