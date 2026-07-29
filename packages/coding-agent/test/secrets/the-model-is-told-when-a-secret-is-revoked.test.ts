/**
 * The model has to be TOLD when a stored credential is taken away.
 *
 * WHY THIS SUITE EXISTS. `/secret add` announced itself to the model — "reference it as
 * `#GITHUB_TOKEN#`" — and `/secret rm` announced nothing at all. The vault is durable and the
 * conversation is not reconciled against it, so after a revocation the model still carried the
 * introduction in its history and kept writing the placeholder. Nothing expanded it any more, so
 * the LITERAL text `#GITHUB_TOKEN#` was handed to the command as if it were a credential, and the
 * only feedback was an authentication failure that explained nothing. The absence of a name is a
 * weak signal a model reliably fails to notice, so the revocation is now stated outright.
 *
 * Three separate things are locked here, because each failed independently:
 *   1. `rm` and `extend` produce a notice at all, and read-only subcommands still produce none.
 *   2. The notice reaches BOTH sinks — the live agent and the persisted session. Either alone is a
 *      bug: live-only loses it on resume, file-only loses it for the running conversation.
 *   3. A revocation survives secret protection being OFF. That was a silent drop: the surface
 *      returned early on `!secretsEnabled` before it ever looked at the notice, and that state is
 *      exactly the one where a stale placeholder does the most damage, because with no obfuscator
 *      nothing is substituted at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets";
import { resolveVaultLocations, SecretVault, type VaultLocations } from "@veyyon/coding-agent/secrets/vault";
import { OperatorNotices } from "@veyyon/coding-agent/session/operator-notices";
import { runSecretCommandForSurface } from "@veyyon/coding-agent/slash-commands/helpers/secret";

/**
 * A credential distinctive enough that any leak into a notice is unambiguous, and long enough to
 * clear the obfuscator's protectability floor.
 */
const VALUE = "ghp_revocationNoticeTestCredential42";

/** One message as `tellTheAgent` builds it. Asserted structurally, not just for its text. */
interface DeliveredMessage {
	role: string;
	attribution: string;
	timestamp: number;
	content: Array<{ type: string; text: string }>;
}

let home: string;
let project: string;
let locations: VaultLocations;

beforeEach(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-revoke-home-"));
	project = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-revoke-proj-"));
	locations = resolveVaultLocations({
		globalConfigRoot: home,
		agentDir: path.join(home, "profiles", "default"),
		cwd: project,
	});
});

afterEach(async () => {
	await fs.rm(home, { recursive: true, force: true });
	await fs.rm(project, { recursive: true, force: true });
});

interface Harness {
	/** Everything handed to the live conversation, in order. */
	agentMessages: DeliveredMessage[];
	/** Everything appended to the persisted session, in order. */
	sessionMessages: DeliveredMessage[];
	obfuscator: SecretObfuscator | undefined;
	port: Parameters<typeof runSecretCommandForSurface>[1];
}

/**
 * A port over real temp-directory vault files.
 *
 * `protection: "off"` models the state the early return used to swallow notices in: the settings
 * flag may be anything, but the live runtime has no obfuscator, so nothing is substituted.
 */
function harness(options?: { protection?: "off"; promptReturns?: string }): Harness {
	const agentMessages: DeliveredMessage[] = [];
	const sessionMessages: DeliveredMessage[] = [];
	const protectionOn = options?.protection !== "off";
	const obfuscator = protectionOn ? new SecretObfuscator([]) : undefined;
	const settingValues: Record<string, unknown> = {
		"secrets.enabled": protectionOn,
		"secrets.auditLog": false,
		"secrets.defaultTtl": "1d",
	};

	const session = {
		obfuscator,
		secretsEnabled: obfuscator !== undefined,
		operatorNotices: new OperatorNotices(),
		agent: { appendMessage: (message: DeliveredMessage) => agentMessages.push(message) },
		refreshSecrets: async () => {
			if (obfuscator === undefined) return;
			const named = await new SecretVault(locations).namedSecrets();
			const live = new Set(named.map(secret => secret.name));
			for (const secret of named) obfuscator.addNamedSecret(secret.name, secret.value, secret.expiresAt);
			for (const name of obfuscator.namedSecretNames()) {
				if (!live.has(name)) obfuscator.forgetNamedSecret(name);
			}
		},
	};

	return {
		agentMessages,
		sessionMessages,
		obfuscator,
		port: {
			session,
			sessionManager: { appendMessage: (message: DeliveredMessage) => sessionMessages.push(message) },
			settings: {
				get: (key: string) => settingValues[key],
				set: (key: string, value: unknown) => {
					settingValues[key] = value;
				},
			},
			cwd: project,
			globalConfigRoot: home,
			agentDir: path.join(home, "profiles", "default"),
			promptForValue: async () => options?.promptReturns,
		} as unknown as Parameters<typeof runSecretCommandForSurface>[1],
	};
}

