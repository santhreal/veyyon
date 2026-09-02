/**
 * WHY: upstream model catalogs (models.dev, OpenRouter, Novita, etc.) declare
 * modal capabilities per model via modality arrays. `toInputCapabilities` is
 * the single gateway function that normalises upstream modality lists into
 * Veyyon's `("text" | "image" | "video")[]` input capability representation.
 *
 * It must:
 * 1. Preserve "video" when declared upstream alongside "text" and "image".
 * 2. Filter out unsupported modalities (e.g. "audio", "file") while preserving
 *    valid inputs.
 * 3. Fall back safely to ["text"] for empty or non-array inputs.
 */
import { describe, expect, it } from "bun:test";
import { toInputCapabilities } from "@veyyon/catalog/provider-models/openai-compat";

describe("toInputCapabilities", () => {
	it("yields all three modalities when input includes text, image, and video", () => {
		const result = toInputCapabilities(["text", "image", "video"]);
		expect(result).toEqual(["text", "image", "video"]);
	});

	it("yields only text when given text and audio", () => {
		const result = toInputCapabilities(["text", "audio"]);
		expect(result).toEqual(["text"]);
	});

	it("yields text and video when given only video", () => {
		const result = toInputCapabilities(["video"]);
		expect(result).toEqual(["text", "video"]);
	});

	it("yields text for non-array or empty inputs", () => {
		expect(toInputCapabilities(undefined)).toEqual(["text"]);
		expect(toInputCapabilities(null)).toEqual(["text"]);
		expect(toInputCapabilities("text")).toEqual(["text"]);
		expect(toInputCapabilities([])).toEqual(["text"]);
	});
});
