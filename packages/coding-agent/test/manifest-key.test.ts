/**
 * package.json manifest key contract: `veyyon` is the primary key; `omp` and
 * `pi` stay accepted as legacy keys; the first defined key wins in that order.
 * Locks the one-owner lookup every plugin/extension manifest reader goes
 * through (plugin manager, extension loader, discovery helpers).
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAndLoadExtensions } from "@veyyon/coding-agent/extensibility/extensions/loader";
import { MANIFEST_KEYS, manifestFromPackageJson } from "@veyyon/coding-agent/extensibility/manifest-key";
import { TempDir } from "@veyyon/utils";

interface FakeManifest {
	extensions?: string[];
	version?: string;
}

describe("manifestFromPackageJson", () => {
	it("reads the veyyon key", () => {
		const manifest = manifestFromPackageJson<FakeManifest>({ veyyon: { extensions: ["./ext.ts"] } });
		expect(manifest?.extensions).toEqual(["./ext.ts"]);
	});

	it("reads the legacy omp key", () => {
		const manifest = manifestFromPackageJson<FakeManifest>({ omp: { extensions: ["./omp.ts"] } });
		expect(manifest?.extensions).toEqual(["./omp.ts"]);
	});

	it("reads the legacy pi key", () => {
		const manifest = manifestFromPackageJson<FakeManifest>({ pi: { extensions: ["./pi.ts"] } });
		expect(manifest?.extensions).toEqual(["./pi.ts"]);
	});

	it("prefers veyyon over omp over pi when several are present", () => {
		const manifest = manifestFromPackageJson<FakeManifest>({
			pi: { extensions: ["./pi.ts"] },
			omp: { extensions: ["./omp.ts"] },
			veyyon: { extensions: ["./veyyon.ts"] },
		});
		expect(manifest?.extensions).toEqual(["./veyyon.ts"]);
		expect(manifestFromPackageJson<FakeManifest>({ pi: { version: "1" }, omp: { version: "2" } })?.version).toBe("2");
	});

	it("returns undefined when no manifest key is present", () => {
		expect(manifestFromPackageJson<FakeManifest>({})).toBeUndefined();
	});

	it("keeps the documented key order", () => {
		expect(MANIFEST_KEYS).toEqual(["veyyon", "omp", "pi"]);
	});
});

describe("manifest key has one owner", () => {
	it("no extensibility source reads pkg.omp/pkg.pi manifest keys inline instead of manifestFromPackageJson", () => {
		// Regression lock: installer.ts and plugins/loader.ts once read
		// `pkg.omp || pkg.pi` directly, silently ignoring the primary `veyyon`
		// key for installed/linked plugins. Every manifest read must go through
		// manifest-key.ts so the key order has exactly one owner.
		const srcRoot = path.resolve(import.meta.dir, "../src/extensibility");
		const offenders: string[] = [];
		const inlineKeyRead = /\.(omp|pi)\s*(\|\||\?\?)\s*\w*\.?(omp|pi)\b/;
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.name.endsWith(".ts") && entry.name !== "manifest-key.ts") {
					const source = fs.readFileSync(full, "utf-8");
					if (inlineKeyRead.test(source)) offenders.push(path.relative(srcRoot, full));
				}
			}
		};
		walk(srcRoot);
		expect(offenders).toEqual([]);
	});
});

describe("extension loader honors the veyyon manifest key", () => {
	it("loads a directory extension declared via package.json `veyyon.extensions`", async () => {
		const tempDir = TempDir.createSync("@pi-manifest-key-");
		try {
			const cwd = tempDir.absolute();
			const extDir = path.join(cwd, "my-ext");
			fs.mkdirSync(extDir, { recursive: true });
			fs.writeFileSync(
				path.join(extDir, "package.json"),
				JSON.stringify({ name: "my-ext", version: "1.0.0", veyyon: { extensions: ["./main.ts"] } }),
				"utf-8",
			);
			fs.writeFileSync(
				path.join(extDir, "main.ts"),
				`export default function(pi) {
	const { Type } = pi.typebox;
	pi.registerTool({
		name: "veyyon-key-tool",
		label: "veyyon-key-tool",
		description: "Proves the veyyon manifest key loads",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	});
}
`,
				"utf-8",
			);

			const result = await discoverAndLoadExtensions([extDir], cwd);
			expect(result.errors).toHaveLength(0);
			expect(result.extensions.some(ext => ext.tools.has("veyyon-key-tool"))).toBe(true);
		} finally {
			tempDir.removeSync();
		}
	});
});
