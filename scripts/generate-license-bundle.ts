import * as path from "node:path";
import { Glob } from "bun";

const ROOT = path.resolve(import.meta.dir, "..");
const OUTPUT_PATH = "THIRD_PARTY_LICENSES.txt";

const LEGAL_ARTIFACTS = [
	"LICENSE",
	"NOTICE",
	"UPSTREAM.md",
	"crates/veyyon-natives/src/fonts/Silver.LICENSE",
	"crates/veyyon-shell/NOTICE",
	"docs/handbook/book/fonts/OPEN-SANS-LICENSE.txt",
	"docs/handbook/book/fonts/SOURCE-CODE-PRO-LICENSE.txt",
	"packages/coding-agent/src/markit/NOTICE",
	"packages/utils/src/vendor/mermaid-ascii/NOTICE",
	"python/veybot/LICENSE",
	"python/veyyon-rpc/LICENSE",
] as const;

async function legalArtifactPaths(root: string): Promise<string[]> {
	const paths: string[] = [...LEGAL_ARTIFACTS];
	const vendorLicenses = new Glob("crates/vendor/**/LICENSE");
	for await (const file of vendorLicenses.scan({ cwd: root, onlyFiles: true })) paths.push(file);
	return [...new Set(paths)].sort();
}

export async function renderLicenseBundle(root: string = ROOT): Promise<string> {
	const groups = new Map<string, string[]>();
	for (const relativePath of await legalArtifactPaths(root)) {
		const content = await Bun.file(path.join(root, relativePath)).text();
		const paths = groups.get(content);
		if (paths) paths.push(relativePath);
		else groups.set(content, [relativePath]);
	}

	const sections = Array.from(groups, ([content, paths]) => ({ content, paths: paths.sort() })).sort((a, b) =>
		a.paths[0]!.localeCompare(b.paths[0]!),
	);
	const output = [
		"Veyyon license and third-party notices",
		"==========================================",
		"",
		"This deterministic bundle is generated from the legal artifacts in the Veyyon source tree.",
		"Identical license texts are grouped so the binary does not carry duplicate copies.",
		"",
	];
	for (const section of sections) {
		output.push("================================================================================", "Files covered:");
		for (const relativePath of section.paths) output.push(`- ${relativePath}`);
		output.push("", section.content.trimEnd(), "");
	}
	return `${output.join("\n")}\n`;
}

if (import.meta.main) {
	await Bun.write(path.join(ROOT, OUTPUT_PATH), await renderLicenseBundle());
}
