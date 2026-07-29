/**
 * `containsLivePlaceholder` must answer exactly what `deobfuscate` would do, and never throw.
 *
 * THE BUG THIS LOCKS OUT. The freshness guard used to fire on any text at all whenever the session
 * held any secret, so a command with no placeholder in it (`echo "$HOME"; ls -la "$HOME"`) was
 * refused for staleness even though the codec would not have touched a character of it. This
 * predicate is what lets the guard ask about the PAYLOAD instead of about the session. Two ways it
 * can go wrong, and both are serious:
 *
 *   - answering FALSE for a text `deobfuscate` would expand: the gate skips the freshness check on
 *     a payload that really does carry a credential, which is a security failure.
 *   - THROWING: it is called from render paths, and a throw there unwinds the TUI rather than
 *     failing one tool call. That is the crash this whole effort exists to remove.
 *
 * Every case below asserts the PAIR together, predicate against what `deobfuscate` actually does
 * to the same text with the same obfuscator, so the two cannot drift apart as either changes.
 *
 * IF THIS REGRESSES: either secrets leak past the guard unchecked, or the TUI crashes on a
 * markdown document that happens to contain hashes.
 */
import { describe, expect, it } from "bun:test";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets";
import { MAX_PLACEHOLDERS_PER_TEXT, MAX_TRANSFORMED_TEXT_BYTES } from "@veyyon/coding-agent/secrets/obfuscator";
import { buildNamePlaceholder } from "@veyyon/coding-agent/secrets/placeholder";

const SECRET_VALUE = "ghp_a_real_looking_credential_value";
const OTHER_VALUE = "another_credential_value_entirely";

/**
 * Assert the predicate against `deobfuscate`'s real behaviour on the same text.
 *
 * `deobfuscate` is allowed to REFUSE a text (too many placeholders, output over the byte limit,
 * unusable clock) where the predicate is required not to. That is deliberate: the predicate is a
 * question and questions must not throw. Both outcomes are still safe, because a refusal expands
 * nothing, so the invariant that actually matters holds either way: the predicate never says
 * "nothing to expand" about a text that `deobfuscate` would go on to expand.
 */
function pairVerdict(obfuscator: SecretObfuscator, text: string): { predicate: boolean; refused: boolean } {
	let predicate: boolean | undefined;
	expect(() => {
		predicate = obfuscator.containsLivePlaceholder(text);
	}).not.toThrow();
	if (predicate === undefined) throw new Error("unreachable: the predicate did not produce a verdict");

	let expanded: string | undefined;
	let refused = false;
	try {
		expanded = obfuscator.deobfuscate(text);
	} catch {
		refused = true;
	}

	if (!refused) expect(predicate).toBe(expanded !== text);
	return { predicate, refused };
}

function withNamedSecret(): SecretObfuscator {
	const obfuscator = new SecretObfuscator([]);
	obfuscator.addNamedSecret("DEPLOY_TOKEN", SECRET_VALUE, null);
	return obfuscator;
}

