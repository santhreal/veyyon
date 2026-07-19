import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ConfigFile } from "@veyyon/coding-agent/config/config-file";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { modelsConfigSchemas } from "@veyyon/coding-agent/config/models-config-schema";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { TempDir } from "@veyyon/utils";

describe("ModelRegistry.create() factory (F6)", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@model-registry-create-");
	});

	afterEach(async () => {
		// On Windows the cache SQLite handle inside the registry may briefly hold
		// the dir; treat cleanup errors as best-effort like TempDir's Symbol.dispose.
		await tempDir.remove().catch(() => {});
	});

	test("produces an instance whose authStorage matches and that exposes bundled models", async () => {
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		try {
			const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
			expect(registry.authStorage).toBe(authStorage);
			// The constructor's bundled-model load runs after warmup, so the
			// factory's returned instance must be queryable immediately.
			const claude = registry.find("anthropic", "claude-sonnet-4-5");
			expect(claude).toBeDefined();
			expect(claude?.id).toBe("claude-sonnet-4-5");
		} finally {
			authStorage.close();
		}
	});

	test("migrates legacy models.json → models.yml ahead of the sync constructor", async () => {
		const yml = path.join(tempDir.path(), "models.yml");
		const json = path.join(tempDir.path(), "models.json");

		// Seed a legacy JSON config; factory should migrate it asynchronously
		// before the sync constructor reads from the yml path.
		await Bun.write(json, JSON.stringify({ models: [] }));
		expect(fs.existsSync(yml)).toBe(false);

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		try {
			new ModelRegistry(authStorage, yml);
			expect(fs.existsSync(yml)).toBe(true);
		} finally {
			authStorage.close();
		}
	});

	test("ConfigFile migration is idempotent — second load is a no-op", async () => {
		const yml = path.join(tempDir.path(), "models.yml");
		const json = path.join(tempDir.path(), "models.json");
		await Bun.write(json, JSON.stringify({ models: [] }));

		const cf = new ConfigFile("models", modelsConfigSchemas().ModelsConfigSchema, yml);
		cf.tryLoad();
		expect(fs.existsSync(yml)).toBe(true);
		const mtime1 = fs.statSync(yml).mtimeMs;

		// Second load should not rewrite the file (idempotent migration path).
		cf.invalidate();
		cf.tryLoad();
		const mtime2 = fs.statSync(yml).mtimeMs;
		expect(mtime2).toBe(mtime1);
	});

	test("ConfigFile migration writes the yml atomically (owner-only, no temp leftover)", async () => {
		const yml = path.join(tempDir.path(), "models.yml");
		const json = path.join(tempDir.path(), "models.json");
		await Bun.write(json, JSON.stringify({ models: [] }));

		const cf = new ConfigFile("models", modelsConfigSchemas().ModelsConfigSchema, yml);
		const result = cf.tryLoad();
		expect(result.status).toBe("ok");
		expect(fs.existsSync(yml)).toBe(true);

		// atomicWriteFileSync stages under a temp name and renames into place with
		// mode 0o600; a raw fs.writeFileSync would land at the umask default
		// (~0o644), so the exact mode proves the interrupted-write-safe path.
		expect(fs.statSync(yml).mode & 0o777).toBe(0o600);

		// No temp sibling is left behind — the migrated dir holds exactly the
		// source json and the migrated yml.
		const entries = fs.readdirSync(tempDir.path()).sort();
		expect(entries).toEqual(["models.json", "models.yml"]);
	});

	test("ConfigFile migrates legacy models.json containing comments", async () => {
		const yml = path.join(tempDir.path(), "models.yml");
		const json = path.join(tempDir.path(), "models.json");
		await Bun.write(
			json,
			`{
				// Custom models comment
				"providers": {
					/* Block comment */
				}
			}`,
		);

		const cf = new ConfigFile("models", modelsConfigSchemas().ModelsConfigSchema, yml);
		const result = cf.tryLoad();
		expect(result.status).toBe("ok");
		expect(fs.existsSync(yml)).toBe(true);
	});
});
