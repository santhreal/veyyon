#!/usr/bin/env bun
/**
 * Vendor the GPUI crate closure from a zed fork repository checkout.
 *
 * Extracts the 23 crates making up GPUI and its immediate runtime support from a
 * specified git revision into `crates/vendor/<name>`, rewriting their manifests
 * to inline workspace dependencies and point internal inter-crate dependencies
 * at sibling path directories (`crates/vendor/*`). The resolved commit is written
 * to `crates/vendor/GPUI_VENDOR_REV` so a snapshot states where it came from.
 *
 * Usage:
 *   bun scripts/vendor-gpui.ts --source <zed-checkout-path> --rev <git-revision>
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";

export interface CrateDefinition {
	name: string;
	dir: string;
}

export interface CargoPackageWorkspaceSpec {
	publish?: boolean;
	edition?: string;
	license?: string;
	version?: string;
	"rust-version"?: string;
	authors?: string[];
	homepage?: string;
	repository?: string;
}

export interface CargoDependencySpec {
	version?: string;
	path?: string;
	package?: string;
	git?: string;
	rev?: string;
	branch?: string;
	tag?: string;
	"default-features"?: boolean;
	features?: string[];
	optional?: boolean;
	workspace?: boolean;
}

export interface RootTomlWorkspace {
	package?: CargoPackageWorkspaceSpec;
	dependencies?: Record<string, string | CargoDependencySpec>;
}

export interface RootToml {
	workspace?: RootTomlWorkspace;
	patch?: Record<string, Record<string, CargoDependencySpec>>;
}

/** The 23 crates in the GPUI crate closure. */
export const CRATES_TO_VENDOR: readonly CrateDefinition[] = [
	{ name: "collections", dir: "crates/collections" },
	{ name: "derive_refineable", dir: "crates/refineable/derive_refineable" },
	{ name: "gpui", dir: "crates/gpui" },
	{ name: "gpui_apple", dir: "crates/gpui_apple" },
	{ name: "gpui_linux", dir: "crates/gpui_linux" },
	{ name: "gpui_macos", dir: "crates/gpui_macos" },
	{ name: "gpui_macros", dir: "crates/gpui_macros" },
	{ name: "gpui_platform", dir: "crates/gpui_platform" },
	{ name: "gpui_shared_string", dir: "crates/gpui_shared_string" },
	{ name: "gpui_util", dir: "crates/gpui_util" },
	{ name: "gpui_web", dir: "crates/gpui_web" },
	{ name: "gpui_wgpu", dir: "crates/gpui_wgpu" },
	{ name: "gpui_windows", dir: "crates/gpui_windows" },
	{ name: "http_client", dir: "crates/http_client" },
	{ name: "media", dir: "crates/media" },
	{ name: "perf", dir: "tooling/perf" },
	{ name: "refineable", dir: "crates/refineable" },
	{ name: "scheduler", dir: "crates/scheduler" },
	{ name: "sum_tree", dir: "crates/sum_tree" },
	{ name: "util_macros", dir: "crates/util_macros" },
	{ name: "zlog", dir: "crates/zlog" },
	{ name: "ztracing", dir: "crates/ztracing" },
	{ name: "ztracing_macro", dir: "crates/ztracing_macro" },
] as const;

const CLOSURE_MAP: Record<string, true> = Object.fromEntries(CRATES_TO_VENDOR.map(c => [c.name, true]));

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatTomlValue(val: unknown): string {
	if (typeof val === "string") return JSON.stringify(val);
	if (typeof val === "boolean") return val ? "true" : "false";
	if (typeof val === "number") return val.toString();
	if (Array.isArray(val)) return `[${val.map(formatTomlValue).join(", ")}]`;
	if (isRecord(val)) {
		const entries = Object.entries(val).map(([k, v]) => `${k} = ${formatTomlValue(v)}`);
		return `{ ${entries.join(", ")} }`;
	}
	return String(val);
}