describe("containsLivePlaceholder agrees with deobfuscate", () => {
	describe("texts with nothing to expand", () => {
		/** The reported case: an ordinary shell command with no placeholder was being refused. */
		it("says no to a command that merely mentions shell variables", () => {
			const obfuscator = withNamedSecret();

			expect(pairVerdict(obfuscator, 'echo "$HOME"; echo ---; ls -la "$HOME"')).toEqual({
				predicate: false,
				refused: false,
			});
		});

		it("says no to the empty string and to whitespace", () => {
			const obfuscator = withNamedSecret();

			for (const text of ["", " ", "\n", "\t\t"]) {
				expect(pairVerdict(obfuscator, text).predicate).toBe(false);
			}
		});

		/** A `#`-heavy document is the payload most likely to be mistaken for placeholder traffic. */
		it("says no to a markdown document full of headings and anchors", () => {
			const obfuscator = withNamedSecret();
			const markdown = [
				"# Title",
				"## Section one",
				"### Sub #1",
				"See [link](https://example.test/page#fragment) and #hashtag.",
				"| col # | value |",
				"#".repeat(80),
				"#### Deeply nested ####",
			].join("\n");

			expect(pairVerdict(obfuscator, markdown)).toEqual({ predicate: false, refused: false });
		});

		/** A bash script is the other one: every comment line starts with the delimiter. */
		it("says no to a bash script that is mostly comments", () => {
			const obfuscator = withNamedSecret();
			const script = [
				"#!/usr/bin/env bash",
				"# Deploy helper",
				"# WARNING: do not run in production",
				"set -euo pipefail",
				'printf "%s\\n" "#DONE#"',
				"# TODO: add retries # and backoff #",
			].join("\n");

			expect(pairVerdict(obfuscator, script)).toEqual({ predicate: false, refused: false });
		});

		it("says no to lone and doubled delimiters", () => {
			const obfuscator = withNamedSecret();

			for (const text of ["#", "##", "###", "# #", "#_#", "#AB#"]) {
				expect(pairVerdict(obfuscator, text).predicate).toBe(false);
			}
		});

		/** Placeholder-SHAPED but never registered: the shape alone must not grant expansion. */
		it("says no to a well-formed placeholder for a name that was never stored", () => {
			const obfuscator = withNamedSecret();

			expect(pairVerdict(obfuscator, `use ${buildNamePlaceholder("GHOST_TOKEN")} here`)).toEqual({
				predicate: false,
				refused: false,
			});
		});

		/** An obfuscator holding nothing must answer no even to a perfectly shaped placeholder. */
		it("says no when the obfuscator holds no secrets at all", () => {
			const empty = new SecretObfuscator([]);

			expect(empty.hasSecrets()).toBe(false);
			expect(pairVerdict(empty, buildNamePlaceholder("DEPLOY_TOKEN"))).toEqual({
				predicate: false,
				refused: false,
			});
		});

		/** Case matters: the grammar is uppercase only, so a lowercase twin is not a placeholder. */
		it("says no to a lowercase or mixed-case imitation", () => {
			const obfuscator = withNamedSecret();

			for (const text of ["#deploy_token#", "#Deploy_Token#", "#deployToken#"]) {
				expect(pairVerdict(obfuscator, text).predicate).toBe(false);
			}
		});

		/** A placeholder broken across a line is not a placeholder, and must not be treated as one. */
		it("says no to a placeholder split by a newline or a space", () => {
			const obfuscator = withNamedSecret();

			for (const text of ["#DEPLOY_\nTOKEN#", "#DEPLOY TOKEN#", "#DEPLOY_TOKEN\n#"]) {
				expect(pairVerdict(obfuscator, text).predicate).toBe(false);
			}
		});
	});

	describe("texts that really do carry a credential", () => {
		it("says yes to a live named placeholder and expands it", () => {
			const obfuscator = withNamedSecret();
			const text = `curl -H "Authorization: Bearer ${buildNamePlaceholder("DEPLOY_TOKEN")}"`;

			expect(pairVerdict(obfuscator, text)).toEqual({ predicate: true, refused: false });
			expect(obfuscator.deobfuscate(text)).toContain(SECRET_VALUE);
		});

		/** Unnamed value placeholders are the other reversible form and must be recognised too. */
		it("says yes to an unnamed value placeholder minted by obfuscate", () => {
			const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: SECRET_VALUE }]);
			const placeholder = obfuscator.obfuscate(SECRET_VALUE);

			expect(placeholder).not.toBe(SECRET_VALUE);
			expect(pairVerdict(obfuscator, `token=${placeholder}`)).toEqual({ predicate: true, refused: false });
		});

		/** One live placeholder buried in a wall of decoys still has to be found. */
		it("says yes when a single live placeholder hides among lookalikes", () => {
			const obfuscator = withNamedSecret();
			const decoys = Array.from({ length: 200 }, (_, index) => `#DECOY_${index}#`).join(" ");
			const text = `${decoys} ${buildNamePlaceholder("DEPLOY_TOKEN")} ${decoys}`;

			expect(pairVerdict(obfuscator, text)).toEqual({ predicate: true, refused: false });
		});
	});

	describe("adjacency and overlap", () => {
		/** Two placeholders sharing no delimiter: both are live and both must expand. */
		it("agrees on adjacent placeholders", () => {
			const obfuscator = withNamedSecret();
			obfuscator.addNamedSecret("OTHER_TOKEN", OTHER_VALUE, null);
			const text = `${buildNamePlaceholder("DEPLOY_TOKEN")}${buildNamePlaceholder("OTHER_TOKEN")}`;

			expect(pairVerdict(obfuscator, text)).toEqual({ predicate: true, refused: false });
			expect(obfuscator.deobfuscate(text)).toBe(`${SECRET_VALUE}${OTHER_VALUE}`);
		});

		/**
		 * Two names sharing ONE delimiter. The scan consumes `#DEPLOY_TOKEN#` and resumes after it,
		 * so the trailing run is not a second placeholder. Whatever the grammar decides here, both
		 * methods must decide it identically, because they run the same regex over the same text.
		 */
		it("agrees on a shared delimiter between two names", () => {
			const obfuscator = withNamedSecret();
			obfuscator.addNamedSecret("OTHER_TOKEN", OTHER_VALUE, null);
			const text = "#DEPLOY_TOKEN#OTHER_TOKEN#";

			const verdict = pairVerdict(obfuscator, text);

			expect(verdict).toEqual({ predicate: true, refused: false });
			expect(obfuscator.deobfuscate(text)).toBe(`${SECRET_VALUE}OTHER_TOKEN#`);
		});

		it("agrees on a placeholder wrapped in extra delimiters", () => {
			const obfuscator = withNamedSecret();

			for (const text of ["##DEPLOY_TOKEN##", "###DEPLOY_TOKEN###", `x#${buildNamePlaceholder("DEPLOY_TOKEN")}#x`]) {
				const verdict = pairVerdict(obfuscator, text);
				expect(verdict.refused).toBe(false);
				expect(verdict.predicate).toBe(true);
			}
		});
	});

	describe("placeholders that have lost their rights", () => {
		/** A retired secret must go opaque: the placeholder stays, the value does not come back. */
		it("says no once the secret is retired", () => {
			const obfuscator = withNamedSecret();
			const text = `token=${buildNamePlaceholder("DEPLOY_TOKEN")}`;
			expect(pairVerdict(obfuscator, text).predicate).toBe(true);

			obfuscator.forgetNamedSecret("DEPLOY_TOKEN");

			expect(pairVerdict(obfuscator, text)).toEqual({ predicate: false, refused: false });
		});

		/** An expired secret is the same story, decided by the clock rather than by a call. */
		it("says no once the secret has expired", () => {
			let now = 1_800_000_000_000;
			const obfuscator = new SecretObfuscator([], { now: () => now });
			obfuscator.addNamedSecret("EXPIRING_TOKEN", SECRET_VALUE, now + 60_000);
			const text = `token=${buildNamePlaceholder("EXPIRING_TOKEN")}`;
			expect(pairVerdict(obfuscator, text).predicate).toBe(true);

			now += 120_000;

			expect(pairVerdict(obfuscator, text)).toEqual({ predicate: false, refused: false });
		});

		/** The boundary: expiry is inclusive, so the instant it lapses it is already gone. */
		it("says no at the exact expiry instant and yes one millisecond before", () => {
			let now = 1_800_000_000_000;
			const expiresAt = now + 60_000;
			const obfuscator = new SecretObfuscator([], { now: () => now });
			obfuscator.addNamedSecret("BOUNDARY_TOKEN", SECRET_VALUE, expiresAt);
			const text = buildNamePlaceholder("BOUNDARY_TOKEN");

			now = expiresAt - 1;
			expect(pairVerdict(obfuscator, text).predicate).toBe(true);

			now = expiresAt;
			expect(pairVerdict(obfuscator, text)).toEqual({ predicate: false, refused: false });
		});

		/** A live secret beside a dead one must still be found, and only it must expand. */
		it("says yes for the survivor when one of two placeholders has expired", () => {
			let now = 1_800_000_000_000;
			const obfuscator = new SecretObfuscator([], { now: () => now });
			obfuscator.addNamedSecret("DYING_TOKEN", SECRET_VALUE, now + 60_000);
			obfuscator.addNamedSecret("LIVING_TOKEN", OTHER_VALUE, null);
			const text = `${buildNamePlaceholder("DYING_TOKEN")} ${buildNamePlaceholder("LIVING_TOKEN")}`;

			now += 120_000;

			expect(pairVerdict(obfuscator, text)).toEqual({ predicate: true, refused: false });
			expect(obfuscator.deobfuscate(text)).toBe(`${buildNamePlaceholder("DYING_TOKEN")} ${OTHER_VALUE}`);
		});
	});

	describe("limits and hostile sizes", () => {
		/**
		 * Past the placeholder cap `deobfuscate` refuses outright. The predicate must still answer,
		 * because a render path asking about a pathological document must not be handed an
		 * exception. Nothing is expanded either way, so refusing to answer buys no safety.
		 */
		it("answers without throwing on a text past the placeholder cap", () => {
			const obfuscator = withNamedSecret();
			const text = Array.from({ length: MAX_PLACEHOLDERS_PER_TEXT + 1 }, () => "#DEAD_TOKEN#").join(" ");

			const verdict = pairVerdict(obfuscator, text);

			expect(verdict.predicate).toBe(false);
			expect(verdict.refused).toBe(true);
		});

		/** Same cap, but with a live placeholder present: the predicate must find it. */
		it("finds a live placeholder in a text past the placeholder cap", () => {
			const obfuscator = withNamedSecret();
			const decoys = Array.from({ length: MAX_PLACEHOLDERS_PER_TEXT + 1 }, () => "#DEAD_TOKEN#").join(" ");
			const text = `${buildNamePlaceholder("DEPLOY_TOKEN")} ${decoys}`;

			const verdict = pairVerdict(obfuscator, text);

			expect(verdict.predicate).toBe(true);
			expect(verdict.refused).toBe(true);
		});

		/** Over the transform byte ceiling `deobfuscate` refuses; the predicate still may not throw. */
		it("answers without throwing on a text over the transform byte limit", () => {
			const obfuscator = withNamedSecret();
			const text = "#".repeat(MAX_TRANSFORMED_TEXT_BYTES + 1);

			const verdict = pairVerdict(obfuscator, text);

			expect(verdict.predicate).toBe(false);
			expect(verdict.refused).toBe(true);
		});

		/** Just under the ceiling both agree normally, so the limit is the only thing that differs. */
		it("agrees on a large text that stays under the transform byte limit", () => {
			const obfuscator = withNamedSecret();
			const filler = "#".repeat(1024 * 1024);

			expect(pairVerdict(obfuscator, filler)).toEqual({ predicate: false, refused: false });
			expect(pairVerdict(obfuscator, `${filler}${buildNamePlaceholder("DEPLOY_TOKEN")}`)).toEqual({
				predicate: true,
				refused: false,
			});
		});

		/** A name at the maximum length is still a name; the grammar boundary must not drop it. */
		it("agrees on a placeholder whose name is at the maximum length", () => {
			const obfuscator = new SecretObfuscator([]);
			const longName = `L${"O".repeat(62)}G`;
			expect(longName.length).toBe(64);
			obfuscator.addNamedSecret(longName, SECRET_VALUE, null);

			expect(pairVerdict(obfuscator, buildNamePlaceholder(longName))).toEqual({
				predicate: true,
				refused: false,
			});
		});
	});

	/**
	 * The predicate documents itself as never throwing, but it consults expiry, and expiry
	 * evaluation rejects an unusable clock. Left unguarded that turned a broken clock into a TUI
	 * crash on every render. It now answers conservatively and lets `deobfuscate` report the fault
	 * where a throw is survivable.
	 */
	it("does not throw when the clock is unusable", () => {
		let now: number = 1_800_000_000_000;
		const obfuscator = new SecretObfuscator([], { now: () => now });
		obfuscator.addNamedSecret("CLOCKED_TOKEN", SECRET_VALUE, now + 60_000);

		now = Number.NaN;

		expect(() => obfuscator.containsLivePlaceholder(`token=${buildNamePlaceholder("CLOCKED_TOKEN")}`)).not.toThrow();
		expect(() => obfuscator.containsLivePlaceholder("no placeholder here at all")).not.toThrow();
		expect(obfuscator.containsLivePlaceholder("no placeholder here at all")).toBe(false);
	});
});
