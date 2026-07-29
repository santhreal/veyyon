/**
 * A session that did not watch a credential being stored must still be told it exists.
 *
 * THE DEFECT THIS SUITE LOCKS. The vault is scoped to a profile, a project or the machine, so it
 * PERSISTS across sessions. Knowledge of it did not: the only place the model was ever told
 * `GITHUB_TOKEN` had been stored was the notice emitted in the turn `/secret add` ran in, which
 * lives in that session's history and nowhere else. Start a new session against the same project
 * and the credential is still loaded, still redacting provider traffic, and completely invisible.
 * The prompt carried the generic `#XXXX#` redaction explainer, which explains the FORMAT of a
 * redaction and names no credential at all. A model cannot spend what it does not know is there,
 * so it asks the user for a token they already stored — putting the secret in the transcript,
 * which is the one outcome the vault exists to prevent.
 *
 * The fix is a runtime prompt section rebuilt from the live obfuscator on every base-prompt build,
 * which is why revocation and expiry are tested here too rather than somewhere else: they are not
 * separate features, they are the same section being rebuilt from a runtime that changed. A name
 * the obfuscator no longer returns simply stops being rendered.
 *
 * EVERY CASE ASSERTS THE ABSENCE OF VALUES. A prompt section built from a secret store is the one
 * place a leak would be catastrophic and permanent — the system prompt is cached by the provider —
 * so no case here checks only that the right names appeared.
 */
import { describe, expect, it } from "bun:test";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";
import { renderBanner } from "@veyyon/coding-agent/system-prompt-builder/banner-grammar";
import { renderSecretInventory } from "@veyyon/coding-agent/system-prompt-builder/secret-inventory";

/** Machine-local placeholder key; any fixed 32 bytes work, and none of them reach the prompt. */
const KEY = new Uint8Array(32).fill(23);

const BANNER = renderBanner("AVAILABLE SECRETS");

/**
 * Values long enough to be obfuscatable. Every one is asserted ABSENT from the rendered prompt,
 * and each is distinctive enough that a partial leak (a prefix, a slice) would still be caught by
 * the substring checks below.
 */
const VALUES = {
	github: "ghp-github-token-value-0001",
	stripe: "sk-live-stripe-key-value-002",
	openai: "sk-openai-api-key-value-0003",
} as const;

const EMPTY_TREE = {
	rootPath: "/tmp",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [] as string[],
};

/**
 * The production assembly, with everything unrelated turned off.
 *
 * Goes through `buildSystemPrompt` rather than asserting on the template string, because the
 * question this suite asks is what the MODEL receives: a template that renders correctly into a
 * section the assembler never emits is exactly the failure mode the registry wiring exists to
 * prevent, and only the assembled prompt can tell the two apart.
 */
async function renderPrompt(secretInventory: string | undefined): Promise<string[]> {
	const { systemPrompt } = await buildSystemPrompt({
		toolNames: [],
		contextFiles: [],
		skills: [],
		rules: [],
		workspaceTree: EMPTY_TREE,
		activeRepoContext: null,
		secretsEnabled: secretInventory !== undefined,
		secretInventory,
	});
	return systemPrompt;
}

/** The one assembled block carrying the section banner, or undefined when nothing was emitted. */
function sectionOf(parts: string[]): string | undefined {
	return parts.find(part => part.startsWith(BANNER));
}

/** The whole prompt as one string, for absence assertions that must span every block. */
function wholePrompt(parts: string[]): string {
	return parts.join("\n");
}

/** A live runtime holding the named credentials, with an injectable clock for the expiry case. */
function runtimeWith(
	entries: ReadonlyArray<{ name: string; value: string; expiresAt?: number }>,
	now?: () => number,
): SecretObfuscator {
	return new SecretObfuscator(
		entries.map(entry => ({
			type: "plain" as const,
			origin: "config" as const,
			content: entry.value,
			name: entry.name,
			...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
		})),
		now === undefined ? { placeholderKey: KEY } : { placeholderKey: KEY, now },
	);
}