export function resolveDependency(
	depName: string,
	localSpec: CargoDependencySpec,
	wsDeps: Record<string, string | CargoDependencySpec>,
): CargoDependencySpec {
	const rootRaw = wsDeps[depName];
	if (rootRaw === undefined) {
		throw new Error(`Workspace dependency '${depName}' not found in root [workspace.dependencies]!`);
	}

	const rootObj: CargoDependencySpec = typeof rootRaw === "string" ? { version: rootRaw } : rootRaw;

	// Sibling dependency in vendored closure
	if (CLOSURE_MAP[depName]) {
		const merged: CargoDependencySpec = {
			path: `../${depName}`,
		};
		const packageName = localSpec.package ?? rootObj.package;
		if (packageName !== undefined) merged.package = packageName;

		if (localSpec["default-features"] !== undefined) {
			merged["default-features"] = localSpec["default-features"];
		} else if (rootObj["default-features"] !== undefined) {
			merged["default-features"] = rootObj["default-features"];
		}

		const features: string[] = [];
		if (rootObj.features) features.push(...rootObj.features);
		if (localSpec.features) features.push(...localSpec.features);
		const uniqueFeatures = Array.from(new Set(features));
		if (uniqueFeatures.length > 0) merged.features = uniqueFeatures;

		if (localSpec.optional !== undefined) merged.optional = localSpec.optional;
		return merged;
	}

	// External dependency
	const merged: CargoDependencySpec = {};
	if (rootObj.version !== undefined) merged.version = rootObj.version;
	if (rootObj.package !== undefined) merged.package = rootObj.package;
	if (rootObj.git !== undefined) merged.git = rootObj.git;
	if (rootObj.rev !== undefined) merged.rev = rootObj.rev;
	if (rootObj.branch !== undefined) merged.branch = rootObj.branch;
	if (rootObj.tag !== undefined) merged.tag = rootObj.tag;

	if (localSpec["default-features"] !== undefined) {
		merged["default-features"] = localSpec["default-features"];
	} else if (rootObj["default-features"] !== undefined) {
		merged["default-features"] = rootObj["default-features"];
	}

	const features: string[] = [];
	if (rootObj.features) features.push(...rootObj.features);
	if (localSpec.features) features.push(...localSpec.features);
	const uniqueFeatures = Array.from(new Set(features));
	if (uniqueFeatures.length > 0) merged.features = uniqueFeatures;

	if (localSpec.optional !== undefined) merged.optional = localSpec.optional;
	return merged;
}

export function formatDependencyLine(depName: string, spec: CargoDependencySpec): string {
	const keys = Object.keys(spec);
	if (keys.length === 1 && spec.version !== undefined) {
		return `${depName} = ${JSON.stringify(spec.version)}`;
	}
	const keyOrder: (keyof CargoDependencySpec)[] = [
		"path",
		"version",
		"package",
		"git",
		"rev",
		"branch",
		"tag",
		"default-features",
		"features",
		"optional",
	];
	const parts: string[] = [];
	for (const k of keyOrder) {
		const val = spec[k];
		if (val !== undefined) {
			parts.push(`${k} = ${formatTomlValue(val)}`);
		}
	}
	return `${depName} = { ${parts.join(", ")} }`;
}

