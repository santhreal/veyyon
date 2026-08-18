import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	parseSecretCommand,
	runSecretCommand,
	type SecretCommandRequest,
} from "@veyyon/coding-agent/secrets/secret-command";
import { SecretVault } from "@veyyon/coding-agent/secrets/vault";

/**
 * `SecretVault.add` replaces a same-name entry in the same scope. That is deliberate and it is what
 * makes rotating a credential work: you store `GITHUB_TOKEN` again with a new value and the old one
 * stops being spendable.
 *
 * The problem this suite locks out is that rotating a credential and DESTROYING one by fumbling a
 * name are the same write. Before this, `/secret add` printed the identical
 * `Stored NAME in the SCOPE vault, Nd left.` line for both, so typing a name that happened to
 * collide with an existing secret overwrote a working credential and told the operator nothing had
 * been lost. The value is not recoverable and is never displayed, so there was no way to notice
 * afterwards either.
 *
 * The contract is therefore two-part and both halves are asserted here:
 *  1. `add` REPORTS whether it replaced something, decided inside the scope lock against the same
 *     entry list the write is built from, so it cannot disagree with what was actually written.
 *  2. The reported flag distinguishes a first store from a rotation, and does so per scope, since
 *     the same name in a different scope is a different entry and overwrites nothing.
 */

/** Long enough to clear the obfuscatable-length floor; `add` refuses anything shorter. */
const FIRST_VALUE = "first-secret-value-000000";
const SECOND_VALUE = "second-secret-value-00000";