/** Put a credential in the vault directly, so a revocation test is not gated on the add path. */
async function store(name: string, value = VALUE): Promise<void> {
	await new SecretVault(locations).add({ name, value, scope: "profile", ttl: 86_400_000 });
}

/** The notice texts a sink received, so both sinks can be compared as plain strings. */
function texts(messages: readonly DeliveredMessage[]): string[] {
	return messages.map(message => message.content.map(part => part.text).join(""));
}

describe("revoking a secret", () => {
	/**
	 * The core regression. Before this, `/secret rm` delivered nothing and the model was left
	 * believing the placeholder still worked.
	 */
	it("tells the model the placeholder is gone", async () => {
		await store("github-token");
		const h = harness();
		await h.port.session.refreshSecrets();

		await runSecretCommandForSurface("rm github-token", h.port);

		expect(texts(h.agentMessages)).toHaveLength(1);
		const notice = texts(h.agentMessages)[0] ?? "";
		expect(notice).toContain("#GITHUB_TOKEN#");
		expect(notice).toContain("revoked");
		expect(notice).toContain("no longer available");
		expect(notice).toContain("stop using it");
	});

	/**
	 * Naming the secret is not enough. The failure mode is a model that keeps emitting the
	 * placeholder and gets an unexplained auth error, so the notice has to say what the emitted
	 * text now IS: literal characters, not a credential.
	 */
	it("explains that emitting it now sends a literal placeholder", async () => {
		await store("github-token");
		const h = harness();

		await runSecretCommandForSurface("rm GITHUB_TOKEN", h.port);

		const notice = texts(h.agentMessages)[0] ?? "";
		expect(notice).toContain("no longer replaced with a real value");
		expect(notice).toContain("literal");
		expect(notice).toContain("rather than a credential");
	});

	/**
	 * Both sinks or it is a bug: the live agent alone loses the revocation on resume, the session
	 * file alone leaves the running conversation still spending a dead placeholder.
	 */
	it("delivers the identical notice to the live agent and the persisted session", async () => {
		await store("github-token");
		const h = harness();

		await runSecretCommandForSurface("rm github-token", h.port);

		expect(texts(h.sessionMessages)).toEqual(texts(h.agentMessages));
		expect(h.sessionMessages).toHaveLength(1);
	});

	/** The notice must be attributable and replayable, not a bare string in an unknown slot. */
	it("delivers it as a user-attributed developer message", async () => {
		await store("github-token");
		const h = harness();

		await runSecretCommandForSurface("rm github-token", h.port);

		const message = h.agentMessages[0];
		expect(message?.role).toBe("developer");
		expect(message?.attribution).toBe("user");
		expect(message?.content.map(part => part.type)).toEqual(["text"]);
		expect(typeof message?.timestamp).toBe("number");
	});

	/**
	 * The name reaches the model in the same normalised form the placeholder uses. A notice about
	 * `#github-token#` would name a placeholder that never existed.
	 */
	it("names the normalised placeholder, whatever case the operator typed", async () => {
		await store("github-token");
		const h = harness();

		await runSecretCommandForSurface("rm github-token", h.port);

		const notice = texts(h.agentMessages)[0] ?? "";
		expect(notice).toContain("#GITHUB_TOKEN#");
		expect(notice).not.toContain("#github-token#");
	});

	/** A revocation that did not happen must not be announced: the vault still holds the name. */
	it("says nothing when the secret was not there to remove", async () => {
		const h = harness();

		const failure = await runSecretCommandForSurface("rm never-stored", h.port).catch(error => error as Error);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("No secret named NEVER_STORED is stored");
		expect(h.agentMessages).toEqual([]);
		expect(h.sessionMessages).toEqual([]);
	});

	/**
	 * Removing one name must not cast doubt on the others. A notice that named a still-live secret
	 * would revoke a working credential in the model's head.
	 */
	it("revokes only the name that was removed", async () => {
		await store("github-token");
		await store("npm-token", "npm_revocationNoticeSecondCredential77");
		const h = harness();

		await runSecretCommandForSurface("rm github-token", h.port);

		const notice = texts(h.agentMessages)[0] ?? "";
		expect(notice).toContain("#GITHUB_TOKEN#");
		expect(notice).not.toContain("NPM_TOKEN");
	});
});

