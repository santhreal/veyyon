import { describe, expect, it } from "bun:test";
import { extractGoogleValidationUrl, formatGoogleValidationRequiredMessage } from "../src/utils/google-validation";

describe("extractGoogleValidationUrl", () => {
	it("returns undefined when VALIDATION_REQUIRED is not in body", () => {
		expect(extractGoogleValidationUrl("some error message")).toBeUndefined();
	});

	it("returns undefined when no JSON object in body", () => {
		expect(extractGoogleValidationUrl("VALIDATION_REQUIRED but no json")).toBeUndefined();
	});

	it("extracts validation URL from valid JSON", () => {
		const body = JSON.stringify({
			error: {
				details: [
					{
						reason: "VALIDATION_REQUIRED",
						metadata: { validation_url: "https://verify.example.com" },
					},
				],
			},
		});
		expect(extractGoogleValidationUrl(body)).toBe("https://verify.example.com");
	});

	it("returns undefined when detail reason is not VALIDATION_REQUIRED", () => {
		const body = JSON.stringify({
			error: {
				details: [
					{
						reason: "OTHER_REASON",
						metadata: { validation_url: "https://verify.example.com" },
					},
				],
			},
		});
		expect(extractGoogleValidationUrl(body)).toBeUndefined();
	});

	it("returns undefined when validation_url is missing", () => {
		const body = JSON.stringify({
			error: {
				details: [{ reason: "VALIDATION_REQUIRED", metadata: {} }],
			},
		});
		expect(extractGoogleValidationUrl(body)).toBeUndefined();
	});

	it("returns undefined when validation_url is not a string", () => {
		const body = JSON.stringify({
			error: {
				details: [{ reason: "VALIDATION_REQUIRED", metadata: { validation_url: 123 } }],
			},
		});
		expect(extractGoogleValidationUrl(body)).toBeUndefined();
	});

	it("returns undefined when details array is empty", () => {
		const body = JSON.stringify({
			error: { details: [] },
		});
		expect(extractGoogleValidationUrl(body)).toBeUndefined();
	});

	it("returns undefined when details is missing", () => {
		const body = JSON.stringify({ error: {} });
		expect(extractGoogleValidationUrl(body)).toBeUndefined();
	});

	it("returns undefined when error is missing", () => {
		const body = JSON.stringify({});
		expect(extractGoogleValidationUrl(body)).toBeUndefined();
	});

	it("returns undefined for invalid JSON", () => {
		expect(extractGoogleValidationUrl("VALIDATION_REQUIRED {invalid json}")).toBeUndefined();
	});

	it("extracts URL from body with text before JSON", () => {
		const body = `Error occurred: ${JSON.stringify({
			error: {
				details: [
					{
						reason: "VALIDATION_REQUIRED",
						metadata: { validation_url: "https://verify.example.com" },
					},
				],
			},
		})}`;
		expect(extractGoogleValidationUrl(body)).toBe("https://verify.example.com");
	});

	it("finds first VALIDATION_REQUIRED detail among multiple", () => {
		const body = JSON.stringify({
			error: {
				details: [
					{ reason: "OTHER", metadata: { validation_url: "https://wrong.com" } },
					{
						reason: "VALIDATION_REQUIRED",
						metadata: { validation_url: "https://correct.com" },
					},
				],
			},
		});
		expect(extractGoogleValidationUrl(body)).toBe("https://correct.com");
	});

	it("handles empty string", () => {
		expect(extractGoogleValidationUrl("")).toBeUndefined();
	});
});

describe("formatGoogleValidationRequiredMessage", () => {
	it("formats message with URL and next action", () => {
		const msg = formatGoogleValidationRequiredMessage("https://verify.example.com", "retry");
		expect(msg).toContain("https://verify.example.com");
		expect(msg).toContain("retry");
		expect(msg).toContain("Account verification required");
	});

	it("includes email when provided", () => {
		const msg = formatGoogleValidationRequiredMessage("https://verify.example.com", "retry", "user@example.com");
		expect(msg).toContain("for user@example.com");
	});

	it("omits email section when not provided", () => {
		const msg = formatGoogleValidationRequiredMessage("https://verify.example.com", "retry");
		expect(msg).not.toContain("for ");
	});

	it("omits email section when email is undefined", () => {
		const msg = formatGoogleValidationRequiredMessage("https://verify.example.com", "retry", undefined);
		expect(msg).not.toContain("for undefined");
	});

	it("includes 'to continue' in message", () => {
		const msg = formatGoogleValidationRequiredMessage("https://verify.example.com", "retry");
		expect(msg).toContain("to continue");
	});
});
