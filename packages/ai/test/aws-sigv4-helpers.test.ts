import { describe, expect, it } from "bun:test";
import { formatAmzDate, getSigningKey, sha256, sha256Hex, signRequest, toHex } from "../src/providers/aws-sigv4";

describe("toHex", () => {
	it("converts empty array to empty string", () => {
		expect(toHex(new Uint8Array([]))).toBe("");
	});
	it("converts single byte 0", () => {
		expect(toHex(new Uint8Array([0]))).toBe("00");
	});
	it("converts single byte 255", () => {
		expect(toHex(new Uint8Array([255]))).toBe("ff");
	});
	it("converts multi-byte array", () => {
		expect(toHex(new Uint8Array([0, 15, 16, 255]))).toBe("000f10ff");
	});
	it("converts byte 10 to '0a'", () => {
		expect(toHex(new Uint8Array([10]))).toBe("0a");
	});
	it("converts byte 160 to 'a0'", () => {
		expect(toHex(new Uint8Array([160]))).toBe("a0");
	});
});

describe("sha256", () => {
	it("returns 32-byte digest for empty string", async () => {
		const result = await sha256("");
		expect(result).toBeInstanceOf(Uint8Array);
		expect(result.length).toBe(32);
	});
	it("returns 32-byte digest for non-empty string", async () => {
		const result = await sha256("hello");
		expect(result.length).toBe(32);
	});
	it("returns consistent digest for same input", async () => {
		const a = await sha256("test");
		const b = await sha256("test");
		expect(a).toEqual(b);
	});
	it("returns different digests for different inputs", async () => {
		const a = await sha256("test1");
		const b = await sha256("test2");
		expect(a).not.toEqual(b);
	});
	it("accepts Uint8Array input", async () => {
		const result = await sha256(new TextEncoder().encode("hello"));
		expect(result.length).toBe(32);
	});
});

describe("sha256Hex", () => {
	it("returns hex string of length 64", async () => {
		expect((await sha256Hex("")).length).toBe(64);
	});
	it("returns known hash for empty string", async () => {
		const emptySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
		expect(await sha256Hex("")).toBe(emptySha256);
	});
	it("returns lowercase hex", async () => {
		const result = await sha256Hex("test");
		expect(result).toBe(result.toLowerCase());
	});
});

describe("formatAmzDate", () => {
	it("formats a known date correctly", () => {
		const d = new Date("2024-01-15T10:30:45.000Z");
		const result = formatAmzDate(d);
		expect(result.longDate).toBe("20240115T103045Z");
		expect(result.shortDate).toBe("20240115");
	});
	it("formats epoch correctly", () => {
		const d = new Date(0);
		const result = formatAmzDate(d);
		expect(result.longDate).toBe("19700101T000000Z");
		expect(result.shortDate).toBe("19700101");
	});
	it("shortDate is first 8 chars of longDate", () => {
		const d = new Date("2025-06-07T12:00:00.000Z");
		const result = formatAmzDate(d);
		expect(result.shortDate).toBe(result.longDate.slice(0, 8));
	});
	it("pads single-digit months and days", () => {
		const d = new Date("2024-03-05T01:02:03.000Z");
		const result = formatAmzDate(d);
		expect(result.longDate).toBe("20240305T010203Z");
	});
});

describe("getSigningKey", () => {
	it("returns a 32-byte key", async () => {
		const key = await getSigningKey("secret", "20240115", "us-east-1", "bedrock");
		expect(key).toBeInstanceOf(Uint8Array);
		expect(key.length).toBe(32);
	});
	it("returns different keys for different secrets", async () => {
		const a = await getSigningKey("secret1", "20240115", "us-east-1", "bedrock");
		const b = await getSigningKey("secret2", "20240115", "us-east-1", "bedrock");
		expect(a).not.toEqual(b);
	});
	it("returns different keys for different regions", async () => {
		const a = await getSigningKey("secret", "20240115", "us-east-1", "bedrock");
		const b = await getSigningKey("secret", "20240115", "us-west-2", "bedrock");
		expect(a).not.toEqual(b);
	});
	it("returns consistent key for same inputs", async () => {
		const a = await getSigningKey("secret", "20240115", "us-east-1", "bedrock");
		const b = await getSigningKey("secret", "20240115", "us-east-1", "bedrock");
		expect(a).toEqual(b);
	});
});

describe("signRequest", () => {
	const creds = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
	const baseParams = {
		method: "POST" as const,
		host: "bedrock-runtime.us-east-1.amazonaws.com",
		path: "/model/foo/invoke",
		body: new TextEncoder().encode("{}"),
		region: "us-east-1",
		service: "bedrock",
		credentials: creds,
	};
	it("returns signed headers with authorization", async () => {
		const result = await signRequest(baseParams);
		expect(result.host).toBe("bedrock-runtime.us-east-1.amazonaws.com");
		expect(result.authorization).toContain("AWS4-HMAC-SHA256");
		expect(result["x-amz-date"]).toBeDefined();
		expect(result["x-amz-content-sha256"]).toBeDefined();
	});
	it("includes x-amz-security-token when sessionToken provided", async () => {
		const result = await signRequest({
			...baseParams,
			credentials: { ...creds, sessionToken: "session-token" },
		});
		expect(result["x-amz-security-token"]).toBe("session-token");
	});
	it("does not include x-amz-security-token when no sessionToken", async () => {
		const result = await signRequest(baseParams);
		expect(result["x-amz-security-token"]).toBeUndefined();
	});
	it("produces consistent signatures for same inputs and same date", async () => {
		const date = new Date("2024-01-15T10:30:45.000Z");
		const a = await signRequest({ ...baseParams, date });
		const b = await signRequest({ ...baseParams, date });
		expect(a.authorization).toBe(b.authorization);
	});
	it("produces different signatures for different dates", async () => {
		const a = await signRequest({ ...baseParams, date: new Date("2024-01-15T10:30:45.000Z") });
		const b = await signRequest({ ...baseParams, date: new Date("2024-01-16T10:30:45.000Z") });
		expect(a.authorization).not.toBe(b.authorization);
	});
});