describe("extending a secret", () => {
	/** Silence after `extend` left the model unsure whether a warned-about secret had lapsed. */
	it("confirms the placeholder is still usable", async () => {
		await store("github-token");
		const h = harness();

		await runSecretCommandForSurface("extend github-token --ttl 7d", h.port);

		const notice = texts(h.agentMessages)[0] ?? "";
		expect(notice).toContain("#GITHUB_TOKEN#");
		expect(notice).toContain("still");
		expect(notice).not.toContain("no longer");
		expect(notice).not.toContain("stop using");
	});

	/** Same two-sink rule as revocation. */
	it("delivers the identical notice to both sinks", async () => {
		await store("github-token");
		const h = harness();

		await runSecretCommandForSurface("extend github-token --ttl 7d", h.port);

		expect(texts(h.sessionMessages)).toEqual(texts(h.agentMessages));
		expect(h.agentMessages).toHaveLength(1);
	});

	/**
	 * The duration is deliberately absent. A "7d left" pinned into conversation history is a claim
	 * that goes stale and then misleads; the operator has the exact time left on screen instead.
	 */
	it("does not pin a lifetime into the conversation", async () => {
		await store("github-token");
		const h = harness();

		await runSecretCommandForSurface("extend github-token --ttl 7d", h.port);

		const notice = texts(h.agentMessages)[0] ?? "";
		expect(notice).not.toContain("7d");
		expect(notice).not.toContain("left");
	});

	/** An extend that failed changed nothing, so it must claim nothing. */
	it("says nothing when the secret does not exist", async () => {
		const h = harness();

		await runSecretCommandForSurface("extend never-stored --ttl 7d", h.port).catch(() => undefined);

		expect(h.agentMessages).toEqual([]);
		expect(h.sessionMessages).toEqual([]);
	});
});

describe("subcommands that change nothing", () => {
	/**
	 * Guards against the opposite failure. Now that three subcommands notify, it would be easy for
	 * a later edit to notify on reads too and spend context re-describing an unchanged vault on
	 * every `/secret list`.
	 */
	it("send the model nothing at all", async () => {
		await store("github-token");

		for (const args of ["list", "log", "help", ""]) {
			const h = harness();

			await runSecretCommandForSurface(args, h.port).catch(() => undefined);

			expect(texts(h.agentMessages)).toEqual([]);
			expect(texts(h.sessionMessages)).toEqual([]);
		}
	});

	/** `/secret list` names every live placeholder to the OPERATOR, and no one else. */
	it("still show the operator the inventory", async () => {
		await store("github-token");
		const h = harness();

		const outcome = await runSecretCommandForSurface("list", h.port);

		expect(outcome.message).toContain("#GITHUB_TOKEN#");
		expect(h.agentMessages).toEqual([]);
	});
});

