/**
 * A rejected API key reports the provider's own sentence, not its JSON.
 *
 * WHY: Command Code answers a key on the wrong plan with HTTP 403 and
 * `{"error":{"message":"Your Go plan doesn't include API access. Upgrade to
 * Provider or higher at https://commandcode.ai/billing to use these
 * endpoints.","type":"permission_error","code":"upgrade_required"}}`. The
 * validation error interpolated that body verbatim, so the one line that tells
 * the operator this is a billing limit rather than a mistyped key arrived
 * wrapped in braces, quotes and two fields they do not need. The distinction
 * matters: a wrong key is retyped, a plan limit is not.
 *
 * WHAT CLASS THIS CLOSES: every envelope shape the validators can receive,
 * across all three validation kinds, plus the fallbacks. Extraction reads the
 * ALREADY redacted and bounded body, so a provider cannot use it to widen what
 * an error may say.
 *
 * WHAT IT DOES NOT CATCH: a provider that returns a readable sentence in a
 * shape none of these match still shows its raw body, which is the old
 * behaviour and is still better than inventing a message.
 */

import { describe, expect, it } from "bun:test";
import * as AIError from "@veyyon/ai/error";
import { validateOpenAICompatibleApiKey } from "@veyyon/ai/registry/api-key-validation";

/** The exact body Command Code returns for a key on a plan without API access. */
const COMMAND_CODE_403 = JSON.stringify({
	error: {
		message:
			"Your Go plan doesn't include API access. Upgrade to Provider or higher at https://commandcode.ai/billing to use these endpoints.",
		type: "permission_error",
		code: "upgrade_required",
	},
});

function respond(status: number, body: string): typeof fetch {
	return (() => Promise.resolve(new Response(body, { status }))) as unknown as typeof fetch;
}

async function validationError(status: number, body: string): Promise<string> {
	try {
		await validateOpenAICompatibleApiKey({
			provider: "command-code",
			apiKey: "sk-test-key",
			baseUrl: "https://api.example.invalid/v1",
			model: "some-model",
			fetch: respond(status, body),
		});
		return "<no error thrown>";
	} catch (error) {
		return (error as Error).message;
	}
}

describe("a rejected key says why in the provider's own words", () => {
	it("surfaces the provider's sentence for the plan-limit body that started this", async () => {
		// The whole sentence, including the billing URL: the operator's next action
		// is in the tail of it, so a fix that kept only the first clause is wrong.
		expect(await validationError(403, COMMAND_CODE_403)).toBe(
			"command-code API key validation failed (403): Your Go plan doesn't include API access. " +
				"Upgrade to Provider or higher at https://commandcode.ai/billing to use these endpoints.",
		);
	});

	it("keeps the status, so a 403 is still distinguishable from a 401", async () => {
		expect(await validationError(403, COMMAND_CODE_403)).toContain("(403)");
		expect(await validationError(401, COMMAND_CODE_403)).toContain("(401)");
	});

	it("drops the envelope punctuation the operator does not need", async () => {
		const message = await validationError(403, COMMAND_CODE_403);
		// The fields around the sentence are what made the real error unreadable.
		expect(message).not.toContain("permission_error");
		expect(message).not.toContain("upgrade_required");
		expect(message).not.toContain('{"error"');
	});

	it("reads every envelope shape a provider actually sends", async () => {
		const shapes: ReadonlyArray<readonly [string, string]> = [
			[JSON.stringify({ error: { message: "nested message" } }), "nested message"],
			[JSON.stringify({ error: "flat error string" }), "flat error string"],
			[JSON.stringify({ message: "top level message" }), "top level message"],
			[JSON.stringify({ detail: "fastapi detail" }), "fastapi detail"],
		];
		const seen: string[] = [];
		for (const [body, expected] of shapes) {
			const message = await validationError(403, body);
			seen.push(message.includes(expected) ? expected : `MISSING from: ${message}`);
		}
		expect(seen).toEqual(shapes.map(([, expected]) => expected));
	});

	it("falls back to the raw body rather than swallowing an unrecognized shape", async () => {
		// A body with no message field still has to reach the operator: showing
		// less than the old behaviour would be a regression dressed as a cleanup.
		const message = await validationError(403, JSON.stringify({ code: "nope", status: 403 }));
		expect(message).toContain("nope");
	});

	it("falls back for a body that is not JSON at all", async () => {
		const message = await validationError(502, "<html><body>Bad Gateway</body></html>");
		expect(message).toContain("Bad Gateway");
	});

	it("reports the status alone when the body is empty", async () => {
		expect(await validationError(403, "")).toContain("(403)");
	});

	it("treats a prototype-polluting key as no message and leaves Object.prototype alone", async () => {
		// `JSON.parse` puts `__proto__` on the object as an ordinary own property
		// rather than reassigning the prototype, so the risk is not pollution but
		// mistaking that payload for the provider's message. It is neither: the
		// body has no `error`/`message`/`detail` of its own, so extraction declines
		// and the raw body is shown, exactly as for any other unrecognized shape.
		const message = await validationError(403, '{"__proto__":{"message":"injected"}}');
		expect(message).toBe('command-code API key validation failed (403): {"__proto__":{"message":"injected"}}');
		expect(({} as { message?: string }).message).toBeUndefined();
	});

	it("bounds a message long enough to flood the transcript", async () => {
		const message = await validationError(403, JSON.stringify({ error: { message: "x".repeat(50_000) } }));
		expect(message.length).toBeLessThan(5_000);
	});

	it("exposes the extractor as the one owner every validator shares", () => {
		// Three validation kinds interpolate this; a second copy is how one of
		// them keeps printing raw JSON after the other two are fixed.
		expect(typeof AIError.providerErrorMessage).toBe("function");
	});
});
