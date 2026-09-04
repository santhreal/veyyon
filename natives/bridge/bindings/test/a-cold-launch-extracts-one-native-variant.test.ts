/**
 * A cold launch writes the one native addon this host loads, never every variant the binary carries.
 *
 * WHY THIS SUITE EXISTS. `maybeExtractEmbeddedAddon` chose a single variant with
 * `selectEmbeddedAddonFile`, computed the target path from it, and then handed the archive
 * extractor `files: embeddedAddon.files` — the whole bundle. On x64 that bundle holds `modern` AND
 * `baseline` at about 135MB each, so the first launch of a new version wrote ~270MB to
 * `<data home>/veyyon/natives/<version>/` before the first frame reached the screen, to load
 * exactly one of the two. Measured on linux-x64: first byte at 410ms on a cold cache against 40ms
 * warm, with the gap inside the first paint, which is where the addon is first needed for ANSI
 * width. The non-archive branch immediately below it wrote only the selected file, so the two
 * branches of one function disagreed about how much disk a launch costs.
 *
 * THE CLASS. Not "the archive branch passed the wrong array", but: the decision of which variants a
 * host needs had no single owner, so a second call site could disagree with the first. It now has
 * one, `planEmbeddedAddonExtraction`, which is pure, total, and partitions the bundle. Both call
 * sites read the same plan, and a variant added to the bundle has to land on one side of it.
 *
 * WHAT THESE CASES DO. They drive the real plan against the real variant space, and the real
 * extractor against a real gzipped tar carrying both variants, asserting on the bytes that reach
 * disk: the selected file is written, and the sibling's path does not exist afterwards. The
 * fallback case proves the resilience that extracting the pair used to provide by accident — when
 * the selected variant is present but unloadable, the sibling is written on demand — is still
 * reachable, so the saving is not paid for with a boot that cannot recover.
 *
 * WHAT THEY DO NOT PROVE. `loadNative`'s retry branch is not driven here: reaching it needs a
 * present-but-unloadable addon under a compiled binary, so what is proven is that
 * `extractRemainingEmbeddedAddons` writes the skipped variants when called, not that a failed load
 * calls it. Nothing here measures startup time either; the timings above came from the startup
 * bench and are not asserted, because a wall-clock threshold on a shared machine fails for reasons
 * that are not this defect.
 *
 * MUTATIONS CHECKED. Re-injecting the original defect (`files: bundle.files` at the extraction call)
 * fails 2 cases; a plan that leaves the selected variant in `remaining` fails 5; a plan that drops
 * the unselected variants entirely fails 7; a fallback that extracts nothing fails 1.
 */

import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
	type EmbeddedAddonBundle,
	type EmbeddedAddonExtractionContext,
	type ExtractEmbeddedAddonArchiveInput,
	extractEmbeddedAddonArchive,
	extractRemainingEmbeddedAddons,
	maybeExtractEmbeddedAddon,
	planEmbeddedAddonExtraction,
} from "../native/loader-state.js";

type AddonFile = ExtractEmbeddedAddonArchiveInput["files"][number];
type AddonVariant = AddonFile["variant"];

/**
 * The variant space, enumerated once. The guard below is what keeps it honest: a variant added to
 * the bundle type and not to this tuple fails `check:ts`, so a new member cannot be added and leave
 * this suite green while going unclassified by the plan.
 */
const ALL_VARIANTS = ["modern", "baseline", "default"] as const;
type UnlistedVariant = Exclude<AddonVariant, (typeof ALL_VARIANTS)[number]>;
const EVERY_VARIANT_IS_LISTED: UnlistedVariant extends never ? true : false = true;

/** The variant a host resolves to, which is only ever one of the two x64 builds. */
const SELECTABLE_VARIANTS = ["modern", "baseline"] as const;

function addonFile(variant: AddonVariant, size?: number): AddonFile {
	return { variant, filename: `veyyon_natives.${variant}.node`, ...(size === undefined ? {} : { size }) };
}

function tarHeader(filename: string, size: number): Buffer {
	const header = Buffer.alloc(512);
	header.write(filename, 0, 100, "utf-8");
	header.write("0000644\0", 100, 8, "utf-8");
	header.write("0000000\0", 108, 8, "utf-8");
	header.write("0000000\0", 116, 8, "utf-8");
	header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "utf-8");
	header.write(`${Math.floor(0).toString(8).padStart(11, "0")}\0`, 136, 12, "utf-8");
	header.write("        ", 148, 8, "utf-8");
	header.write("0", 156, 1, "utf-8");
	header.write("ustar\0", 257, 6, "utf-8");
	header.write("00", 263, 2, "utf-8");
	let checksum = 0;
	for (const byte of header) checksum += byte;
	header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf-8");
	return header;
}

