/**
 * Auth-broker global settings bindings (PROF-4). The Global tab surfaces
 * `authBrokerUrl` (plain) and `authBrokerToken` (write-only, masked); the
 * Settings singleton routes both through GLOBAL_SETTING_BINDINGS to the one
 * config owner in @veyyon/utils. Pinned here: the url round-trips to
 * `auth.broker.url` in the global config.yml, the token's plaintext NEVER
 * reaches a read (only the mask), and saving the untouched mask keeps the
 * stored secret instead of clobbering it — the exact bug ("open the field,
 * press save, token gone") the mask contract exists to prevent.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GLOBAL_RESOURCE_LIMITS } from "@veyyon/utils/dirs";
import YAML from "yaml";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../utils/test/helpers/isolated-config-root";
import {
	AUTH_BROKER_TOKEN_MASK,
	GLOBAL_SETTING_BINDINGS,
	GLOBAL_SETTINGS,
} from "../src/config/settings-domains/global";

let isolated: IsolatedConfigRoot | undefined;
let configRoot: string;

beforeEach(() => {
	// A temp root rather than a dot-directory name under the real home: this suite writes
	// a broker token, and the name form put it in the developer's actual home directory.
	isolated = enterIsolatedConfigRoot("auth-broker-binding");
	configRoot = isolated.root;
});

afterEach(() => {
	isolated?.restore();
	isolated = undefined;
});

const urlBinding = GLOBAL_SETTING_BINDINGS.authBrokerUrl!;
const tokenBinding = GLOBAL_SETTING_BINDINGS.authBrokerToken!;

function readConfig(): Record<string, unknown> {
	return YAML.parse(readFileSync(join(configRoot, "config.yml"), "utf8")) as Record<string, unknown>;
}

describe("authBrokerUrl binding", () => {
	test("round-trips through the global config file", () => {
		expect(urlBinding.read()).toBe("");
		urlBinding.write("https://broker.example.com");
		expect(readConfig()).toEqual({ auth: { broker: { url: "https://broker.example.com" } } });
		expect(urlBinding.read()).toBe("https://broker.example.com");
	});

	test("every global setting key has a binding, and every extra binding is a machine limit", () => {
		const bindings = Object.keys(GLOBAL_SETTING_BINDINGS).sort();
		for (const key of Object.keys(GLOBAL_SETTINGS)) expect(bindings).toContain(key);
		// A global-scoped setting declared in another domain still binds here: the
		// machine-wide resource limits are declared beside the per-session limit
		// they pair with, in the resources domain. The exception is derived from the
		// limit list rather than written out, so a new resource needs no edit here
		// and any other unexplained binding fails this equality.
		expect(bindings.filter(key => !(key in GLOBAL_SETTINGS))).toEqual(
			GLOBAL_RESOURCE_LIMITS.map(limit => `machine.${limit}`).sort(),
		);
	});
});

describe("authBrokerToken binding — the write-only mask contract", () => {
	test("a stored token reads as the mask, never the plaintext", () => {
		expect(tokenBinding.read()).toBe("");
		tokenBinding.write("super-secret-token");
		expect(readConfig()).toEqual({ auth: { broker: { token: "super-secret-token" } } });
		expect(tokenBinding.read()).toBe(AUTH_BROKER_TOKEN_MASK);
		expect(String(tokenBinding.read())).not.toContain("super-secret");
	});

	test("saving the untouched mask keeps the stored token (open+save must not destroy it)", () => {
		tokenBinding.write("super-secret-token");
		tokenBinding.write(AUTH_BROKER_TOKEN_MASK);
		expect(readConfig()).toEqual({ auth: { broker: { token: "super-secret-token" } } });
	});

	test("a new value replaces the token; clearing the field deletes it", () => {
		tokenBinding.write("first-token");
		tokenBinding.write("second-token");
		expect(readConfig()).toEqual({ auth: { broker: { token: "second-token" } } });
		tokenBinding.write("");
		expect(tokenBinding.read()).toBe("");
		// The file is gone entirely (no empty stub) once nothing else is stored.
		expect(() => readConfig()).toThrow();
	});

	test("url and token coexist and clear independently", () => {
		urlBinding.write("https://broker.example.com");
		tokenBinding.write("tok");
		tokenBinding.write("");
		expect(readConfig()).toEqual({ auth: { broker: { url: "https://broker.example.com" } } });
	});
});

describe("auth-broker settings schema entries", () => {
	test("both settings are global-scoped strings on the Global tab's Auth Broker group", () => {
		// Locks the surfacing: without scope "global" the values would silently
		// persist to the profile store instead of ~/.veyyon/config.yml.
		for (const key of ["authBrokerUrl", "authBrokerToken"] as const) {
			const entry = GLOBAL_SETTINGS[key];
			expect(entry.type).toBe("string");
			expect(entry.ui.tab).toBe("global");
			expect(entry.ui.scope).toBe("global");
			expect(entry.ui.group).toBe("Auth Broker");
		}
		// The write-only contract is stated where the operator reads it.
		expect(GLOBAL_SETTINGS.authBrokerToken.ui.description).toContain("never echoed");
	});
});
