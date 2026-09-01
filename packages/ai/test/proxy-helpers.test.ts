import { describe, expect, it } from "bun:test";
import { isLocalOrMetadataHost } from "../src/utils/proxy";

describe("isLocalOrMetadataHost", () => {
	it("returns true for 'localhost'", () => {
		expect(isLocalOrMetadataHost("localhost")).toBe(true);
	});
	it("returns true for 'LOCALHOST' (case-insensitive)", () => {
		expect(isLocalOrMetadataHost("LOCALHOST")).toBe(true);
	});
	it("returns true for '.localhost' subdomain", () => {
		expect(isLocalOrMetadataHost("api.localhost")).toBe(true);
	});
	it("returns true for 'metadata.google.internal'", () => {
		expect(isLocalOrMetadataHost("metadata.google.internal")).toBe(true);
	});
	it("returns true for 127.0.0.1", () => {
		expect(isLocalOrMetadataHost("127.0.0.1")).toBe(true);
	});
	it("returns true for 127.0.0.2", () => {
		expect(isLocalOrMetadataHost("127.0.0.2")).toBe(true);
	});
	it("returns true for 127.255.255.255", () => {
		expect(isLocalOrMetadataHost("127.255.255.255")).toBe(true);
	});
	it("returns false for 128.0.0.1", () => {
		expect(isLocalOrMetadataHost("128.0.0.1")).toBe(false);
	});
	it("returns true for 169.254.169.254 (link-local)", () => {
		expect(isLocalOrMetadataHost("169.254.169.254")).toBe(true);
	});
	it("returns true for ::1", () => {
		expect(isLocalOrMetadataHost("::1")).toBe(true);
	});
	it("returns true for ::", () => {
		expect(isLocalOrMetadataHost("::")).toBe(true);
	});
	it("returns true for IPv6 link-local fe80::", () => {
		expect(isLocalOrMetadataHost("fe80::1")).toBe(true);
	});
	it("returns true for IPv6 unique local fc00::", () => {
		expect(isLocalOrMetadataHost("fc00::1")).toBe(true);
	});
	it("returns true for IPv6 unique local fd00::", () => {
		expect(isLocalOrMetadataHost("fd00::1")).toBe(true);
	});
	it("returns false for public IPv4", () => {
		expect(isLocalOrMetadataHost("8.8.8.8")).toBe(false);
	});
	it("returns false for public hostname", () => {
		expect(isLocalOrMetadataHost("api.openai.com")).toBe(false);
	});
	it("returns true for 10.x.x.x (private)", () => {
		expect(isLocalOrMetadataHost("10.0.0.1")).toBe(true);
	});
	it("returns true for 192.168.x.x (private)", () => {
		expect(isLocalOrMetadataHost("192.168.1.1")).toBe(true);
	});
	it("returns true for 172.16.x.x (private)", () => {
		expect(isLocalOrMetadataHost("172.16.0.1")).toBe(true);
	});
	it("returns true for 172.31.x.x (private)", () => {
		expect(isLocalOrMetadataHost("172.31.0.1")).toBe(true);
	});
	it("returns false for 172.32.x.x (not private)", () => {
		expect(isLocalOrMetadataHost("172.32.0.1")).toBe(false);
	});
	it("returns true for 0.0.0.0 (current network)", () => {
		expect(isLocalOrMetadataHost("0.0.0.0")).toBe(true);
	});
	it("returns true for 169.254.x.x (link-local)", () => {
		expect(isLocalOrMetadataHost("169.254.1.1")).toBe(true);
	});
	it("handles IPv6 in brackets", () => {
		expect(isLocalOrMetadataHost("[::1]")).toBe(true);
	});
});