export function rewriteManifest(
	manifestText: string,
	crateName: string,
	wsPackage: CargoPackageWorkspaceSpec,
	wsDeps: Record<string, string | CargoDependencySpec>,
): string {
	const lines = manifestText.split("\n");
	const newLines: string[] = [];
	let i = 0;
	let currentSection = "";

	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();

		// Check for section header
		const headerMatch = trimmed.match(/^\[(.*)\]$/);
		if (headerMatch) {
			const sectionName = headerMatch[1];

			// Rule 3: [lints] workspace = true -> delete table
			if (sectionName === "lints") {
				let j = i + 1;
				while (j < lines.length && lines[j].trim() === "") j++;
				if (j < lines.length && lines[j].trim() === "workspace = true") {
					i = j + 1;
					continue;
				}
			}

			// Sub-table dependency headers, e.g. [target.'...'.dependencies.scap]
			const subDepMatch = sectionName.match(/^(.*dependencies)\.([a-zA-Z0-9_-]+)$/);
			if (subDepMatch) {
				const depName = subDepMatch[2];
				let j = i + 1;
				const subTableLines: string[] = [];
				while (j < lines.length && !lines[j].trim().startsWith("[")) {
					if (lines[j].trim() !== "") subTableLines.push(lines[j]);
					j++;
				}
				const subTableContent = subTableLines.join("\n");
				const parsedSubWrapper: unknown = Bun.TOML.parse(`[dep]\n${subTableContent}`);
				const parsedSub = isRecord(parsedSubWrapper) && isRecord(parsedSubWrapper.dep) ? parsedSubWrapper.dep : {};
				if (parsedSub.workspace === true) {
					const localSpec: CargoDependencySpec = {
						workspace: true,
						optional: typeof parsedSub.optional === "boolean" ? parsedSub.optional : undefined,
					};
					const merged = resolveDependency(depName, localSpec, wsDeps);
					const depLine = formatDependencyLine(depName, merged);
					newLines.push(depLine);
					i = j;
					continue;
				}
			}

			currentSection = sectionName;
			newLines.push(line);
			i++;
			continue;
		}

		// Rule 2: [package] keys with .workspace = true
		if (currentSection === "package") {
			const pkgWsMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\.workspace\s*=\s*true$/);
			if (pkgWsMatch) {
				const key = pkgWsMatch[1] as keyof CargoPackageWorkspaceSpec;
				const wsVal = wsPackage[key];
				if (wsVal === undefined) {
					throw new Error(`Workspace package key '${key}' not found in root [workspace.package]!`);
				}
				newLines.push(`${key} = ${formatTomlValue(wsVal)}`);
				i++;
				continue;
			}
		}

		// Features section in http_client: remove dep:util
		if (currentSection === "features" && crateName === "http_client") {
			if (trimmed.includes('"dep:util"') || trimmed.includes("'dep:util'")) {
				i++;
				continue;
			}
		}

		// Dependency tables
		const isDepSection = /(^|\.)(dev-|build-)?dependencies$/.test(currentSection);
		if (isDepSection) {
			const isDevDep = /(^|\.)dev-dependencies$/.test(currentSection);
			const depNameMatch = trimmed.match(/^([a-zA-Z0-9_-]+)(\.workspace\s*=\s*true|\s*=\s*(.*))$/);
			if (depNameMatch) {
				const depName = depNameMatch[1];

				// Rule 4: Dev-dependencies pointing at path crates outside closure
				if (isDevDep && ["reqwest_client", "http_client_tls", "util"].includes(depName)) {
					i++;
					continue;
				}

				// Remove unvendored util dependency from http_client
				if (crateName === "http_client" && depName === "util") {
					i++;
					continue;
				}

				if (trimmed.endsWith(".workspace = true")) {
					const merged = resolveDependency(depName, { workspace: true }, wsDeps);
					newLines.push(formatDependencyLine(depName, merged));
					i++;
					continue;
				} else if (trimmed.includes("workspace = true")) {
					const parsedLineWrapper: unknown = Bun.TOML.parse(`[dep]\n${line}`);
					const depVal =
						isRecord(parsedLineWrapper) && isRecord(parsedLineWrapper.dep)
							? parsedLineWrapper.dep[depName]
							: undefined;
					const parsedDep: CargoDependencySpec = isRecord(depVal)
						? (depVal as CargoDependencySpec)
						: { workspace: true };
					if (parsedDep.workspace === true) {
						const merged = resolveDependency(depName, parsedDep, wsDeps);
						newLines.push(formatDependencyLine(depName, merged));
						i++;
						continue;
					}
				}
			}
		}

		newLines.push(line);
		i++;
	}

	// An excluded path dependency is not a member of any workspace, so cargo
	// walks up from its directory and stops at the first manifest with a
	// `[workspace]` table. An empty table here makes the crate its own root, as
	// the brush crates do, rather than an unlisted member of whatever lies above.
	let manifest = newLines.join("\n");
	if (!manifest.endsWith("\n")) manifest += "\n";
	return `${manifest}\n[workspace]\n`;
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			source: { type: "string" },
			rev: { type: "string" },
		},
		strict: true,
		allowPositionals: false,
	});

	const sourceRepo = values.source;
	const rev = values.rev;

	if (!sourceRepo || !rev) {
		console.error("Usage: bun scripts/vendor-gpui.ts --source <zed checkout> --rev <git rev>");
		process.exit(1);
	}

	const repoRoot = path.resolve(import.meta.dirname, "..");
	const vendorDir = path.join(repoRoot, "crates", "vendor");

	// Resolve the revision to a full commit so the recorded provenance is exact.
	let resolvedRev: string;
	try {
		resolvedRev = execFileSync("git", ["-C", sourceRepo, "rev-parse", "--verify", `${rev}^{commit}`], {
			encoding: "utf8",
		}).trim();
	} catch (err) {
		console.error(`Failed to resolve '${rev}' in source repository ${sourceRepo}:`, err);
		process.exit(1);
	}

	// Read and parse root Cargo.toml from zed at revision
	let rootTomlText: string;
	try {
		rootTomlText = execFileSync("git", ["-C", sourceRepo, "show", `${resolvedRev}:Cargo.toml`], {
			encoding: "utf8",
			maxBuffer: 10 * 1024 * 1024,
		});
	} catch (err) {
		console.error(`Failed to read Cargo.toml from source repository at rev '${resolvedRev}':`, err);
		process.exit(1);
	}

	// Bun.TOML: node has no TOML parser without a dependency.
	const parsedRootWrapper = Bun.TOML.parse(rootTomlText);
	const parsedRoot: RootToml = isRecord(parsedRootWrapper) ? (parsedRootWrapper as RootToml) : {};
	const wsPackage = parsedRoot.workspace?.package ?? {};
	const wsDeps = parsedRoot.workspace?.dependencies ?? {};

	console.log(`Extracting ${CRATES_TO_VENDOR.length} crates from ${sourceRepo} at ${resolvedRev}...`);

	const importedCrates: string[] = [];

	for (const crate of CRATES_TO_VENDOR) {
		const destDir = path.join(vendorDir, crate.name);

		// Idempotent clean: remove existing destDir if present
		await fs.rm(destDir, { recursive: true, force: true });
		await fs.mkdir(destDir, { recursive: true });

		// Extract crate files using git archive piped into tar, without a shell.
		const stripComponents = crate.dir.split("/").length;
		try {
			const archive = execFileSync("git", ["-C", sourceRepo, "archive", resolvedRev, "--", crate.dir], {
				maxBuffer: 256 * 1024 * 1024,
			});
			execFileSync("tar", ["-x", `--strip-components=${stripComponents}`, "-C", destDir], {
				input: archive,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (err) {
			console.error(`Failed to extract crate '${crate.name}' from path '${crate.dir}':`, err);
			process.exit(1);
		}

		// If refineable, remove nested derive_refineable directory so it stays flattened
		if (crate.name === "refineable") {
			const nestedDerive = path.join(destDir, "derive_refineable");
			await fs.rm(nestedDerive, { recursive: true, force: true });
		}

		// Read manifest and rewrite
		const manifestPath = path.join(destDir, "Cargo.toml");
		let manifestContent: string;
		try {
			manifestContent = await fs.readFile(manifestPath, "utf8");
		} catch (err) {
			console.error(`Failed to read manifest for crate '${crate.name}' at ${manifestPath}:`, err);
			process.exit(1);
		}

		let rewritten: string;
		try {
			rewritten = rewriteManifest(manifestContent, crate.name, wsPackage, wsDeps);
		} catch (err) {
			console.error(`Error rewriting manifest for crate '${crate.name}':`, err);
			process.exit(1);
		}

		// Validate that rewritten manifest is valid TOML
		try {
			Bun.TOML.parse(rewritten);
		} catch (err) {
			console.error(`Rewritten manifest for crate '${crate.name}' failed TOML parsing:`, err);
			process.exit(1);
		}

		await fs.writeFile(manifestPath, rewritten, "utf8");
		importedCrates.push(crate.name);
	}

	await fs.writeFile(path.join(vendorDir, "GPUI_VENDOR_REV"), `${resolvedRev}\n`, "utf8");

	console.log(`\nVendored ${importedCrates.length} crates at ${resolvedRev}:`);
	for (const name of importedCrates) {
		console.log(`  - ${name}`);
	}
}

if (import.meta.main) {
	main().catch(err => {
		console.error("Fatal error:", err);
		process.exit(1);
	});
}