async function freshVault(): Promise<{ vault: SecretVault; cleanup: () => Promise<void> }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-rotate-secret-"));
	const vault = new SecretVault({
		globalConfigRoot: path.join(root, "global"),
		profileDir: path.join(root, "profile"),
		projectDir: path.join(root, "project"),
	});
	return { vault, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

describe("storing a secret for the first time", () => {
	/**
	 * The baseline. Without this the replacement assertions below could pass against an
	 * implementation that reported `replaced: true` unconditionally.
	 */
	it("reports that it replaced nothing", async () => {
		const { vault, cleanup } = await freshVault();
		try {
			const stored = await vault.add({ name: "GITHUB_TOKEN", value: FIRST_VALUE, scope: "profile" });
			expect(stored.replaced).toBe(false);
			expect(stored.name).toBe("GITHUB_TOKEN");
			expect(stored.scope).toBe("profile");
		} finally {
			await cleanup();
		}
	});

	/**
	 * A generated name cannot collide with an existing entry, because it is chosen inside the lock
	 * against the current names. An unnamed add reporting a replacement would be a false alarm on
	 * the one path where overwriting is impossible.
	 */
	it("reports no replacement for an unnamed entry, whose name is generated to be free", async () => {
		const { vault, cleanup } = await freshVault();
		try {
			await vault.add({ value: FIRST_VALUE, scope: "profile" });
			const second = await vault.add({ value: SECOND_VALUE, scope: "profile" });
			expect(second.replaced).toBe(false);
		} finally {
			await cleanup();
		}
	});
});

describe("storing a secret whose name is already taken", () => {
	/**
	 * THE REGRESSION. This is the write that silently destroyed a credential. The flag is what lets
	 * `/secret add` say "Replaced" instead of "Stored".
	 */
	it("reports that it replaced the entry that was already there", async () => {
		const { vault, cleanup } = await freshVault();
		try {
			await vault.add({ name: "GITHUB_TOKEN", value: FIRST_VALUE, scope: "profile" });
			const rotated = await vault.add({ name: "GITHUB_TOKEN", value: SECOND_VALUE, scope: "profile" });
			expect(rotated.replaced).toBe(true);
		} finally {
			await cleanup();
		}
	});

	/**
	 * The rotation must actually take effect, not merely be announced. A flag that said "Replaced"
	 * while the old value stayed spendable would be worse than the silence it replaced.
	 */
	it("leaves exactly one entry, holding the new value", async () => {
		const { vault, cleanup } = await freshVault();
		try {
			await vault.add({ name: "GITHUB_TOKEN", value: FIRST_VALUE, scope: "profile" });
			await vault.add({ name: "GITHUB_TOKEN", value: SECOND_VALUE, scope: "profile" });
			const entries = await vault.load();
			const matching = entries.filter(entry => entry.name === "GITHUB_TOKEN");
			expect(matching).toHaveLength(1);
			expect(matching[0]?.value).toBe(SECOND_VALUE);
		} finally {
			await cleanup();
		}
	});

	/**
	 * Names are normalised before they are compared, so `github-token` and `GITHUB_TOKEN` are the
	 * same entry. If the replacement check ran on the raw input instead of the normalised name it
	 * would report a fresh store while overwriting, which is exactly the silent case being closed.
	 */
	it("reports a replacement even when the name was typed in a different form", async () => {
		const { vault, cleanup } = await freshVault();
		try {
			await vault.add({ name: "GITHUB_TOKEN", value: FIRST_VALUE, scope: "profile" });
			const rotated = await vault.add({ name: "github-token", value: SECOND_VALUE, scope: "profile" });
			expect(rotated.replaced).toBe(true);
			expect(rotated.name).toBe("GITHUB_TOKEN");
		} finally {
			await cleanup();
		}
	});
});

describe("the same name in a different scope", () => {
	/**
	 * Scopes are separate stores, so this overwrites nothing and must not claim to. Reporting a
	 * replacement here would tell the operator a credential was destroyed when it is still there,
	 * which is the opposite failure and just as misleading.
	 */
	it("reports no replacement, because a different scope is a different entry", async () => {
		const { vault, cleanup } = await freshVault();
		try {
			await vault.add({ name: "GITHUB_TOKEN", value: FIRST_VALUE, scope: "profile" });
			const projectScoped = await vault.add({ name: "GITHUB_TOKEN", value: SECOND_VALUE, scope: "project" });
			expect(projectScoped.replaced).toBe(false);
			expect(projectScoped.scope).toBe("project");
		} finally {
			await cleanup();
		}
	});

	/**
	 * Documents the consequence of the case above, and is the reason it is not simply "fine": both
	 * entries exist, `load()` dedupes by name with the narrowest scope winning, so the profile entry
	 * is SHADOWED and cannot be seen through `load()` at all. Pinned so that if the shadowing rule
	 * is ever changed, this states what the old behavior was rather than leaving it to be rediscovered.
	 */
	it("shadows the wider scope, so only the narrowest entry of that name is visible", async () => {
		const { vault, cleanup } = await freshVault();
		try {
			await vault.add({ name: "GITHUB_TOKEN", value: FIRST_VALUE, scope: "profile" });
			await vault.add({ name: "GITHUB_TOKEN", value: SECOND_VALUE, scope: "project" });
			const visible = (await vault.load()).filter(entry => entry.name === "GITHUB_TOKEN");
			expect(visible).toHaveLength(1);
			expect(visible[0]?.scope).toBe("project");
			expect(visible[0]?.value).toBe(SECOND_VALUE);
		} finally {
			await cleanup();
		}
	});
});

/**
 * The confirmation wording, read on the surface a rotation is actually expressed on.
 *
 * NO SURFACE SPELLS A ROTATION AS ONE LINE any more. In a terminal the argument line IS the
 * credential, so `add GITHUB_TOKEN <value>` is one long value; on a client `add` reads no words at
 * all, because whatever followed it might be the credential and the line is retained in a request
 * log. A rotation is therefore a value plus a name that arrive from two places -- the value from the
 * line or a masked field, the name from the field afterwards -- and the REQUEST is what these rows
 * build, since that is the object both paths converge on before anything is written.
 *
 * `runSecretCommand` is exported and takes that request, so building it here is the production shape
 * and not a shortcut around the parser: the parser's own readings are pinned in the grammar suites.
 */
const rotating = (value: string): SecretCommandRequest => ({
	...parseSecretCommand(`add ${value}`, "tui"),
	name: "GITHUB_TOKEN",
});
describe("what the operator is told", () => {
	/**
	 * The whole point of the flag: it has to reach the confirmation the operator reads. A correct
	 * `replaced` that nothing prints leaves the silent-overwrite bug exactly where it was.
	 */
	it("says Replaced, and that the previous value is gone, when a rotation overwrote one", async () => {
		const { vault, cleanup } = await freshVault();
		try {
			const context = {
				vault,
				readEnv: () => undefined,
				defaultTtl: 24 * 60 * 60 * 1000,
				now: Date.now(),
				surface: "noninteractive" as const,
			};
			await runSecretCommand(rotating(FIRST_VALUE), context);
			const rotation = await runSecretCommand(rotating(SECOND_VALUE), context);

			expect(rotation.message).toContain("Replaced GITHUB_TOKEN");
			expect(rotation.message).toContain("The previous value is gone");
			expect(rotation.message).not.toContain("Stored GITHUB_TOKEN");
		} finally {
			await cleanup();
		}
	});

	/**
	 * The counterpart. A first store must still read as a plain store, or the warning becomes noise
	 * that appears on every add and stops carrying information.
	 */
	it("says Stored, and never mentions a previous value, on a first store", async () => {
		const { vault, cleanup } = await freshVault();
		try {
			const first = await runSecretCommand(rotating(FIRST_VALUE), {
				vault,
				readEnv: () => undefined,
				defaultTtl: 24 * 60 * 60 * 1000,
				now: Date.now(),
				surface: "noninteractive" as const,
			});

			expect(first.message).toContain("Stored GITHUB_TOKEN");
			expect(first.message).not.toContain("Replaced");
			expect(first.message).not.toContain("previous value");
		} finally {
			await cleanup();
		}
	});

	/**
	 * A rotation confirmation is still a confirmation printed to a terminal, and the credential it
	 * just replaced must not appear in it. Checked against both values, since the message now talks
	 * about an old entry as well as the new one.
	 */
	it("echoes neither the old nor the new credential", async () => {
		const { vault, cleanup } = await freshVault();
		try {
			const context = {
				vault,
				readEnv: () => undefined,
				defaultTtl: 24 * 60 * 60 * 1000,
				now: Date.now(),
				surface: "noninteractive" as const,
			};
			await runSecretCommand(rotating(FIRST_VALUE), context);
			const rotation = await runSecretCommand(rotating(SECOND_VALUE), context);

			expect(rotation.message).not.toContain(FIRST_VALUE);
			expect(rotation.message).not.toContain(SECOND_VALUE);
			expect(rotation.agentNotice ?? "").not.toContain(FIRST_VALUE);
			expect(rotation.agentNotice ?? "").not.toContain(SECOND_VALUE);
		} finally {
			await cleanup();
		}
	});
});
