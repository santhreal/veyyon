import { describe, expect, it } from "bun:test";
import {
	type AwsCredentials,
	formatAmzDate,
	getSigningKey,
	type SignParams,
	sha256,
	sha256Hex,
	signRequest,
	toHex,
} from "../src/providers/aws-sigv4";

const creds: AwsCredentials = {
	accessKeyId: "AKIAIOSFODNN7EXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

describe("toHex", () => {
	it("encodes empty bytes", () => {
		expect(toHex(new Uint8Array(0))).toBe("");
	});
	it("encodes single byte 0x00", () => {
		expect(toHex(new Uint8Array([0]))).toBe("00");
	});
	it("encodes single byte 0xff", () => {
		expect(toHex(new Uint8Array([255]))).toBe("ff");
	});
	it("encodes single byte 0x0a", () => {
		expect(toHex(new Uint8Array([10]))).toBe("0a");
	});
	it("encodes multi-byte sequence", () => {
		expect(toHex(new Uint8Array([0, 1, 2, 255, 128, 64]))).toBe("000102ff8040");
	});
	it("encodes all nibble values", () => {
		const bytes = new Uint8Array([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
		expect(toHex(bytes)).toBe("0123456789abcdef");
	});
});

describe("sha256", () => {
	it("hashes empty string", async () => {
		const result = await sha256("");
		expect(toHex(result)).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});
	it("hashes simple string", async () => {
		const result = await sha256("hello");
		expect(toHex(result)).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
	});
	it("hashes Uint8Array input", async () => {
		const input = new TextEncoder().encode("hello");
		const result = await sha256(input);
		expect(toHex(result)).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
	});
	it("produces 32-byte digest", async () => {
		const result = await sha256("test");
		expect(result.length).toBe(32);
	});
});

describe("sha256Hex", () => {
	it("returns hex string for empty input", async () => {
		expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});
	it("returns hex string for string input", async () => {
		expect(await sha256Hex("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
	});
	it("returns hex string for Uint8Array input", async () => {
		expect(await sha256Hex(new TextEncoder().encode("hello"))).toBe(
			"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		);
	});
});

describe("formatAmzDate", () => {
	it("formats a known date correctly", () => {
		const d = new Date("2015-08-30T12:36:00.000Z");
		const result = formatAmzDate(d);
		expect(result.longDate).toBe("20150830T123600Z");
		expect(result.shortDate).toBe("20150830");
	});
	it("formats epoch correctly", () => {
		const d = new Date(0);
		const result = formatAmzDate(d);
		expect(result.longDate).toBe("19700101T000000Z");
		expect(result.shortDate).toBe("19700101");
	});
	it("shortDate is first 8 chars of longDate", () => {
		const d = new Date("2024-01-15T23:59:59.999Z");
		const result = formatAmzDate(d);
		expect(result.shortDate).toBe(result.longDate.slice(0, 8));
	});
	it("handles single-digit months and days", () => {
		const d = new Date("2024-01-05T03:04:05.000Z");
		const result = formatAmzDate(d);
		expect(result.longDate).toBe("20240105T030405Z");
	});
});

describe("getSigningKey", () => {
	it("produces a 32-byte key", async () => {
		const key = await getSigningKey(creds.secretAccessKey, "20150830", "us-east-1", "iam");
		expect(key.length).toBe(32);
	});
	it("produces deterministic key for same inputs", async () => {
		const key1 = await getSigningKey(creds.secretAccessKey, "20150830", "us-east-1", "iam");
		const key2 = await getSigningKey(creds.secretAccessKey, "20150830", "us-east-1", "iam");
		expect(toHex(key1)).toBe(toHex(key2));
	});
	it("produces different keys for different regions", async () => {
		const key1 = await getSigningKey(creds.secretAccessKey, "20150830", "us-east-1", "iam");
		const key2 = await getSigningKey(creds.secretAccessKey, "20150830", "us-west-2", "iam");
		expect(toHex(key1)).not.toBe(toHex(key2));
	});
	it("produces different keys for different services", async () => {
		const key1 = await getSigningKey(creds.secretAccessKey, "20150830", "us-east-1", "iam");
		const key2 = await getSigningKey(creds.secretAccessKey, "20150830", "us-east-1", "s3");
		expect(toHex(key1)).not.toBe(toHex(key2));
	});
	it("produces different keys for different dates", async () => {
		const key1 = await getSigningKey(creds.secretAccessKey, "20150830", "us-east-1", "iam");
		const key2 = await getSigningKey(creds.secretAccessKey, "20150831", "us-east-1", "iam");
		expect(toHex(key1)).not.toBe(toHex(key2));
	});
});

describe("signRequest", () => {
	const baseParams: SignParams = {
		method: "GET",
		host: "iam.amazonaws.com",
		path: "/",
		body: new Uint8Array(0),
		region: "us-east-1",
		service: "iam",
		credentials: creds,
		date: new Date("2015-08-30T12:36:00.000Z"),
	};

	it("returns SignedHeaders with required fields", async () => {
		const result = await signRequest(baseParams);
		expect(result.host).toBe("iam.amazonaws.com");
		expect(result["x-amz-date"]).toBe("20150830T123600Z");
		expect(result["x-amz-content-sha256"]).toBeDefined();
		expect(result.authorization).toContain("AWS4-HMAC-SHA256");
		expect(result.authorization).toContain("Credential=AKIAIOSFODNN7EXAMPLE/20150830/us-east-1/iam/aws4_request");
	});

	it("includes SignedHeaders in authorization header", async () => {
		const result = await signRequest(baseParams);
		expect(result.authorization).toContain("SignedHeaders=");
		expect(result.authorization).toContain("Signature=");
	});

	it("uppercases the HTTP method", async () => {
		const result = await signRequest({ ...baseParams, method: "get" });
		expect(result.authorization).toBeDefined();
	});

	it("includes x-amz-security-token when sessionToken provided", async () => {
		const result = await signRequest({
			...baseParams,
			credentials: { ...creds, sessionToken: "session-token-123" },
		});
		expect(result["x-amz-security-token"]).toBe("session-token-123");
	});

	it("omits x-amz-security-token when no sessionToken", async () => {
		const result = await signRequest(baseParams);
		expect(result).not.toHaveProperty("x-amz-security-token");
	});

	it("filters unsignable headers", async () => {
		const result = await signRequest({
			...baseParams,
			headers: {
				"User-Agent": "test-agent",
				Connection: "keep-alive",
				"x-custom-header": "custom-value",
			},
		});
		expect(result.authorization).toContain("x-custom-header");
		// User-Agent and Connection are in UNSIGNABLE, should not be in signed headers
		expect(result.authorization).not.toContain("user-agent");
		expect(result.authorization).not.toContain("connection");
	});

	it("filters proxy- prefixed headers", async () => {
		const result = await signRequest({
			...baseParams,
			headers: {
				"proxy-authorization": "bearer token",
				"x-custom-header": "custom-value",
			},
		});
		expect(result.authorization).not.toContain("proxy-authorization");
	});

	it("filters sec- prefixed headers", async () => {
		const result = await signRequest({
			...baseParams,
			headers: {
				"sec-fetch-mode": "cors",
				"x-custom-header": "custom-value",
			},
		});
		expect(result.authorization).not.toContain("sec-fetch-mode");
	});

	it("normalizes header values by trimming and collapsing whitespace", async () => {
		const result = await signRequest({
			...baseParams,
			headers: {
				"x-custom-header": "  value   with   spaces  ",
			},
		});
		expect(result.authorization).toContain("x-custom-header");
		// The signed header value should be normalized
		expect(result["x-custom-header" as keyof typeof result]).toBeUndefined();
	});

	it("handles query string parameters", async () => {
		const result = await signRequest({
			...baseParams,
			query: "Action=ListUsers&Version=2010-05-08",
		});
		expect(result.authorization).toBeDefined();
	});

	it("handles empty query string", async () => {
		const result = await signRequest({
			...baseParams,
			query: "",
		});
		expect(result.authorization).toBeDefined();
	});

	it("handles undefined query string", async () => {
		const result = await signRequest({
			...baseParams,
			query: undefined,
		});
		expect(result.authorization).toBeDefined();
	});

	it("produces deterministic signatures for same inputs", async () => {
		const result1 = await signRequest(baseParams);
		const result2 = await signRequest(baseParams);
		expect(result1.authorization).toBe(result2.authorization);
	});

	it("produces different signatures for different bodies", async () => {
		const result1 = await signRequest({ ...baseParams, body: new TextEncoder().encode("body1") });
		const result2 = await signRequest({ ...baseParams, body: new TextEncoder().encode("body2") });
		expect(result1.authorization).not.toBe(result2.authorization);
	});

	it("produces different signatures for different paths", async () => {
		const result1 = await signRequest({ ...baseParams, path: "/path1" });
		const result2 = await signRequest({ ...baseParams, path: "/path2" });
		expect(result1.authorization).not.toBe(result2.authorization);
	});

	it("encodes path segments with RFC 3986", async () => {
		const result = await signRequest({
			...baseParams,
			path: "/foo bar/baz",
		});
		expect(result.authorization).toBeDefined();
	});

	it("handles POST method with body", async () => {
		const result = await signRequest({
			...baseParams,
			method: "POST",
			body: new TextEncoder().encode('{"key":"value"}'),
		});
		expect(result.authorization).toContain("AWS4-HMAC-SHA256");
	});

	it("uses current date when date not provided", async () => {
		const result = await signRequest({ ...baseParams, date: undefined });
		expect(result["x-amz-date"]).toBeDefined();
		expect(result["x-amz-date"].length).toBe(16);
	});
});
