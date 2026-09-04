/**
 * Every download veyyon performs is checked against a published `.sha256`
 * sidecar, and this parser decides what counts as a digest for all of them.
 *
 * It exists as one shared function because there were two readers of the same
 * format and they disagreed. The self-updater validated the token; the
 * native-addon provisioning took the first whitespace-delimited word and
 * lowercased it, whatever it was. Both fail closed, so neither shipped a bad
 * binary, but the loose one told the user the wrong thing: a rate-limit page or
 * a truncated sidecar came back as "checksum mismatch (expected <!doctype, got
 * a1b2...)", which reads as a corrupt download and sends them to re-download a
 * file that was never the problem.
 */
import { describe, expect, it } from "bun:test";
import { parseSha256Sidecar } from "../src/sha256-sidecar";

const DIGEST = "a".repeat(64);

describe("parseSha256Sidecar", () => {
	it("reads the digest out of real sha256sum output", () => {
		// The published format: two spaces, then the asset filename.
		expect(parseSha256Sidecar(`${DIGEST}  veyyon-linux-x64\n`)).toBe(DIGEST);
	});

	it("reads a bare digest with no filename", () => {
		expect(parseSha256Sidecar(DIGEST)).toBe(DIGEST);
	});

	it("lowercases an uppercase digest, so comparisons never depend on case", () => {
		// Bun's CryptoHasher emits lowercase hex; a sidecar generated on a tool
		// that emits uppercase would otherwise mismatch a byte-identical file.
		expect(parseSha256Sidecar(`${"A".repeat(64)}  veyyon-linux-x64`)).toBe("a".repeat(64));
	});

	it("tolerates the leading, trailing, and tab whitespace a sidecar can carry", () => {
		expect(parseSha256Sidecar(`\n  ${DIGEST}\t*veyyon.exe\r\n`)).toBe(DIGEST);
	});

	it("rejects an HTML error page instead of treating its first tag as a digest", () => {
		// The exact input that produced the misleading "checksum mismatch": GitHub
		// serving an error body where a sidecar was expected.
		expect(parseSha256Sidecar("<!DOCTYPE html>\n<html><body>Not Found</body></html>")).toBeNull();
	});

	it("rejects a rate-limit JSON body", () => {
		expect(parseSha256Sidecar('{"message":"API rate limit exceeded"}')).toBeNull();
	});

	it("rejects a truncated digest", () => {
		// A sidecar cut short by a dropped connection is the case a length-blind
		// reader is most likely to see and least likely to explain correctly.
		expect(parseSha256Sidecar(`${"a".repeat(63)}  veyyon-linux-x64`)).toBeNull();
	});

	it("rejects a digest with an extra character", () => {
		expect(parseSha256Sidecar(`${"a".repeat(65)}  veyyon-linux-x64`)).toBeNull();
	});

	it("rejects 64 characters that are not all hex", () => {
		// Length alone is not enough: `g` is not a hex digit, so this is not a
		// digest even though it is exactly the right size.
		expect(parseSha256Sidecar(`${"a".repeat(63)}g  veyyon-linux-x64`)).toBeNull();
	});

	it("rejects an empty body and a whitespace-only body", () => {
		expect(parseSha256Sidecar("")).toBeNull();
		expect(parseSha256Sidecar("   \n\t ")).toBeNull();
	});

	it("rejects a sidecar whose digest is not first", () => {
		// `sha256sum` never emits this order. Accepting it would mean scanning the
		// body for anything digest-shaped, which is how an attacker-influenced
		// field elsewhere in a response could be promoted to the expected hash.
		expect(parseSha256Sidecar(`veyyon-linux-x64  ${DIGEST}`)).toBeNull();
	});

	it("takes only the first line, never a second entry", () => {
		// A concatenated sidecar must not silently verify against the wrong asset.
		const two = `${DIGEST}  veyyon-linux-x64\n${"b".repeat(64)}  veyyon-darwin-arm64\n`;
		expect(parseSha256Sidecar(two)).toBe(DIGEST);
	});
});