describe("the prompt tells a session which credentials it can spend", () => {
	/**
	 * The headline case, and the one that closes the defect: a session with protection on and two
	 * stored credentials is told about BOTH by name, in the placeholder form it must actually type,
	 * with neither value anywhere in the prompt.
	 *
	 * Exact strings rather than a "mentions the name somewhere" check. `GITHUB_TOKEN` appearing as
	 * prose is useless to the model; `#GITHUB_TOKEN#` is the token it has to emit for substitution
	 * to happen at all, and only the second form proves the section is usable.
	 */
	it("names every stored credential as a placeholder and no value", async () => {
		const runtime = runtimeWith([
			{ name: "GITHUB_TOKEN", value: VALUES.github },
			{ name: "STRIPE_KEY", value: VALUES.stripe },
		]);

		const parts = await renderPrompt(renderSecretInventory(runtime.namedSecretNames()));
		const section = sectionOf(parts);

		expect(section).toBeDefined();
		expect(section).toContain("`#GITHUB_TOKEN#`");
		expect(section).toContain("`#STRIPE_KEY#`");
		expect(wholePrompt(parts)).not.toContain(VALUES.github);
		expect(wholePrompt(parts)).not.toContain(VALUES.stripe);
	});

	/**
	 * Order is the provider's prompt cache, not cosmetics. The names go in reverse-alphabetically,
	 * so a section rendered in insertion order would place `STRIPE_KEY` first and fail here.
	 *
	 * Asserted as index comparison on the rendered SECTION rather than on `namedSecretNames()`,
	 * which has its own suite: the question here is whether the sorted answer survives templating,
	 * and a template that iterated an object's keys or reversed the list would pass the accessor's
	 * tests and fail this one.
	 */
	it("renders the names in sorted order, not the order they were stored in", async () => {
		const runtime = runtimeWith([
			{ name: "STRIPE_KEY", value: VALUES.stripe },
			{ name: "OPENAI_KEY", value: VALUES.openai },
			{ name: "GITHUB_TOKEN", value: VALUES.github },
		]);

		const section = sectionOf(await renderPrompt(renderSecretInventory(runtime.namedSecretNames())));
		if (section === undefined) throw new Error("the inventory section was not emitted");

		const positions = [
			section.indexOf("`#GITHUB_TOKEN#`"),
			section.indexOf("`#OPENAI_KEY#`"),
			section.indexOf("`#STRIPE_KEY#`"),
		];
		// All three present, and in that order. `every(>= 0)` is what keeps the ordering
		// assertion from passing vacuously on a section that lost a name: a missing entry
		// yields -1, which sorts first and would satisfy the comparison below on its own.
		expect(positions.every(position => position >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	/**
	 * The cache contract stated directly: two builds from an unchanged runtime must produce the SAME
	 * BYTES. Sortedness alone does not give this — a template that stamped a timestamp, a count, or
	 * iterated a `Set` rebuilt per call would still be sorted and would still throw the provider's
	 * cached prefix away on every `refreshSecrets()`.
	 */
	it("produces byte-identical section text when nothing about the runtime changed", async () => {
		const runtime = runtimeWith([
			{ name: "GITHUB_TOKEN", value: VALUES.github },
			{ name: "STRIPE_KEY", value: VALUES.stripe },
		]);

		const first = sectionOf(await renderPrompt(renderSecretInventory(runtime.namedSecretNames())));
		const second = sectionOf(await renderPrompt(renderSecretInventory(runtime.namedSecretNames())));

		expect(first).toBeDefined();
		expect(second).toBe(first as string);
	});
});

describe("the section is absent rather than empty when there is nothing to advertise", () => {
	/**
	 * Protection off. No obfuscator exists, so the caller passes nothing, and the section must not
	 * appear at all — heading included.
	 *
	 * The banner is the assertion, not the placeholder list. A section that rendered its heading and
	 * then nothing would pass a "contains no secret name" check while telling the model a capability
	 * exists and declining to say what it is, which is strictly worse than silence.
	 */
	it("emits no banner at all when secret protection is off", async () => {
		const parts = await renderPrompt(undefined);

		expect(sectionOf(parts)).toBeUndefined();
		expect(wholePrompt(parts)).not.toContain("AVAILABLE SECRETS");
	});

	/**
	 * Protection on, vault empty. This is the case the caller cannot express by omission — an
	 * obfuscator exists and redaction is running, there is simply nothing named to spend — so the
	 * renderer has to collapse an empty list to `undefined` itself.
	 */
	it("emits no banner when protection is on but no named credential is stored", async () => {
		const runtime = new SecretObfuscator([], { placeholderKey: KEY });

		expect(runtime.namedSecretNames()).toEqual([]);
		expect(renderSecretInventory(runtime.namedSecretNames())).toBeUndefined();

		const parts = await renderPrompt(renderSecretInventory(runtime.namedSecretNames()));
		expect(sectionOf(parts)).toBeUndefined();
		expect(wholePrompt(parts)).not.toContain("AVAILABLE SECRETS");
	});
});

describe("a credential that stopped working stops being advertised", () => {
	/**
	 * THE REGRESSION THAT MATTERS MOST. Before this section existed, `/secret rm GITHUB_TOKEN` left
	 * the model carrying "use `#GITHUB_TOKEN#`" in its history forever. The placeholder no longer
	 * expanded, so the LITERAL text `#GITHUB_TOKEN#` was handed to the shell and the call failed as
	 * a baffling auth error with nothing pointing at the cause.
	 *
	 * The section is rebuilt from the live runtime, so removal needs no revocation plumbing of its
	 * own. Both halves are asserted: the removed name is gone AND the survivor is still there. A
	 * rebuild that dropped the whole section, or emitted an empty one, would satisfy "the removed
	 * name is gone" while breaking the credential the user still has.
	 */
	it("drops a removed name from the rebuilt prompt and keeps the surviving one", async () => {
		const runtime = runtimeWith([
			{ name: "GITHUB_TOKEN", value: VALUES.github },
			{ name: "STRIPE_KEY", value: VALUES.stripe },
		]);

		const before = sectionOf(await renderPrompt(renderSecretInventory(runtime.namedSecretNames())));
		expect(before).toContain("`#GITHUB_TOKEN#`");
		expect(before).toContain("`#STRIPE_KEY#`");

		runtime.forgetNamedSecret("GITHUB_TOKEN");

		const parts = await renderPrompt(renderSecretInventory(runtime.namedSecretNames()));
		const after = sectionOf(parts);

		expect(after).toBeDefined();
		expect(after).not.toContain("GITHUB_TOKEN");
		expect(after).toContain("`#STRIPE_KEY#`");
		// The removed credential's value must not survive the rebuild either — the section is
		// re-rendered from names, so a leak here would mean text was carried over rather than rebuilt.
		expect(wholePrompt(parts)).not.toContain(VALUES.github);
		expect(wholePrompt(parts)).not.toContain(VALUES.stripe);
	});

	/**
	 * Removing the LAST credential must take the heading with it, not leave an empty one behind.
	 * This is the boundary the "keeps the survivor" case above cannot reach: with one name left the
	 * section still has content, and only emptying it completely exercises the collapse.
	 */
	it("removes the whole section once the last credential is gone", async () => {
		const runtime = runtimeWith([{ name: "GITHUB_TOKEN", value: VALUES.github }]);
		expect(sectionOf(await renderPrompt(renderSecretInventory(runtime.namedSecretNames())))).toBeDefined();

		runtime.forgetNamedSecret("GITHUB_TOKEN");

		const parts = await renderPrompt(renderSecretInventory(runtime.namedSecretNames()));
		expect(sectionOf(parts)).toBeUndefined();
		expect(wholePrompt(parts)).not.toContain("AVAILABLE SECRETS");
	});

	/**
	 * Expiry is the same regression arriving without anyone doing anything: a credential added with
	 * `--for 1d` stops expanding on its own, and a prompt built from a list snapshotted when the
	 * runtime was constructed would keep advertising it for the rest of the session.
	 *
	 * Driven entirely through the injected clock. No wall-clock sleep, so the test is deterministic
	 * and does not depend on how long the assembly takes. The lapsed name must vanish while the
	 * unexpiring one stays, which also proves expiry is per-credential rather than a whole-runtime
	 * reset.
	 */
	it("drops a credential that lapsed mid-session, keeping the one that did not", async () => {
		const start = 1_700_000_000_000;
		let clock = start;
		const runtime = runtimeWith(
			[
				{ name: "SHORT_LIVED_TOKEN", value: VALUES.github, expiresAt: start + 60_000 },
				{ name: "STRIPE_KEY", value: VALUES.stripe },
			],
			() => clock,
		);

		const before = sectionOf(await renderPrompt(renderSecretInventory(runtime.namedSecretNames())));
		expect(before).toContain("`#SHORT_LIVED_TOKEN#`");
		expect(before).toContain("`#STRIPE_KEY#`");

		clock = start + 60_001;

		const parts = await renderPrompt(renderSecretInventory(runtime.namedSecretNames()));
		const after = sectionOf(parts);

		expect(after).toBeDefined();
		expect(after).not.toContain("SHORT_LIVED_TOKEN");
		expect(after).toContain("`#STRIPE_KEY#`");
		expect(wholePrompt(parts)).not.toContain(VALUES.github);
		expect(wholePrompt(parts)).not.toContain(VALUES.stripe);
	});

	/**
	 * The boundary of the expiry check itself, asserted on BOTH sides of the instant so an
	 * off-by-one in either direction fails. Expiry is inclusive in the runtime (`expiresAt` is the
	 * first moment the credential no longer expands), and the prompt has to agree with it exactly:
	 * advertising a dead credential sends the model to write a placeholder that reaches the shell
	 * as literal text, while dropping a live one tells it a working credential does not exist.
	 *
	 * The two arms share one runtime and one clock variable, so they are the same object observed
	 * a millisecond apart rather than two runtimes that might differ in setup.
	 */
	it("advertises a credential up to the millisecond before it expires, and not at the instant itself", async () => {
		const start = 1_700_000_000_000;
		let clock = start;
		const runtime = runtimeWith(
			[{ name: "EDGE_TOKEN", value: VALUES.openai, expiresAt: start + 60_000 }],
			() => clock,
		);

		clock = start + 59_999;
		expect(runtime.namedSecretNames()).toEqual(["EDGE_TOKEN"]);
		expect(sectionOf(await renderPrompt(renderSecretInventory(runtime.namedSecretNames())))).toContain(
			"`#EDGE_TOKEN#`",
		);

		clock = start + 60_000;
		expect(runtime.namedSecretNames()).toEqual([]);
		const parts = await renderPrompt(renderSecretInventory(runtime.namedSecretNames()));
		expect(sectionOf(parts)).toBeUndefined();
		expect(wholePrompt(parts)).not.toContain("EDGE_TOKEN");
		expect(wholePrompt(parts)).not.toContain(VALUES.openai);
	});
});

describe("the section tells the model what to do with a name", () => {
	/**
	 * A bare list is not enough, and this is the adversarial case: the model is being handed a token
	 * that looks like it might be an instruction to go find a value. The section has to say that the
	 * placeholder IS what it writes, that substitution happens locally, and that it must not ask for
	 * the value — otherwise the "just ask the user for the token" behaviour the vault exists to
	 * prevent survives the fix.
	 */
	it("states that the placeholder is written verbatim and the value is never asked for", async () => {
		const runtime = runtimeWith([{ name: "GITHUB_TOKEN", value: VALUES.github }]);

		const section = sectionOf(await renderPrompt(renderSecretInventory(runtime.namedSecretNames())));
		if (section === undefined) throw new Error("the inventory section was not emitted");

		expect(section).toContain("substituted locally");
		expect(section).toContain("You never see the value, and you NEVER ask for it.");
		expect(section).toContain("A name that is not listed above is not available.");
	});

	/**
	 * The generic `#XXXX#` redaction explainer and this inventory are different statements and both
	 * have to be present together: one explains that redacted output is not an error, the other says
	 * which credentials can be spent. An earlier reading of the defect was "the redaction note
	 * covers it", and it does not — a session with the note alone is exactly the broken state.
	 */
	it("coexists with the redaction-token explainer rather than replacing it", async () => {
		const runtime = runtimeWith([{ name: "GITHUB_TOKEN", value: VALUES.github }]);

		const whole = wholePrompt(await renderPrompt(renderSecretInventory(runtime.namedSecretNames())));

		expect(whole).toContain("#XXXX#");
		expect(whole).toContain("`#GITHUB_TOKEN#`");
	});
});