describe("a notice", () => {
	/**
	 * The whole point of the placeholder is that the value never leaves the machine. A notice is
	 * the one new string on the path to the provider, so it is checked against a value that would
	 * be unmistakable if it leaked.
	 */
	it("never contains the stored value", async () => {
		await store("github-token");
		const h = harness();

		const added = await runSecretCommandForSurface("add other-token", harness({ promptReturns: VALUE }).port);
		const extended = await runSecretCommandForSurface("extend github-token --ttl 7d", h.port);
		const removed = await runSecretCommandForSurface("rm github-token", h.port);

		for (const text of [...texts(h.agentMessages), ...texts(h.sessionMessages)]) {
			expect(text).not.toContain(VALUE);
		}
		for (const outcome of [added, extended, removed]) {
			expect(outcome.message).not.toContain(VALUE);
		}
		expect(h.agentMessages).toHaveLength(2);
	});

	/** A value that happens to look like a placeholder must not survive into the notice either. */
	it("never contains a value shaped like a placeholder", async () => {
		const disguised = "#GITHUB_TOKEN#-but-actually-the-real-credential-9182";
		await store("github-token", disguised);
		const h = harness();

		await runSecretCommandForSurface("rm github-token", h.port);

		for (const text of texts(h.agentMessages)) expect(text).not.toContain(disguised);
	});
});

/**
 * The silent-drop bug.
 *
 * `runSecretCommandForSurface` returns early when the live runtime has no obfuscator, and that
 * return sat BEFORE the notice block, so with protection off every notice was discarded. For an
 * offer of a placeholder that is right — advertising an expansion the runtime cannot perform would
 * be a lie. For a revocation it is exactly backwards: with nothing being substituted, every stale
 * `#NAME#` the model writes reaches the command verbatim, so that is when the model most needs to
 * be told to stop.
 */
describe("with secret protection off", () => {
	/** The fix. A revocation is true in every state and must outlive the early return. */
	it("still delivers a revocation to both sinks", async () => {
		await store("github-token");
		const h = harness({ protection: "off" });

		const outcome = await runSecretCommandForSurface("rm github-token", h.port);

		expect(outcome.message).toContain("Secret protection is OFF");
		const notice = texts(h.agentMessages)[0] ?? "";
		expect(notice).toContain("#GITHUB_TOKEN#");
		expect(notice).toContain("stop using it");
		expect(texts(h.sessionMessages)).toEqual([notice]);
	});

	/** The other half: an offer of a placeholder that cannot expand is withheld, not delivered. */
	it("withholds the notice that a new secret is usable", async () => {
		const h = harness({ protection: "off", promptReturns: VALUE });

		const outcome = await runSecretCommandForSurface("add fresh-token", h.port);

		expect(outcome.message).toContain("Secret protection is OFF");
		expect(h.agentMessages).toEqual([]);
		expect(h.sessionMessages).toEqual([]);
	});

	/** `extend` claims availability too, so it is withheld on the same grounds as `add`. */
	it("withholds the notice that an extended secret is still usable", async () => {
		await store("github-token");
		const h = harness({ protection: "off" });

		await runSecretCommandForSurface("extend github-token --ttl 7d", h.port);

		expect(h.agentMessages).toEqual([]);
		expect(h.sessionMessages).toEqual([]);
	});

	/** The operator still gets the protection warning; suppression is a model-facing decision. */
	it("still tells the operator what happened", async () => {
		await store("github-token");
		const h = harness({ protection: "off" });

		const outcome = await runSecretCommandForSurface("rm github-token", h.port);

		expect(outcome.message).toContain("Removed GITHUB_TOKEN from the profile vault.");
		expect(outcome.message).toContain('Turn on "Hide Secrets" in /settings.');
	});
});

describe("with secret protection on", () => {
	/** The runtime and the notice must agree: the placeholder really has stopped expanding. */
	it("the revoked placeholder no longer expands", async () => {
		await store("github-token");
		const h = harness();
		await h.port.session.refreshSecrets();
		expect(h.obfuscator?.hasNamedSecret("GITHUB_TOKEN")).toBe(true);

		await runSecretCommandForSurface("rm github-token", h.port);

		expect(h.obfuscator?.hasNamedSecret("GITHUB_TOKEN")).toBe(false);
		expect(texts(h.agentMessages)[0]).toContain("#GITHUB_TOKEN#");
	});

	/** An extended secret keeps working, which is what its notice claims. */
	it("the extended placeholder still expands", async () => {
		await store("github-token");
		const h = harness();

		await runSecretCommandForSurface("extend github-token --ttl 7d", h.port);

		expect(h.obfuscator?.hasNamedSecret("GITHUB_TOKEN")).toBe(true);
	});
});
