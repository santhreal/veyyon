import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { Settings } from "../../../../config/settings";
import { collectEnvSecrets } from "../../../../secrets";
import { BUNDLED_ENV_KEYWORDS, buildEnvSecretPattern } from "../../../../secrets/env-keywords";
import { SECRET_ORIGINS, type SecretEntry, SecretObfuscator } from "../../../../secrets/obfuscator";
import type { AgentSession } from "../../../../session/agent-session";
import { getThemeByName, setThemeInstance } from "../../../../theme/theme";
import { renderSegment } from "./segments";
import type { SegmentContext } from "./types";

/**
 * WHY: the footer said `3 secrets` in a session whose `/secret list` said one active secret, and
 * the operator read the footer as broken. Neither number was wrong. A session builds its
 * protection from `secrets.yml`, the vault, AND every environment variable whose name matches an
 * env keyword, and `collectEnvSecrets` registers an auto-detected value with NO name -- so it is
 * masked on the way out but cannot be spent as `#NAME#` and the list has nothing to call it. The
 * chip added the two together under the word "secrets".
 *
 * THE CLASS: any surface that reports a count of protection has to say which question it answered.
 * These cases pin the split at the one function both surfaces read (`liveSecrets`) rather than at
 * the chip, sweep every member of `SECRET_ORIGINS` so a fourth source cannot inherit an answer
 * silently, and pin exactly which origins can carry a name.
 *
 * WHAT IT DOES NOT CATCH: it does not prove `/secret list`'s own wording, which is built in the
 * secret command and asserted by that command's suites; it asserts the chip's leading number
 * equals the count of NAMED values, which is the quantity the list enumerates. It also says
 * nothing about how the chip is dropped when the footline runs out of width.
 */

const LONG_ENOUGH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** A value per slot, all distinct, all long enough to be obfuscatable. */
const value = (slot: string): string => `${slot}-${LONG_ENOUGH}`;

function obfuscatorFor(entries: SecretEntry[]): SecretObfuscator {
	return new SecretObfuscator(entries, { placeholderKey: Buffer.alloc(32, 7) });
}

function chip(obfuscator: SecretObfuscator | undefined): string {
	const ctx = {
		session: { obfuscator } as unknown as AgentSession,
		activeRepo: null,
		width: 200,
		options: {},
	} as unknown as SegmentContext;
	const rendered = renderSegment("secrets", ctx);
	return rendered.visible ? stripAnsi(rendered.content) : "";
}

const envVars: string[] = [];

/** Put a keyword-matching variable in the environment and read it back through the real collector. */
function envEntries(name: string, content: string): SecretEntry[] {
	process.env[name] = content;
	envVars.push(name);
	return collectEnvSecrets(buildEnvSecretPattern(BUNDLED_ENV_KEYWORDS)).filter(entry => entry.content === content);
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

afterEach(() => {
	for (const name of envVars.splice(0)) delete process.env[name];
});

describe("what the footer counts", () => {
	it("counts a named credential under the word the list uses", () => {
		const live = obfuscatorFor([
			{ type: "plain", content: value("one"), name: "RELEASE_SIGNATURE", origin: "vault" },
		]).liveSecrets();
		expect(live).toMatchObject({ count: 1, named: 1 });
		expect(
			chip(obfuscatorFor([{ type: "plain", content: value("one"), name: "RELEASE_SIGNATURE", origin: "vault" }])),
		).toBe("1 secret");
	});

	it("never counts an auto-detected environment value as a secret the list could name", () => {
		// The exact shape of the reported defect: one stored credential beside two keyword-matching
		// variables printed `3 secrets` next to a list of one.
		const entries: SecretEntry[] = [
			{ type: "plain", content: value("stored"), name: "RELEASE_SIGNATURE", origin: "vault" },
			...envEntries("LOCAL_LLM_KEY", value("llm")),
			...envEntries("VEYYON_DEMO_SECRET", value("demo")),
		];
		expect(entries).toHaveLength(3);
		const live = obfuscatorFor(entries).liveSecrets();
		expect(live).toMatchObject({ count: 3, named: 1 });
		expect(chip(obfuscatorFor(entries))).toBe("1 secret · 2 masked");
	});

	it("says only what it has when nothing carries a name", () => {
		const entries = envEntries("LOCAL_LLM_KEY", value("llm"));
		expect(entries).toHaveLength(1);
		expect(obfuscatorFor(entries).liveSecrets()).toMatchObject({ count: 1, named: 0 });
		expect(chip(obfuscatorFor(entries))).toBe("1 masked");
	});

	it("stays silent when nothing is live, and when there is no runtime at all", () => {
		expect(chip(obfuscatorFor([]))).toBe("");
		expect(chip(undefined)).toBe("");
	});

	it("counts one credential once, however many placeholders reach it", () => {
		// A value that carries a name AND an opaque form is one credential the operator stored once.
		const shared = value("shared");
		const obfuscator = obfuscatorFor([
			{ type: "plain", content: shared, name: "TOKEN_A", origin: "vault" },
			{ type: "plain", content: shared, origin: "config" },
		]);
		expect(obfuscator.liveSecrets()).toMatchObject({ count: 1, named: 1 });
		expect(chip(obfuscator)).toBe("1 secret");
	});

	it("plurals both halves on their own count", () => {
		const entries: SecretEntry[] = [
			{ type: "plain", content: value("a"), name: "TOKEN_A", origin: "vault" },
			{ type: "plain", content: value("b"), name: "TOKEN_B", origin: "vault" },
			...envEntries("LOCAL_LLM_KEY", value("llm")),
		];
		expect(chip(obfuscatorFor(entries))).toBe("2 secrets · 1 masked");
	});
});

describe("every source a session builds protection from", () => {
	/**
	 * Swept from `SECRET_ORIGINS` rather than from a list written here, and the swept list is then
	 * pinned against a literal one: comparing the result only against the constant it came from is
	 * green by construction, so a fourth source would have joined the sweep and answered for
	 * itself. The literal is what turns this red until somebody records what the new source does.
	 */
	it("is counted as named exactly when its entries can carry a name", () => {
		expect([...SECRET_ORIGINS]).toEqual(["vault", "environment", "config"]);
		const nameable: string[] = [];
		for (const origin of SECRET_ORIGINS) {
			const live = obfuscatorFor([{ type: "plain", content: value(origin), name: "TOKEN_X", origin }]).liveSecrets();
			expect(live, `${origin} with a name must be live`).toMatchObject({ count: 1 });
			if (live.named === 1) nameable.push(origin);
			const unnamed = obfuscatorFor([{ type: "plain", content: value(origin), origin }]).liveSecrets();
			expect(unnamed, `${origin} without a name is masked, never named`).toMatchObject({
				count: 1,
				named: 0,
			});
		}
		// A name is carried by the ENTRY, so every origin can hold one; what differs is whether the
		// source that builds those entries ever sets it, which the next case pins for the one source
		// that never does.
		expect(nameable).toEqual(["vault", "environment", "config"]);
	});

	it("gives an environment value no name, which is why the two counts differ at all", () => {
		const entries = envEntries("VEYYON_DEMO_SECRET", value("env"));
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ type: "plain", origin: "environment", mode: "obfuscate" });
		expect(entries[0]?.name).toBeUndefined();
	});
});
