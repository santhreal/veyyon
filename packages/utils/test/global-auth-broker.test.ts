/**
 * Global auth-broker config owner (PROF-4). These functions are the ONE home
 * for `auth.broker.url` / `auth.broker.token` in `~/.veyyon/config.yml`; the
 * settings UI binding and auth discovery both depend on their exact shape.
 * Pinned here: nested-form writes, legacy flat-key precedence and cleanup,
 * secret non-exposure (the reader returns token PRESENCE, never plaintext),
 * empty-record pruning, and never-throw reads on a corrupt file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { readGlobalAuthBrokerSafe, writeGlobalAuthBrokerToken, writeGlobalAuthBrokerUrl } from "../src/dirs";

let configDirName: string;
let configRoot: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
	// getBaseConfigRoot resolves homedir()/<VEYYON_CONFIG_DIR> per call, so a
	// unique dir name sandboxes every write under the real home (the same
	// pattern profiles.test.ts uses).
	configDirName = `.veyyon-auth-broker-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
	configRoot = join(homedir(), configDirName);
	originalConfigDir = process.env.VEYYON_CONFIG_DIR;
	process.env.VEYYON_CONFIG_DIR = configDirName;
});

afterEach(() => {
	if (originalConfigDir === undefined) delete process.env.VEYYON_CONFIG_DIR;
	else process.env.VEYYON_CONFIG_DIR = originalConfigDir;
	rmSync(configRoot, { recursive: true, force: true });
});

function readConfig(): Record<string, unknown> {
	return YAML.parse(readFileSync(join(configRoot, "config.yml"), "utf8")) as Record<string, unknown>;
}

describe("global auth-broker config owner", () => {
	test("writes the nested form and reads it back (url + token presence, never plaintext)", () => {
		writeGlobalAuthBrokerUrl("https://broker.example.com");
		writeGlobalAuthBrokerToken("super-secret-token");
		expect(readConfig()).toEqual({
			auth: { broker: { url: "https://broker.example.com", token: "super-secret-token" } },
		});
		const read = readGlobalAuthBrokerSafe();
		expect(read).toEqual({ url: "https://broker.example.com", tokenSet: true });
		// The reader's shape has no field that could carry the plaintext.
		expect(JSON.stringify(read)).not.toContain("super-secret-token");
	});

	test("preserves unrelated global keys across writes", () => {
		mkdirSync(configRoot, { recursive: true });
		writeFileSync(join(configRoot, "config.yml"), YAML.stringify({ defaultProfile: "work" }));
		writeGlobalAuthBrokerUrl("https://b.example");
		expect(readConfig()).toEqual({ defaultProfile: "work", auth: { broker: { url: "https://b.example" } } });
	});

	test("nested form wins over the legacy flat key, and a write removes the flat duplicate", () => {
		mkdirSync(configRoot, { recursive: true });
		writeFileSync(
			join(configRoot, "config.yml"),
			YAML.stringify({
				"auth.broker.url": "https://flat.example",
				auth: { broker: { url: "https://nested.example" } },
			}),
		);
		expect(readGlobalAuthBrokerSafe().url).toBe("https://nested.example");
		// Writing re-homes the value: nested only, the shadowing flat key is gone.
		writeGlobalAuthBrokerUrl("https://new.example");
		expect(readConfig()).toEqual({ auth: { broker: { url: "https://new.example" } } });
	});

	test("the legacy flat key alone is still readable (pre-migration configs keep working)", () => {
		mkdirSync(configRoot, { recursive: true });
		writeFileSync(
			join(configRoot, "config.yml"),
			YAML.stringify({ "auth.broker.url": "https://flat.example", "auth.broker.token": "flat-token" }),
		);
		expect(readGlobalAuthBrokerSafe()).toEqual({ url: "https://flat.example", tokenSet: true });
	});

	test("clearing both leaves prunes the empty auth/broker records entirely", () => {
		mkdirSync(configRoot, { recursive: true });
		writeFileSync(join(configRoot, "config.yml"), YAML.stringify({ defaultProfile: "work" }));
		writeGlobalAuthBrokerUrl("https://b.example");
		writeGlobalAuthBrokerToken("tok");
		writeGlobalAuthBrokerUrl(undefined);
		writeGlobalAuthBrokerToken(undefined);
		// No `auth: {}` stub may remain — a stub would read as "configured".
		expect(readConfig()).toEqual({ defaultProfile: "work" });
	});

	test("whitespace-only input clears, and values are stored trimmed", () => {
		writeGlobalAuthBrokerUrl("  https://b.example  ");
		expect(readGlobalAuthBrokerSafe().url).toBe("https://b.example");
		writeGlobalAuthBrokerUrl("   ");
		expect(readGlobalAuthBrokerSafe().url).toBeUndefined();
	});

	test("a corrupt global config reads as unconfigured instead of throwing", () => {
		// Safe-read contract: a broken file must never crash the settings UI;
		// auth discovery re-validates loudly on its own path.
		mkdirSync(configRoot, { recursive: true });
		writeFileSync(join(configRoot, "config.yml"), "auth: [unclosed");
		expect(readGlobalAuthBrokerSafe()).toEqual({ url: undefined, tokenSet: false });
	});
});
