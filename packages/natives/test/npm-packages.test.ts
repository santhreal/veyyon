import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildLeafManifest, generateNpmPackages } from "../scripts/gen-npm-packages";

describe("generated native npm leaf packages", () => {
	it("builds an x64 leaf manifest that exposes all addon files without package exports", () => {
		const addonFiles = ["veyyon_natives.linux-x64-baseline.node", "veyyon_natives.linux-x64-modern.node"];
		const manifest = buildLeafManifest({
			tag: "linux-x64",
			os: "linux",
			cpu: "x64",
			files: addonFiles,
			version: "15.5.15",
		});

		expect(manifest.name).toBe("@veyyon/natives-linux-x64");
		expect(manifest.version).toBe("15.5.15");
		expect(manifest.os).toEqual(["linux"]);
		expect(manifest.cpu).toEqual(["x64"]);
		expect(addonFiles).toContain(manifest.main.slice("./".length));
		expect(manifest.files).toContain("*.node");
		expect(manifest.files).toContain("README.md");
		expect("exports" in manifest).toBe(false);
	});

	it("uses the default addon as the main entry for non-x64 leaves", () => {
		const addonFiles = ["veyyon_natives.darwin-arm64.node"];
		const manifest = buildLeafManifest({
			tag: "darwin-arm64",
			os: "darwin",
			cpu: "arm64",
			files: addonFiles,
			version: "15.5.15",
		});

		expect(manifest.name).toBe("@veyyon/natives-darwin-arm64");
		expect(manifest.os).toEqual(["darwin"]);
		expect(manifest.cpu).toEqual(["arm64"]);
		expect(manifest.main).toBe("./veyyon_natives.darwin-arm64.node");
		expect(addonFiles).toContain(manifest.main.slice("./".length));
		expect("exports" in manifest).toBe(false);
	});

	it("generates every leaf package by copying present addon files", async () => {
		const packageDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-natives-npm-"));
		try {
			await fs.mkdir(path.join(packageDir, "native"));
			await Bun.write(path.join(packageDir, "package.json"), JSON.stringify({ version: "15.5.15" }));
			const addonFiles = [
				"veyyon_natives.linux-x64-baseline.node",
				"veyyon_natives.linux-x64-modern.node",
				"veyyon_natives.linux-arm64.node",
				"veyyon_natives.darwin-x64-baseline.node",
				"veyyon_natives.darwin-arm64.node",
				"veyyon_natives.win32-x64-baseline.node",
			];
			for (const file of addonFiles) {
				await Bun.write(path.join(packageDir, "native", file), file);
			}

			const leaves = await generateNpmPackages({ packageDir });
			expect(leaves.map(leaf => leaf.tag)).toEqual([
				"linux-x64",
				"linux-arm64",
				"darwin-x64",
				"darwin-arm64",
				"win32-x64",
			]);
			const linuxX64 = leaves.find(leaf => leaf.tag === "linux-x64");
			expect(linuxX64?.files).toEqual([
				"veyyon_natives.linux-x64-baseline.node",
				"veyyon_natives.linux-x64-modern.node",
			]);
			expect(
				await Bun.file(path.join(packageDir, "npm/linux-x64/veyyon_natives.linux-x64-modern.node")).text(),
			).toBe("veyyon_natives.linux-x64-modern.node");
			const manifest = await Bun.file(path.join(packageDir, "npm/linux-x64/package.json")).json();
			expect(manifest.main).toBe("./veyyon_natives.linux-x64-baseline.node");
			expect("exports" in manifest).toBe(false);
		} finally {
			await fs.rm(packageDir, { recursive: true, force: true });
		}
	});

	it("reports missing leaves during dry runs without writing generated packages", async () => {
		const packageDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-natives-npm-dry-"));
		const logSpy = spyOn(console, "log").mockImplementation(() => {});
		try {
			await fs.mkdir(path.join(packageDir, "native"));
			await Bun.write(path.join(packageDir, "package.json"), JSON.stringify({ version: "15.5.15" }));
			await Bun.write(path.join(packageDir, "native/veyyon_natives.darwin-arm64.node"), "darwin");

			const leaves = await generateNpmPackages({ packageDir, dryRun: true });
			expect(leaves.filter(leaf => leaf.missing).map(leaf => leaf.tag)).toEqual([
				"linux-x64",
				"linux-arm64",
				"darwin-x64",
				"win32-x64",
			]);
			expect(await Bun.file(path.join(packageDir, "npm/darwin-arm64/package.json")).exists()).toBe(false);
		} finally {
			logSpy.mockRestore();
			await fs.rm(packageDir, { recursive: true, force: true });
		}
	});
});
