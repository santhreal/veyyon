import { describe, expect, it } from "bun:test";
import { buildNoImageResult } from "@veyyon/coding-agent/tools/image-gen";

/**
 * Sibling of `set-cwd-confirmation.test.ts`, guarding the same class of defect
 * from the other direction.
 *
 * `set_cwd` described a success in words that read as failure, and a real agent
 * looped on it. Image generation did the inverse: when a provider answered with
 * no image in it, every one of the five provider branches returned an ordinary
 * SUCCESS result whose text was `No image data returned.`, with no `isError` and
 * `imageCount: 0` buried in the details. A caller that asked for an image and
 * received a non-error result has been told the call worked, so it either
 * retries the identical prompt forever or proceeds as though a file exists on
 * disk. Neither happened.
 *
 * The rule both tests encode: a tool result must be readable, on its own, as the
 * thing that actually occurred. Success must look like success, failure must be
 * marked as failure, and each must say whether retrying is the right next move.
 */
describe("image generation reports an empty response as a failure", () => {
	const base = { provider: "gemini" as const, model: "gemini-3-pro-image-preview" };

	it("marks the result as an error rather than a plain success", () => {
		// REGRESSION, and the whole defect in one assertion. Without this the agent
		// loop records the call as `ok` and the model is told its request succeeded.
		expect(buildNoImageResult(base).isError).toBe(true);
	});

	it("says generation failed, not merely that no data came back", () => {
		const text = textOf(buildNoImageResult(base));

		expect(text).toContain("Image generation failed");
	});

	it("names the provider and model that failed", () => {
		// With six providers and an `auto` preference, the caller often does not know
		// which one ran. Retrying blind against the same broken provider is the
		// failure mode this prevents.
		const text = textOf(buildNoImageResult(base));

		expect(text).toContain("gemini");
		expect(text).toContain("gemini-3-pro-image-preview");
	});

	it("tells the caller a retry may work when the cause is unknown", () => {
		// An empty response with no stated reason is usually transient, so one retry
		// is the correct move and the result says so explicitly.
		const text = textOf(buildNoImageResult(base));

		expect(text).toContain("Retry once");
	});

	it("tells the caller NOT to retry when the provider gave a reason", () => {
		// A blocked prompt fails identically every time. This is the case where a
		// retry loop is guaranteed, so the guidance inverts.
		const text = textOf(buildNoImageResult({ ...base, reason: "the prompt was blocked (SAFETY)" }));

		expect(text).toContain("Retrying the same prompt will fail the same way");
		expect(text).not.toContain("Retry once");
	});

	it("surfaces the provider's stated reason in the text", () => {
		// Gemini's `promptFeedback.blockReason` is the single most actionable thing
		// the API returns here and it used to be the only branch that showed it.
		const text = textOf(buildNoImageResult({ ...base, reason: "the prompt was blocked (SAFETY)" }));

		expect(text).toContain("the prompt was blocked (SAFETY)");
	});

	it("includes any prose the provider returned alongside the empty result", () => {
		// Providers frequently explain the refusal in the message body instead of a
		// structured field. Dropping it discards the only explanation there is.
		const text = textOf(buildNoImageResult({ ...base, responseText: "I can't create that image." }));

		expect(text).toContain("I can't create that image.");
	});

	it("reports zero images and no paths in the details", () => {
		const result = buildNoImageResult(base);

		expect(result.details).toMatchObject({
			provider: "gemini",
			model: "gemini-3-pro-image-preview",
			imageCount: 0,
			imagePaths: [],
			images: [],
		});
	});

	it("carries provider-specific details through without dropping the base fields", () => {
		// The OpenAI branch reports a revised prompt and the Gemini branch reports
		// prompt feedback. Both used to be assembled inline, and the shared owner
		// must not lose them.
		const result = buildNoImageResult({
			...base,
			details: { revisedPrompt: "a cat, photorealistic", usage: { promptTokenCount: 12 } as never },
		});

		expect(result.details).toMatchObject({
			imageCount: 0,
			revisedPrompt: "a cat, photorealistic",
			usage: { promptTokenCount: 12 },
		});
	});

	it("omits responseText from the details when the provider sent none", () => {
		// Recording `responseText: undefined` would render as an empty explanation in
		// the transcript, which reads as "the provider said nothing" rather than
		// "there was nothing to say".
		const result = buildNoImageResult(base);

		expect(result.details && "responseText" in result.details).toBe(false);
	});

	it("never claims an image was generated", () => {
		// `buildResponseSummary`, the success path, opens with `Generated N image(s)`.
		// The failure path must share none of that wording, in any branch.
		for (const args of [
			base,
			{ ...base, reason: "the prompt was blocked (SAFETY)" },
			{ ...base, responseText: "here you go" },
		]) {
			expect(textOf(buildNoImageResult(args))).not.toContain("Generated");
		}
	});
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}