/** A real gzipped tar of the given entries, so the production extractor parses production bytes. */
function tarGz(entries: { filename: string; content: Buffer }[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		blocks.push(tarHeader(entry.filename, entry.content.length));
		const padding = (512 - (entry.content.length % 512)) % 512;
		blocks.push(entry.content, Buffer.alloc(padding));
	}
	blocks.push(Buffer.alloc(1024));
	return zlib.gzipSync(Buffer.concat(blocks));
}

function withScratch<T>(run: (dir: string) => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-one-variant-"));
	try {
		return run(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("the extraction plan names one variant and accounts for the rest", () => {
	it("keeps the variant space enumerated at the type level", () => {
		// The runtime half of the compile-time guard above: it can only be `true`, and it is here so
		// the tuple is referenced by a case rather than sitting unused for a reader to delete.
		expect(EVERY_VARIANT_IS_LISTED).toBe(true);
		expect([...ALL_VARIANTS].sort()).toEqual(["baseline", "default", "modern"]);
	});

	it("selects exactly one variant and leaves every other one behind on x64", () => {
		// The defect, at the seam that decides the cost: a bundle of two must never yield two.
		const files = [addonFile("modern"), addonFile("baseline")];
		for (const selectedVariant of SELECTABLE_VARIANTS) {
			const plan = planEmbeddedAddonExtraction({ files, arch: "x64", selectedVariant });

			expect(plan.selected?.variant).toBe(selectedVariant);
			expect(plan.remaining.map(file => file.variant)).toEqual([
				selectedVariant === "modern" ? "baseline" : "modern",
			]);
		}
	});

	it("partitions the bundle for every variant a host can resolve to, on every arch", () => {
		// Total, not merely correct on the happy shape: nothing may be dropped from the bundle or
		// counted twice, whatever the bundle holds and whatever the host is.
		const bundles: AddonFile[][] = [
			[addonFile("modern"), addonFile("baseline")],
			[addonFile("modern"), addonFile("baseline"), addonFile("default")],
			[addonFile("default")],
			[addonFile("baseline")],
			[],
		];
		for (const files of bundles) {
			for (const arch of ["x64", "arm64"] as const) {
				for (const selectedVariant of SELECTABLE_VARIANTS) {
					const plan = planEmbeddedAddonExtraction({ files, arch, selectedVariant });
					const label = `${arch}/${selectedVariant}/${files.length}`;

					const accounted = plan.selected ? [plan.selected, ...plan.remaining] : plan.remaining;
					expect(accounted.length, label).toBe(files.length);
					expect(new Set(accounted).size, label).toBe(files.length);
					for (const file of files) expect(accounted.includes(file), `${label}: ${file.filename}`).toBe(true);
					expect(plan.remaining.includes(plan.selected as AddonFile), label).toBe(false);
				}
			}
		}
	});

	it("takes the default variant off x64, where the cpu split does not apply", () => {
		const files = [addonFile("modern"), addonFile("baseline"), addonFile("default")];
		const plan = planEmbeddedAddonExtraction({ files, arch: "arm64", selectedVariant: "modern" });

		expect(plan.selected?.variant).toBe("default");
		expect(plan.remaining.map(file => file.variant).sort()).toEqual(["baseline", "modern"]);
	});

	it("falls back to baseline when a modern host has no modern build in the bundle", () => {
		const files = [addonFile("baseline")];
		const plan = planEmbeddedAddonExtraction({ files, arch: "x64", selectedVariant: "modern" });

		expect(plan.selected?.variant).toBe("baseline");
		expect(plan.remaining).toEqual([]);
	});

	it("selects nothing rather than guessing when no variant fits the host", () => {
		const plan = planEmbeddedAddonExtraction({
			files: [addonFile("modern")],
			arch: "x64",
			selectedVariant: "baseline",
		});

		expect(plan.selected).toBeNull();
		expect(plan.remaining.map(file => file.variant)).toEqual(["modern"]);
	});
});

describe("the bytes a cold launch writes", () => {
	it("writes the selected variant and never the sibling's path", () => {
		// The proof on disk, through the production extractor: the sibling must be absent, not merely
		// unreturned. Passing the whole bundle here is what the defect did, and it wrote both files.
		const modern = Buffer.from("modern-addon-bytes");
		const baseline = Buffer.from("baseline-addon-bytes-longer");
		const files = [addonFile("modern", modern.length), addonFile("baseline", baseline.length)];

		withScratch(dir => {
			const archivePath = path.join(dir, "embedded-addons.tar.gz");
			const targetDir = path.join(dir, "natives");
			fs.mkdirSync(targetDir);
			fs.writeFileSync(
				archivePath,
				tarGz([
					{ filename: files[0]?.filename ?? "", content: modern },
					{ filename: files[1]?.filename ?? "", content: baseline },
				]),
			);

			const plan = planEmbeddedAddonExtraction({ files, arch: "x64", selectedVariant: "modern" });
			const written = extractEmbeddedAddonArchive({
				archivePath,
				files: plan.selected ? [plan.selected] : [],
				targetDir,
			});

			expect(written).toEqual([path.join(targetDir, "veyyon_natives.modern.node")]);
			expect(fs.readFileSync(path.join(targetDir, "veyyon_natives.modern.node")).equals(modern)).toBe(true);
			expect(fs.existsSync(path.join(targetDir, "veyyon_natives.baseline.node"))).toBe(false);
			expect(fs.readdirSync(targetDir)).toEqual(["veyyon_natives.modern.node"]);
		});
	});

	it("writes the sibling on demand when the selected variant cannot be loaded", () => {
		// The resilience the pair used to provide by accident. Extracting one file is only safe while
		// this second pass exists, so it is asserted rather than assumed: the remaining set extracts,
		// and the two files together are then both on disk for the retried candidate walk.
		const modern = Buffer.from("modern-addon-bytes");
		const baseline = Buffer.from("baseline-addon-bytes-longer");
		const files = [addonFile("modern", modern.length), addonFile("baseline", baseline.length)];

		withScratch(dir => {
			const archivePath = path.join(dir, "embedded-addons.tar.gz");
			const targetDir = path.join(dir, "natives");
			fs.mkdirSync(targetDir);
			fs.writeFileSync(
				archivePath,
				tarGz([
					{ filename: files[0]?.filename ?? "", content: modern },
					{ filename: files[1]?.filename ?? "", content: baseline },
				]),
			);
			const plan = planEmbeddedAddonExtraction({ files, arch: "x64", selectedVariant: "modern" });
			extractEmbeddedAddonArchive({ archivePath, files: plan.selected ? [plan.selected] : [], targetDir });

			const fallback = extractEmbeddedAddonArchive({ archivePath, files: plan.remaining, targetDir });

			expect(fallback).toEqual([path.join(targetDir, "veyyon_natives.baseline.node")]);
			expect(fs.readFileSync(path.join(targetDir, "veyyon_natives.baseline.node")).equals(baseline)).toBe(true);
			expect(fs.readdirSync(targetDir).sort()).toEqual([
				"veyyon_natives.baseline.node",
				"veyyon_natives.modern.node",
			]);
		});
	});

	it("rewrites nothing on a second pass once the selected variant is current", () => {
		// The warm launch. A cold run pays once; every run after it must write zero bytes, or the
		// saving is a one-time saving and the cache is doing nothing.
		const modern = Buffer.from("modern-addon-bytes");
		const files = [addonFile("modern", modern.length)];

		withScratch(dir => {
			const archivePath = path.join(dir, "embedded-addons.tar.gz");
			const targetDir = path.join(dir, "natives");
			fs.mkdirSync(targetDir);
			fs.writeFileSync(archivePath, tarGz([{ filename: files[0]?.filename ?? "", content: modern }]));
			const plan = planEmbeddedAddonExtraction({ files, arch: "x64", selectedVariant: "modern" });
			const first = extractEmbeddedAddonArchive({ archivePath, files: [plan.selected as AddonFile], targetDir });
			const stampedAt = fs.statSync(first[0] ?? "").mtimeMs;

			const second = extractEmbeddedAddonArchive({ archivePath, files: [plan.selected as AddonFile], targetDir });

			expect(second).toEqual([]);
			expect(fs.statSync(first[0] ?? "").mtimeMs).toBe(stampedAt);
		});
	});
});

describe("the loader's own extraction pass, driven as the loader calls it", () => {
	// The seam the defect lived at. Everything above proves the plan and the extractor in isolation,
	// which a revert of the loader's call site would leave untouched: it passed the whole bundle to
	// the extractor while using one file's path as its result. These cases call the real function and
	// then look at the directory, so the write set is observed where it is actually decided.
	const VERSION = "9.9.9";
	const PLATFORM_TAG = `${process.platform}-${process.arch}`;

	/**
	 * Three variants, so at least two are left behind on x64 and on every other arch alike, each in
	 * its own archive as the build now writes them. Separate archives are what make "extract one
	 * variant" mean "inflate one variant": a shared archive is a single gzip stream.
	 */
	function bundleOfEveryVariant(dir: string): { bundle: EmbeddedAddonBundle; contents: Map<string, Buffer> } {
		const contents = new Map<string, Buffer>();
		const files: AddonFile[] = [];
		for (const variant of ALL_VARIANTS) {
			const content = Buffer.from(`${variant}-addon-bytes`.padEnd(32 + variant.length, "."));
			const file = addonFile(variant, content.length);
			const archiveName = `embedded-addons.${PLATFORM_TAG}-${variant}.tar.gz`;
			const archivePath = path.join(dir, archiveName);
			fs.writeFileSync(archivePath, tarGz([{ filename: file.filename, content }]));
			contents.set(file.filename, content);
			files.push({ ...file, archive: { format: "tar.gz", filename: archiveName, filePath: archivePath } });
		}
		return { bundle: { platformTag: PLATFORM_TAG, version: VERSION, files }, contents };
	}

	function contextFor(dir: string): EmbeddedAddonExtractionContext {
		return {
			isCompiledBinary: true,
			platformTag: PLATFORM_TAG,
			packageVersion: VERSION,
			selectedVariant: "modern",
			versionedDir: path.join(dir, "natives", VERSION),
		};
	}

	it("leaves the directory holding exactly the variant it returned", () => {
		withScratch(dir => {
			const { bundle, contents } = bundleOfEveryVariant(dir);
			const ctx = contextFor(dir);
			const errors: string[] = [];
			const expected = planEmbeddedAddonExtraction({
				files: bundle.files,
				arch: process.arch,
				selectedVariant: ctx.selectedVariant,
			});
			// The case is only meaningful while the bundle carries variants this host will not load.
			expect(expected.selected).not.toBeNull();
			expect(expected.remaining.length).toBeGreaterThanOrEqual(2);

			const returned = maybeExtractEmbeddedAddon(ctx, errors, bundle);

			const selectedName = expected.selected?.filename as string;
			expect(returned).toBe(path.join(ctx.versionedDir, selectedName));
			expect(errors).toEqual([]);
			expect(fs.readdirSync(ctx.versionedDir)).toEqual([selectedName]);
			expect(fs.readFileSync(returned as string).equals(contents.get(selectedName) as Buffer)).toBe(true);
		});
	});

	it("writes the skipped variants only when asked to, and then all of them", () => {
		withScratch(dir => {
			const { bundle, contents } = bundleOfEveryVariant(dir);
			const ctx = contextFor(dir);
			const errors: string[] = [];
			maybeExtractEmbeddedAddon(ctx, errors, bundle);
			const plan = planEmbeddedAddonExtraction({
				files: bundle.files,
				arch: process.arch,
				selectedVariant: ctx.selectedVariant,
			});

			const fallback = extractRemainingEmbeddedAddons(ctx, errors, bundle);

			expect(fallback.map(target => path.basename(target)).sort()).toEqual(
				plan.remaining.map(file => file.filename).sort(),
			);
			expect(errors).toEqual([]);
			expect(fs.readdirSync(ctx.versionedDir).sort()).toEqual(bundle.files.map(file => file.filename).sort());
			for (const file of bundle.files) {
				const written = fs.readFileSync(path.join(ctx.versionedDir, file.filename));
				expect(written.equals(contents.get(file.filename) as Buffer), file.filename).toBe(true);
			}
		});
	});

	it("extracts nothing at all outside a compiled binary, or for another platform or version", () => {
		// The guards that keep a source checkout and a stale bundle off this path. Each must stop
		// before any directory is created, so a mismatch cannot leave a partial cache behind.
		withScratch(dir => {
			const { bundle } = bundleOfEveryVariant(dir);
			const base = contextFor(dir);
			const cases: EmbeddedAddonExtractionContext[] = [
				{ ...base, isCompiledBinary: false },
				{ ...base, platformTag: "sunos-sparc" },
				{ ...base, packageVersion: "0.0.1" },
			];

			for (const ctx of cases) {
				const errors: string[] = [];
				expect(maybeExtractEmbeddedAddon(ctx, errors, bundle)).toBeNull();
				expect(extractRemainingEmbeddedAddons(ctx, errors, bundle)).toEqual([]);
				expect(errors).toEqual([]);
				expect(fs.existsSync(ctx.versionedDir)).toBe(false);
			}
		});
	});

	it("reports the archive it could not read instead of returning a path to nothing", () => {
		withScratch(dir => {
			const { bundle } = bundleOfEveryVariant(dir);
			const ctx = contextFor(dir);
			const { selected } = planEmbeddedAddonExtraction({
				files: bundle.files,
				arch: process.arch,
				selectedVariant: ctx.selectedVariant,
			});
			// Only the archive this host would read is corrupted; the siblings stay intact, so a pass
			// that reached for the wrong one would succeed and fail this case.
			fs.writeFileSync(selected?.archive?.filePath as string, Buffer.from("not a gzip stream"));
			const errors: string[] = [];

			expect(maybeExtractEmbeddedAddon(ctx, errors, bundle)).toBeNull();

			expect(errors.length).toBe(1);
			expect(errors[0]).toContain(selected?.archive?.filename as string);
			expect(fs.readdirSync(ctx.versionedDir)).toEqual([]);
		});
	});
});
