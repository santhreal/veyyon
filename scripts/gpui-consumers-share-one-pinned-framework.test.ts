// WHY: copied framework sources diverge from the canonical repository and can
// omit renderer changes. Assert the dependency and lockfile contract, including
// absence of local source copies. Renderer behavior is tested by veyyon-gpui.
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod/v4";

const root = path.resolve(import.meta.dirname, "..");
const repository = "https://github.com/santhreal/gpui.git";
const manifestSchema = z.object({
	workspace: z.object({ dependencies: z.record(z.string(), z.unknown()) }),
});
const dependencySchema = z.object({
	git: z.literal(repository),
	rev: z.string().regex(/^[0-9a-f]{40}$/),
	path: z.never().optional(),
	branch: z.never().optional(),
	tag: z.never().optional(),
});
const lockSchema = z.object({
	package: z.array(z.object({ name: z.string(), source: z.string().optional() })),
});

test("GPUI consumers and the resolved framework use one canonical revision without source copies", async () => {
	const manifest = manifestSchema.parse(Bun.TOML.parse(await fs.readFile(path.join(root, "Cargo.toml"), "utf8")));
	const dependencies = Object.entries(manifest.workspace.dependencies)
		.filter(([name]) => name === "gpui" || name.startsWith("gpui_"))
		.sort(([left], [right]) => left.localeCompare(right));
	expect(dependencies.map(([name]) => name)).toEqual(["gpui", "gpui_platform", "gpui_wgpu"]);
	const revisions = new Set(dependencies.map(([, spec]) => dependencySchema.parse(spec).rev));
	expect(revisions.size).toBe(1);
	const revision = [...revisions][0];
	const source = `git+${repository}?rev=${revision}#${revision}`;
	const lock = lockSchema.parse(Bun.TOML.parse(await fs.readFile(path.join(root, "Cargo.lock"), "utf8")));
	const framework = lock.package.filter(pkg => pkg.source?.startsWith(`git+${repository}?`));
	for (const [name] of dependencies) {
		expect(lock.package.filter(pkg => pkg.name === name)).toEqual([{ name, source }]);
	}
	for (const pkg of framework) {
		expect(pkg.source, pkg.name).toBe(source);
		await expect(fs.stat(path.join(root, "crates", "vendor", pkg.name))).rejects.toMatchObject({ code: "ENOENT" });
	}
});
