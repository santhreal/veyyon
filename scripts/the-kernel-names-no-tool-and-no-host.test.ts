/**
 * The kernel names contracts, shared runtime packages and the platform, and names no tool and no host.
 *
 * WHY THIS SUITE EXISTS. The kernel (@veyyon/kernel) is the only workspace member that is not a
 * plugin. It loads plugins, resolves contributions and executes sessions. If a kernel module imports
 * a tool, a host, a mode, or the product package (@veyyon/coding-agent), the edge type-checks because
 * workspace packages share a node_modules tree. That edge inverts the dependency graph and destroys
 * the decoupling the plugin restructure establishes (Refs #927).
 *
 * THE DEFECT CLASS. Static import and export specifiers in kernel modules reaching outside permitted
 * layers (contracts, shared runtime packages, platform, internal kernel modules), manifest dependencies
 * declaring forbidden package edges, and export patterns that fail to resolve or leave modules unreachable.
 *
 * WHAT IT DOES NOT CATCH. Runtime dependency injection where a host or tool passes values or handlers
 * to the kernel through callbacks, options, or plugin registrations. It also does not inspect the
 * three modules deliberately retained in packages/coding-agent (extension-state/types.ts,
 * verification-evidence-ledger.ts, steering-envelope.ts).
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { dynamicImportSpecifiersIn, moduleSpecifiersIn, typeOnlyModuleSpecifiersIn } from "@veyyon/utils/module-reach";
import { REPO_ROOT, typeScriptMembers } from "./workspace-layout.ts";

export interface SpecifierViolation {
	file: string;
	specifier: string;
	reason: string;
}

/** Recursively collects all .ts and .d.ts files under a directory. */
function sweepTypeScriptFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...sweepTypeScriptFiles(fullPath));
		} else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts"))) {
			files.push(fullPath);
		}
	}
	return files.sort();
}

/** Classifies a module specifier and returns a reason string if forbidden, or null if allowed. */
export function classifySpecifier(specifier: string, fromFile: string, kernelSrcDir: string): string | null {
	// Forbidden: product package
	if (specifier === "@veyyon/coding-agent" || specifier.startsWith("@veyyon/coding-agent/")) {
		return "names the product package (@veyyon/coding-agent)";
	}

	// Forbidden: the terminal host engine, and any tool path segment
	if (specifier === "@veyyon/tui" || specifier.startsWith("@veyyon/tui/")) {
		return "names the terminal host engine (@veyyon/tui)";
	}
	const segments = specifier.split("/");
	if (segments.includes("tools") || specifier.includes("/tools/") || specifier.startsWith("tools/")) {
		return "names a tool path segment (tools/)";
	}

	// Forbidden: host package or host path segment
	if (segments.includes("modes") || specifier.includes("/modes/") || specifier.startsWith("modes/")) {
		return "names a host mode segment (modes/)";
	}
	if (segments.includes("hosts") || specifier.includes("/hosts/") || specifier.startsWith("hosts/")) {
		return "names a host path segment (hosts/)";
	}
	if (segments.includes("theme") || specifier.includes("/theme/") || specifier.startsWith("theme/")) {
		return "names a theme path segment (theme/)";
	}

	// Forbidden: modes
	if (
		segments.includes("autoresearch") ||
		specifier.includes("/autoresearch/") ||
		specifier.startsWith("autoresearch/")
	) {
		return "names a forbidden mode (autoresearch/)";
	}
	if (specifier.includes("swarm")) {
		return "names a forbidden mode (swarm)";
	}

	// Forbidden: relative specifier resolving outside kernel/src
	if (specifier.startsWith(".")) {
		const resolved = path.resolve(path.dirname(fromFile), specifier);
		const normalizedKernelSrc = path.resolve(kernelSrcDir);
		if (!resolved.startsWith(normalizedKernelSrc + path.sep) && resolved !== normalizedKernelSrc) {
			return "relative specifier resolves outside kernel/src";
		}
	}

	return null;
}

