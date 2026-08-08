/**
 * Every account row gets a label, and the ladder that picks it has one rung per reason.
 *
 * `accountDisplayLabel` is deliberately the ONLY name-fallback ladder in the account
 * surfaces: three renderers used to each carry their own, and they disagreed about what an
 * unnamed account is called. The order encodes what a person recognises — the name they
 * authored, then the email, then the organisation, then the opaque ids — and the final rung
 * exists so an api-key row that identifies nothing still gets a stable, unique label instead
 * of an empty string. Each test below removes exactly one rung's input and pins what the next
 * rung produces, so a reordered or dropped rung cannot pass.
 */
import { describe, expect, test } from "bun:test";
import { type AccountRow, accountDisplayLabel } from "@veyyon/coding-agent/session/account-inventory";

/** A row carrying every identity field, so each test can delete just the rung it is proving. */
function fullRow(overrides: Partial<AccountRow> = {}): AccountRow {
	return {
		provider: "openai-codex",
		providerLabel: "OpenAI Codex",
		credentialId: 42,
		type: "oauth",
		name: "work",
		email: "first@example.com",
		orgName: "Example Org",
		accountId: "acct-9f2",
		projectId: "example-project",
		orgId: "org-7b1",
		usage: [],
		activeForSession: false,
		selectedForProvider: false,
		...overrides,
	};
}

describe("accountDisplayLabel", () => {
	/** The name the user authored outranks everything the account says about itself. */
	test("a chosen name wins over every identity field", () => {
		expect(accountDisplayLabel(fullRow())).toBe("work");
	});

	/** Email is the identifier a person actually recognises, so it is the first fallback. */
	test("falls back to the email when no name was chosen", () => {
		expect(accountDisplayLabel(fullRow({ name: undefined }))).toBe("first@example.com");
	});

	/** Org name before ids: it is prose, and it is what separates two subscriptions. */
	test("falls back to the organisation name when there is no email", () => {
		expect(accountDisplayLabel(fullRow({ name: undefined, email: undefined }))).toBe("Example Org");
	});

	/** The opaque ids come last among identities: they identify without describing. */
	test("falls back to the account id when there is no name, email or org name", () => {
		expect(accountDisplayLabel(fullRow({ name: undefined, email: undefined, orgName: undefined }))).toBe("acct-9f2");
	});

	/** Google-style providers key on a project rather than an account. */
	test("falls back to the project id when no account id is known", () => {
		const row = fullRow({ name: undefined, email: undefined, orgName: undefined, accountId: undefined });
		expect(accountDisplayLabel(row)).toBe("example-project");
	});

	/** An org id alone still tells two rows apart, so it outranks the final rung. */
	test("falls back to the org id when nothing else identifies the account", () => {
		const row = fullRow({
			name: undefined,
			email: undefined,
			orgName: undefined,
			accountId: undefined,
			projectId: undefined,
		});
		expect(accountDisplayLabel(row)).toBe("org-7b1");
	});

	/**
	 * The last rung, and the one that matters most: an api-key credential carries no identity
	 * at all, and a blank label would make two such rows indistinguishable in a list the user
	 * is about to delete a row from. The row id is what makes it unique.
	 */
	test("names the provider and row id when the account identifies itself in no way", () => {
		const row = fullRow({
			provider: "groq",
			providerLabel: "Groq",
			credentialId: 7,
			type: "api_key",
			name: undefined,
			email: undefined,
			orgName: undefined,
			accountId: undefined,
			projectId: undefined,
			orgId: undefined,
		});

		expect(accountDisplayLabel(row)).toBe("Groq credential #7");
	});

	/**
	 * Two unidentifiable rows of the same provider must not collide, which is the reason the
	 * final rung includes the id at all rather than just the provider name.
	 */
	test("two unidentifiable rows of one provider get distinct labels", () => {
		const bare = {
			provider: "groq",
			providerLabel: "Groq",
			type: "api_key" as const,
			usage: [],
			activeForSession: false,
			selectedForProvider: false,
		};

		expect(accountDisplayLabel({ ...bare, credentialId: 7 })).toBe("Groq credential #7");
		expect(accountDisplayLabel({ ...bare, credentialId: 8 })).toBe("Groq credential #8");
	});
});
