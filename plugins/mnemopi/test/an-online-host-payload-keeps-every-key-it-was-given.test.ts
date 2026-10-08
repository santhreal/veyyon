/**
 * WHY: the default projection an online host backend applies to its request payload copied each
 * record with `copy[key] = value`. For a `__proto__` key that assignment ran the prototype setter,
 * so the key disappeared from the request the backend sent.
 *
 * The class: every key `Object.prototype` defines survives the projection as an own field, at the
 * top level and inside a nested record, while each string under it is still sanitized and the
 * placeholder still becomes the sanitized prompt. The key list is read from `Object.prototype` at
 * run time.
 *
 * Gap: covers the projection `callHostLlm` applies when the caller passes no `onPayload`. The
 * configured-completion projection in `local-llm.ts` rewrites the payload in place, where an own
 * `__proto__` data property is assigned directly, and is not swept here.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	CallableLlmBackend,
	callHostLlm,
	MNEMOPI_LLM_ATTEMPT_PLACEHOLDER,
	resetHostLlmBackendForTests,
	setHostLlmBackend,
} from "@veyyon/mnemopi/core/llm-backends";
import { withMnemopiRuntimeOptions } from "@veyyon/mnemopi/core/runtime-options";

const PROTOTYPE_KEYS = Object.getOwnPropertyNames(Object.prototype);

afterEach(() => resetHostLlmBackendForTests());

function payloadWith(key: string, word: string): string {
	const name = JSON.stringify(key);
	return `{"messages":[{"content":${JSON.stringify(MNEMOPI_LLM_ATTEMPT_PLACEHOLDER)}}],${name}:{"note":"${word} note"},"nested":{${name}:["${word}"]}}`;
}

describe("an online host payload keeps every key it was given", () => {
	it("sweeps the keys Object.prototype defines, including __proto__", () => {
		expect(PROTOTYPE_KEYS).toContain("__proto__");
	});

	for (const key of PROTOTYPE_KEYS) {
		it(`keeps ${key} as an own field and sanitizes the strings under it`, async () => {
			let sent: string | undefined;
			setHostLlmBackend(
				new CallableLlmBackend(
					"online",
					async (_prompt, opts) => {
						sent = JSON.stringify(await opts?.onPayload?.(JSON.parse(payloadWith(key, "raw"))));
						return "ok";
					},
					{ online: true, supportsAttemptPayload: true },
				),
			);

			const result = await withMnemopiRuntimeOptions(
				{ llm: { sanitizeProviderText: text => text.replaceAll("raw", "clean") } },
				() => callHostLlm("the raw prompt"),
			);

			expect(result).toBe("ok");
			const expected = payloadWith(key, "clean").replace(
				JSON.stringify(MNEMOPI_LLM_ATTEMPT_PLACEHOLDER),
				JSON.stringify("the clean prompt"),
			);
			expect(sent).toBe(expected);
		});
	}
});
