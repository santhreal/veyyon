import { describe, expect, it } from "bun:test";
import { deobfuscateToolArguments, SecretObfuscator } from "@veyyon/coding-agent/secrets";

const OLD_VALUE = "sk_test_retired_credential_123456789";
const NEW_VALUE = "sk_test_rotated_credential_987654321";
const START = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function withNamedSecret(options?: { expiresAt?: number; now?: () => number }): SecretObfuscator {
	return new SecretObfuscator(
		[
			{
				type: "plain",
				origin: "config",
				content: OLD_VALUE,
				name: "STRIPE_TEST_KEY",
				expiresAt: options?.expiresAt,
			},
		],
		options?.now ? { now: options.now } : undefined,
	);
}

describe("retired secret placeholders at the tool boundary", () => {
	/** A removed credential must fail before a tool sends its literal placeholder to a remote service. */
	it("refuses an explicitly removed name with an actionable value-free error", () => {
		const obfuscator = withNamedSecret();
		obfuscator.forgetNamedSecret("STRIPE_TEST_KEY");

		expect(() =>
			deobfuscateToolArguments(obfuscator, {
				command: "curl https://api.stripe.com/v1/balance -u '#STRIPE_TEST_KEY#:'",
			}),
		).toThrow(
			"Stored secret #STRIPE_TEST_KEY# is no longer available. Store the credential again and update the command.",
		);
		try {
			deobfuscateToolArguments(obfuscator, { command: "use #STRIPE_TEST_KEY#" });
		} catch (error) {
			expect(String(error)).not.toContain(OLD_VALUE);
		}
	});

	/** Expiry is a revocation too, so the first attempted spend after the deadline must explain the failure. */
	it("refuses a name whose lifetime ended while the session stayed open", () => {
		let now = START;
		const obfuscator = withNamedSecret({ expiresAt: START + HOUR, now: () => now });
		now = START + HOUR + 1;

		expect(() => deobfuscateToolArguments(obfuscator, { command: "use #STRIPE_TEST_KEY#" })).toThrow(
			/Stored secret #STRIPE_TEST_KEY# is no longer available/,
		);
	});

	/** Placeholder-shaped prose that was never a live credential must remain ordinary tool input. */
	it("does not mistake TODOs or unknown names for retired credentials", () => {
		const obfuscator = withNamedSecret();
		obfuscator.forgetNamedSecret("STRIPE_TEST_KEY");
		const args = {
			command: "printf '%s\\n' '#TODO# #OTHER_TOKEN#'",
		};

		expect(deobfuscateToolArguments(obfuscator, args)).toEqual(args);
	});

	/** Runtime refreshes must carry the retired name forward or a removal becomes silent after reloading the vault. */
	it("retains the refusal across a refreshed runtime", () => {
		const previous = withNamedSecret();
		const refreshed = new SecretObfuscator([]);
		refreshed.retainRedactionsFrom(previous);

		expect(() => deobfuscateToolArguments(refreshed, { command: "use #STRIPE_TEST_KEY#" })).toThrow(
			/Stored secret #STRIPE_TEST_KEY# is no longer available/,
		);
		expect(refreshed.obfuscate(`value=${OLD_VALUE}`)).not.toContain(OLD_VALUE);
	});

	/** Deliberately reusing a name grants a fresh expansion right and clears the in-process retirement marker. */
	it("allows the same name after the operator stores a replacement", () => {
		const obfuscator = withNamedSecret();
		obfuscator.forgetNamedSecret("STRIPE_TEST_KEY");
		obfuscator.addNamedSecret("STRIPE_TEST_KEY", NEW_VALUE);

		expect(deobfuscateToolArguments(obfuscator, { command: "use #STRIPE_TEST_KEY#" })).toEqual({
			command: `use ${NEW_VALUE}`,
		});
	});
});