describe("the kernel names no tool and no host", () => {
	const kernelMember = typeScriptMembers().find(member => member === "kernel" || member.endsWith("/kernel"));
	const kernelDir = kernelMember ? path.join(REPO_ROOT, kernelMember) : "";
	const kernelSrc = path.join(kernelDir, "src");
	const kernelFiles = sweepTypeScriptFiles(kernelSrc);

	const concernCounts = {
		registry: kernelFiles.filter(f => f.startsWith(path.join(kernelSrc, "registry") + path.sep)).length,
		loader: kernelFiles.filter(f => f.startsWith(path.join(kernelSrc, "loader") + path.sep)).length,
		session: kernelFiles.filter(f => f.startsWith(path.join(kernelSrc, "session") + path.sep)).length,
	};

	let totalSpecifiers = 0;
	for (const file of kernelFiles) {
		const source = fs.readFileSync(file, "utf8");
		totalSpecifiers +=
			moduleSpecifiersIn(source).length +
			typeOnlyModuleSpecifiersIn(source).length +
			dynamicImportSpecifiersIn(source).length;
	}

	// 1. Anti-vacuity, first cell
	it("finds kernel source files and extracts import specifiers", () => {
		expect(kernelMember).toBeDefined();
		expect(kernelFiles.length).toBe(53);
		expect(concernCounts.registry).toBe(6);
		expect(concernCounts.loader).toBe(12);
		expect(concernCounts.session).toBe(35);
		expect(concernCounts.registry).toBeGreaterThan(0);
		expect(concernCounts.loader).toBeGreaterThan(0);
		expect(concernCounts.session).toBeGreaterThan(0);
		expect(totalSpecifiers).toBeGreaterThan(0);
	});

	// 2. The direction rule
	it("contains no forbidden specifier in any kernel module", () => {
		const violations: SpecifierViolation[] = [];
		for (const file of kernelFiles) {
			const source = fs.readFileSync(file, "utf8");
			const specifiers = [
				...moduleSpecifiersIn(source),
				...typeOnlyModuleSpecifiersIn(source),
				...dynamicImportSpecifiersIn(source),
			];
			for (const specifier of specifiers) {
				const reason = classifySpecifier(specifier, file, kernelSrc);
				if (reason) {
					violations.push({
						file: path.relative(REPO_ROOT, file),
						specifier,
						reason,
					});
				}
			}
		}
		expect(violations).toEqual([]);
	});

	// 3. The manifest half
	it("declares only allowed dependencies in package.json", () => {
		const manifestPath = path.join(kernelDir, "package.json");
		expect(fs.existsSync(manifestPath)).toBe(true);
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
			dependencies?: Record<string, string>;
		};
		const depKeys = Object.keys(manifest.dependencies ?? {}).sort();
		expect(depKeys).toEqual(["@veyyon/agent-core", "@veyyon/ai", "@veyyon/catalog", "@veyyon/utils"]);
	});

	/**
	 * A barrel nobody imports is banned by scripts/barrel-files-are-imported.test.ts.
	 * A single root entry point would republish all 55 modules as one surface,
	 * violating the decoupling that requires consumers to import specific concerns.
	 */
	// 4. No root barrel
	it("has no root index.ts, no main, no types, and no root '.' export", () => {
		const rootIndex = path.join(kernelSrc, "index.ts");
		expect(fs.existsSync(rootIndex)).toBe(false);

		const manifestPath = path.join(kernelDir, "package.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
			main?: string;
			types?: string;
			exports?: Record<string, unknown>;
		};
		expect(manifest.main).toBeUndefined();
		expect(manifest.types).toBeUndefined();
		expect(manifest.exports?.["."]).toBeUndefined();
	});

	// 5. Every published subpath resolves
	it("resolves every exports pattern and reaches every module through one", () => {
		const manifestPath = path.join(kernelDir, "package.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
			exports?: Record<string, { import?: string; types?: string } | string>;
		};
		const exportsMap = manifest.exports ?? {};
		const exportKeys = Object.keys(exportsMap);
		expect(exportKeys.length).toBeGreaterThan(0);

		const relativeFiles = kernelFiles.map(file => path.relative(kernelSrc, file).split(path.sep).join("/"));
		const reachedBy = new Map<string, string[]>();
		for (const key of exportKeys) {
			const target = exportsMap[key];
			const targetPath = typeof target === "string" ? target : (target?.import ?? target?.types);
			if (targetPath === undefined) throw new Error(`the exports key ${key} states no target`);
			const [prefix, suffix] = targetPath.replace(/^\.\/src\//, "").split("*");
			if (suffix === undefined) throw new Error(`the exports key ${key} states no pattern: ${targetPath}`);
			const matched = relativeFiles.filter(file => file.startsWith(prefix) && file.endsWith(suffix));
			expect(matched.length, `${key} resolves to no module on disk`).toBeGreaterThan(0);
			for (const file of matched) reachedBy.set(file, [...(reachedBy.get(file) ?? []), key]);
		}

		// A module the manifest does not publish is unreachable code in a package with no barrel to
		// reach it through, so the whole file list has to be covered, not a floor of it.
		const unreachable = relativeFiles.filter(file => (reachedBy.get(file) ?? []).length === 0);
		expect(unreachable).toEqual([]);
	});

	// 6. A positive control
	it("detects forbidden specifier kinds and permits allowed ones in a positive control", () => {
		const testFile = path.join(kernelSrc, "session", "session-entries.ts");
		const syntheticSpecifiers: Array<{
			specifier: string;
			expectedForbidden: boolean;
			reasonSubstring?: string;
		}> = [
			{
				specifier: "@veyyon/coding-agent",
				expectedForbidden: true,
				reasonSubstring: "product package",
			},
			{
				specifier: "@veyyon/coding-agent/session/types",
				expectedForbidden: true,
				reasonSubstring: "product package",
			},
			{
				specifier: "@veyyon/tui",
				expectedForbidden: true,
				reasonSubstring: "terminal host engine",
			},
			{
				specifier: "./tools/executor",
				expectedForbidden: true,
				reasonSubstring: "tool path segment",
			},
			{
				specifier: "modes/terminal",
				expectedForbidden: true,
				reasonSubstring: "host mode segment",
			},
			{
				specifier: "@veyyon/hosts/terminal",
				expectedForbidden: true,
				reasonSubstring: "host path segment",
			},
			{
				specifier: "theme/dark",
				expectedForbidden: true,
				reasonSubstring: "theme path segment",
			},
			{
				specifier: "autoresearch/state",
				expectedForbidden: true,
				reasonSubstring: "forbidden mode",
			},
			{
				specifier: "@veyyon/swarm-extension",
				expectedForbidden: true,
				reasonSubstring: "forbidden mode",
			},
			{
				specifier: "../../../packages/coding-agent/src/index",
				expectedForbidden: true,
				reasonSubstring: "outside kernel/src",
			},
			{
				specifier: "@veyyon/utils",
				expectedForbidden: false,
			},
			{
				specifier: "@veyyon/ai",
				expectedForbidden: false,
			},
			{
				specifier: "node:path",
				expectedForbidden: false,
			},
			{
				specifier: "./session-storage",
				expectedForbidden: false,
			},
			{
				specifier: "../loader/manifest-key",
				expectedForbidden: false,
			},
		];

		const forbiddenResults: Array<{ specifier: string; reason: string }> = [];
		for (const entry of syntheticSpecifiers) {
			const reason = classifySpecifier(entry.specifier, testFile, kernelSrc);
			if (entry.expectedForbidden) {
				expect(reason).not.toBeNull();
				if (entry.reasonSubstring) {
					expect(reason).toContain(entry.reasonSubstring);
				}
				forbiddenResults.push({ specifier: entry.specifier, reason: reason! });
			} else {
				expect(reason).toBeNull();
			}
		}

		expect(forbiddenResults.map(r => r.specifier)).toEqual([
			"@veyyon/coding-agent",
			"@veyyon/coding-agent/session/types",
			"@veyyon/tui",
			"./tools/executor",
			"modes/terminal",
			"@veyyon/hosts/terminal",
			"theme/dark",
			"autoresearch/state",
			"@veyyon/swarm-extension",
			"../../../packages/coding-agent/src/index",
		]);
	});
});
