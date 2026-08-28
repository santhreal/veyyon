/**
 * WHY: a request dump written for a bug report leaked the operator's API key,
 * because each diagnostic carried its OWN list of header names to hide. The
 * shared dump path was fixed once by matching credentials with one predicate,
 * and the Codex diagnostics kept a second private list that covered
 * `authorization` and Codex identity headers and nothing else — so a Codex
 * request routed through a proxy wrote `x-api-key` and `proxy-authorization` in
 * plaintext into the debug log.
 *
 * THE CLASS this closes: two redactors disagreeing about what a credential is.
 * `redactDiagnosticHeaders` is now the only one, and the spellings it recognizes
 * are exported so this suite sweeps them instead of restating them. A caller may
 * add names that are sensitive without being credentials, and that extension is
 * asserted to be additive: it can never un-redact a credential.
 *
 * WHAT IT DOES NOT CATCH: a NEW diagnostic that writes headers without calling
 * the shared redactor at all. There is no registry of diagnostic sinks to sweep,
 * so a third private list would be invisible here. It also says nothing about
 * credentials appearing in a request BODY or a URL query, which are redacted
 * elsewhere.
 */

import { describe, expect, it } from "bun:test";
import {
	CREDENTIAL_HEADER_SPELLINGS,
	isCredentialHeaderName,
	redactDiagnosticHeaders,
} from "../src/utils/request-debug";

/** An obviously fake value of credential shape, so a leak is unmistakable in a failure. */
const SECRET = "sk-test-000000000000000000000000";

/** `it.each` needs a mutable array; the owner's export stays readonly. */
const SPELLINGS: string[] = [...CREDENTIAL_HEADER_SPELLINGS];

/** Codex's identity predicate, mirrored here so the suite can prove the extension is additive. */
const codexIdentity = (lower: string): boolean =>
	lower.includes("account") ||
	lower.includes("session") ||
	lower.includes("conversation") ||
	lower.includes("thread") ||
	lower.includes("window") ||
	lower.includes("installation") ||
	lower.startsWith("x-codex-turn") ||
	lower === "x-client-request-id";

describe("a diagnostic never writes a credential header value", () => {
	it("recognizes every spelling it exports, so the sweep below is not swept past", () => {
		const unrecognized = CREDENTIAL_HEADER_SPELLINGS.filter(name => !isCredentialHeaderName(name));

		expect(unrecognized).toEqual([]);
		expect(CREDENTIAL_HEADER_SPELLINGS.length).toBeGreaterThanOrEqual(6);
	});

	it.each(SPELLINGS)("redacts %s", spelling => {
		const redacted = redactDiagnosticHeaders([[spelling, SECRET]]);

		expect(redacted[spelling]).toBe("[redacted]");
	});

	/**
	 * Casing is the provider's choice, not ours. A header arriving as `X-Api-Key`
	 * from one SDK and `x-api-key` from another must redact the same.
	 */
	it.each(SPELLINGS)("redacts %s however it is cased", spelling => {
		const shouted = spelling.toUpperCase();

		expect(redactDiagnosticHeaders([[shouted, SECRET]])[shouted]).toBe("[redacted]");
	});

	/**
	 * The Codex extension adds identity headers. It must not be able to SUBTRACT:
	 * a caller predicate that returns false for everything still redacts every
	 * credential, which is what makes one owner an owner.
	 */
	it.each(SPELLINGS)("redacts %s even when a caller's predicate declines it", spelling => {
		const redacted = redactDiagnosticHeaders([[spelling, SECRET]], () => false);

		expect(redacted[spelling]).toBe("[redacted]");
	});

	it.each(SPELLINGS)("redacts %s on the Codex diagnostic path", spelling => {
		const redacted = redactDiagnosticHeaders(new Headers({ [spelling]: SECRET }).entries(), codexIdentity);

		expect(redacted[spelling.toLowerCase()]).toBe("[redacted]");
	});

	/**
	 * NON-VACUITY. Redacting everything would pass every case above and destroy
	 * the diagnostic. Protocol metadata keeps its value, byte for byte.
	 */
	it("leaves protocol metadata alone", () => {
		const redacted = redactDiagnosticHeaders([
			["content-type", "application/json"],
			["accept", "text/event-stream"],
			["user-agent", "veyyon/1.2.0"],
		]);

		expect(redacted).toEqual({
			"content-type": "application/json",
			accept: "text/event-stream",
			"user-agent": "veyyon/1.2.0",
		});
	});

	/** The caller's extension still works, or the Codex call site silently lost its identity redaction. */
	it("redacts a caller's own sensitive names alongside the credentials", () => {
		const redacted = redactDiagnosticHeaders(
			[
				["chatgpt-account-id", "acct_123"],
				["x-codex-turn-state", "opaque"],
				["content-type", "application/json"],
			],
			codexIdentity,
		);

		expect(redacted).toEqual({
			"chatgpt-account-id": "[redacted]",
			"x-codex-turn-state": "[redacted]",
			"content-type": "application/json",
		});
	});

	/**
	 * A credential value must not survive anywhere in the output, including as a
	 * KEY. The per-header assertions above would pass if the redactor wrote the
	 * value into a differently named field.
	 */
	it("leaves no copy of the value anywhere in the result", () => {
		const headers: Array<[string, string]> = CREDENTIAL_HEADER_SPELLINGS.map(name => [name, SECRET]);

		const serialized = JSON.stringify(redactDiagnosticHeaders(headers, codexIdentity));

		expect(serialized).not.toContain(SECRET);
	});
});
