import * as fs from "node:fs/promises";
import * as path from "node:path";
import { findStaleAddon, staleAddonMessage } from "../native/loader-state.js";
import { metadataModuleFor, STUB_METADATA_MODULE } from "./embedded-metadata";

const reset = process.argv.includes("--reset");
const outputPath = path.join(import.meta.dir, "../native/embedded-addon.js");
const packageJsonPath = path.join(import.meta.dir, "../package.json");
const nativeDir = path.join(import.meta.dir, "../native");
const archivePrefix = "embedded-addons.";
const archiveSuffix = ".tar.gz";

if (reset) {
	await Bun.write(outputPath, STUB_METADATA_MODULE);
	try {
		const entries = await fs.readdir(nativeDir);
		await Promise.all(
			entries
				.filter(entry => entry.startsWith(archivePrefix) && entry.endsWith(archiveSuffix))
				.map(entry => fs.unlink(path.join(nativeDir, entry))),
		);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	process.exit(0);
}

interface CandidateAddon {
	variant: "modern" | "baseline" | "default";
	filename: string;
}

interface AvailableAddon extends CandidateAddon {
	path: string;
	size: number;
}

const targetPlatform = Bun.env.TARGET_PLATFORM || process.platform;
const targetArch = Bun.env.TARGET_ARCH || process.arch;
const platformTag = `${targetPlatform}-${targetArch}`;
const candidates: CandidateAddon[] =
	targetArch === "x64"
		? [
				{ variant: "modern", filename: `veyyon_natives.${platformTag}-modern.node` },
				{ variant: "baseline", filename: `veyyon_natives.${platformTag}-baseline.node` },
			]
		: [{ variant: "default", filename: `veyyon_natives.${platformTag}.node` }];

const available: AvailableAddon[] = [];
for (const candidate of candidates) {
	const candidatePath = path.join(nativeDir, candidate.filename);
	try {
		const stat = await fs.stat(candidatePath);
		available.push({ ...candidate, path: candidatePath, size: stat.size });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
}

if (available.length === 0) {
	const expected = candidates.map(candidate => `  - ${candidate.filename}`).join("\n");
	throw new Error(`No native addons found for ${platformTag}. Expected one of:\n${expected}`);
}
const packageJson = (await Bun.file(packageJsonPath).json()) as { version: string };

const archiveFilename = `${archivePrefix}${platformTag}${archiveSuffix}`;
const archivePath = path.join(nativeDir, archiveFilename);
const archiveEntries: Record<string, Uint8Array> = {};
const addonBytes = await Promise.all(
	available.map(async addon => ({ filename: addon.filename, bytes: await fs.readFile(addon.path) })),
);

const stale = findStaleAddon(addonBytes, packageJson.version);
if (stale) {
	throw new Error(staleAddonMessage(stale, packageJson.version));
}
for (const addon of addonBytes) {
	archiveEntries[addon.filename] = addon.bytes;
}
await Bun.write(archivePath, await new Bun.Archive(archiveEntries, { compress: "gzip", level: 9 }).bytes());

await Bun.write(
	outputPath,
	metadataModuleFor(process.argv, {
		platformTag,
		version: packageJson.version,
		archiveFilename,
		files: available.map(addon => ({ variant: addon.variant, filename: addon.filename, size: addon.size })),
	}),
);
