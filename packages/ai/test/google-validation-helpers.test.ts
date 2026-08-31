import { describe, expect, it } from "bun:test";
import { extractGoogleValidationUrl, formatGoogleValidationRequiredMessage } from "../src/utils/google-validation";

describe("extractGoogleValidationUrl", () => {
	it("returns undefined for body without VALIDATION_REQUIRED", () => {
		expect(extractGoogleValidationUrl("some error body")).toBeUndefined();
	});
	it("returns undefined for empty string", () => {
		expect(extractGoogleValidationUrl("")).toBeUndefined();
	});
	it("returns undefined when VALIDATION_REQUIRED present but no JSON", () => {
		expect(extractGoogleValidationUrl("VALIDATION_REQUIRED no json here")).toBeUndefined();
	});
	it("returns undefined when JSON has no validation_url", () => {
		const body = JSON.stringify({
			error: { details: [{ reason: "VALIDATION_REQUIRED", metadata: {} }] },
		});
		expect(extractGoogleValidationUrl(body)).toBeUndefined();
	});
	it("extracts validation_url from valid JSON", () => {
		const body = JSON.stringify({
			error: {
				details: [
					{
						reason: "VALIDATION_REQUIRED",
						metadata: { validation_url: "https://verify.example.com/abc" },
					},
				],
			},
		});
		expect(extractGoogleValidationUrl(body)).toBe("https://verify.example.com/abc");
	});
	it("extracts from body with leading text before JSON", () => {
		const body = `Error occurred: VALIDATION_REQUIRED ${JSON.stringify({
			error: {
				details: [
					{
						reason: "VALIDATION_REQUIRED",
						metadata: { validation_url: "https://verify.example.com/xyz" },
					},
				],
			},
		})}`;
		expect(extractGoogleValidationUrl(body)).toBe("https://verify.example.com/xyz");
	});
	it("skips details with wrong reason", () => {
		const body = JSON.stringify({
			error: {
				details: [
					{ reason: "OTHER_REASON", metadata: { validation_url: "https://wrong.com" } },
					{
						reason: "VALIDATION_REQUIRED",
						metadata: { validation_url: "https://right.com" },
					},
				],
			},
		});
		expect(extractGoogleValidationUrl(body)).toBe("https://right.com");
	});
	it("skips details where validation_url is not a string", () => {
		const body = JSON.stringify({
			error: {
				details: [{ reason: "VALIDATION_REQUIRED", metadata: { validation_url: 42 } }],
			},
		});
		expect(extractGoogleValidationUrl(body)).toBeUndefined();
	});
	it("returns undefined for malformed JSON after brace", () => {
		expect(extractGoogleValidationUrl("VALIDATION_REQUIRED {bad json")).toBeUndefined();
	});
	it("returns undefined when details array is empty", () => {
		const body = JSON.stringify({ error: { details: [] } });
		expect(extractGoogleValidationUrl(body)).toBeUndefined();
	});
	it("returns undefined when error is missing", () => {
		const body = JSON.stringify({ something: "else" });
		expect(extractGoogleValidationUrl(body)).toBeUndefined();
	});
	it("returns undefined when details is missing", () => {
		const body = JSON.stringify({ error: {} });
		expect(extractGoogleValidationUrl(body)).toBeUndefined();
	});
});

describe("formatGoogleValidationRequiredMessage", () => {
	it("formats message with URL and next action", () => {
		const msg = formatGoogleValidationRequiredMessage("https://verify.example.com", "retry the request");
		expect(msg).toBe(
			"Account verification required. Visit https://verify.example.com to continue, then retry the request.",
		);
	});
	it("includes email when provided", () => {
		const msg = formatGoogleValidationRequiredMessage("https://verify.example.com", "retry", "user@example.com");
		expect(msg).toBe(
			"Account verification required for user@example.com. Visit https://verify.example.com to continue, then retry.",
		);
	});
	it("omits email when not provided", () => {
		const msg = formatGoogleValidationRequiredMessage("https://verify.example.com", "retry");
		expect(msg).not.toContain(" for ");
	});
	it("omits email when undefined", () => {
		const msg = formatGoogleValidationRequiredMessage("https://verify.example.com", "retry", undefined);
		expect(msg).toBe("Account verification required. Visit https://verify.example.com to continue, then retry.");
	});
});
