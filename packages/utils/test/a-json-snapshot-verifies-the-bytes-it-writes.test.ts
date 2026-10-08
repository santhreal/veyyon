/**
 * WHY: a snapshot is a rebuildable cache read on every launch. Recomputing JSON
 * or a cryptographic digest to verify it duplicates startup work, and a reader
 * that accepts a frame it does not fully check serves stale or corrupt state.
 * The class closed here: a snapshot served from bytes other than the ones the
 * current frame layout wrote for this fingerprint. The sweeps derive the header
 * fields from a file the writer produced, so a new header field the reader does
 * not verify fails here; every retired layout, every truncation and every single
 * flipped payload bit must miss. Two frames whose payload differs from its
 * re-serialization fail a reader that checksums `JSON.stringify` of the parsed
 * value instead of the bytes on disk. A failed serialization preserves the prior
 * file.
 *
 * Not caught: a same-length payload rewrite whose CRC-32 collides (2^-32 per
 * accidental change), and a reader that parses twice, which returns the same
 * value. CRC-32 detects accidental corruption and is not authentication against
 * another writer; consumers validate record shapes.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { crc32 } from "node:zlib";
import { readJsonSnapshotSync, writeJsonSnapshotSync } from "../src/json-snapshot";

describe("integrity-framed JSON snapshots", () => {
	let directory: string;
	let file: string;
	const fingerprint = "v1:synthetic-input";
	const payload = '{"value":1}';

	beforeEach(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "json-snapshot-"));
		file = path.join(directory, "snapshot.json");
	});
	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	/** The header line and payload bytes of the file the writer produced. */
	const writtenFrame = (): { header: Record<string, unknown>; body: Buffer } => {
		writeJsonSnapshotSync(file, fingerprint, JSON.parse(payload));
		const bytes = fs.readFileSync(file);
		const split = bytes.indexOf(0x0a);
		return {
			header: JSON.parse(bytes.toString("utf8", 0, split)) as Record<string, unknown>,
			body: bytes.subarray(split + 1),
		};
	};
	const writeFrame = (header: unknown, body: string | Buffer): void => {
		fs.writeFileSync(file, Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), Buffer.from(body)]));
	};

	it("persists the first serialization, including escaped delimiters and Unicode", () => {
		let revision = 0;
		writeJsonSnapshotSync(file, fingerprint, {
			toJSON() {
				return { revision: ++revision, text: "line\nreturn\rtab\t零\u0000", values: [false, 0, "", null] };
			},
		});
		expect(readJsonSnapshotSync(file, fingerprint)).toEqual({
			revision: 1,
			text: "line\nreturn\rtab\t零\u0000",
			values: [false, 0, "", null],
		});
		expect(fs.readdirSync(directory)).toEqual(["snapshot.json"]);
	});

	it("frames the payload with layout version 2, its byte length and its CRC-32", () => {
		const { header, body } = writtenFrame();
		expect(body.toString("utf8")).toBe(payload);
		expect(header).toEqual({ frame: 2, fingerprint, bytes: body.length, crc32: crc32(body) });
		expect(readJsonSnapshotSync(file, fingerprint)).toEqual({ value: 1 });
	});

	it("returns a miss for an absent file or another input fingerprint", () => {
		expect(readJsonSnapshotSync(file, fingerprint)).toBeNull();
		writeJsonSnapshotSync(file, fingerprint, { value: 1 });
		expect(readJsonSnapshotSync(file, "v0:synthetic-input")).toBeNull();
		expect(readJsonSnapshotSync(file, "v1:other-input")).toBeNull();
	});

	it("rejects a header with any written field removed or altered", () => {
		const { header, body } = writtenFrame();
		const fields = Object.keys(header);
		const served: string[] = [];
		for (const field of fields) {
			const value = header[field];
			const altered = typeof value === "number" ? value + 1 : `${String(value)}x`;
			const { [field]: _removed, ...without } = header;
			for (const [variant, variantHeader] of [
				["removed", without],
				["altered", { ...header, [field]: altered }],
			] as const) {
				writeFrame(variantHeader, body);
				if (readJsonSnapshotSync(file, fingerprint) !== null) served.push(`${field} ${variant}`);
			}
		}
		expect(served).toEqual([]);
	});

	it("rejects every single flipped payload bit", () => {
		const { header, body } = writtenFrame();
		const served: string[] = [];
		for (let index = 0; index < body.length; index++) {
			for (let bit = 0; bit < 8; bit++) {
				const flipped = Buffer.from(body);
				flipped[index]! ^= 1 << bit;
				writeFrame(header, flipped);
				if (readJsonSnapshotSync(file, fingerprint) !== null) served.push(`byte ${index} bit ${bit}`);
			}
		}
		expect(served).toEqual([]);
	});

	it("rejects every truncation and every appended byte", () => {
		const { header, body } = writtenFrame();
		const served: number[] = [];
		for (let length = 0; length < body.length; length++) {
			writeFrame(header, body.subarray(0, length));
			if (readJsonSnapshotSync(file, fingerprint) !== null) served.push(length);
		}
		writeFrame(header, Buffer.concat([body, Buffer.from(" ")]));
		if (readJsonSnapshotSync(file, fingerprint) !== null) served.push(body.length + 1);
		expect(served).toEqual([]);
	});

	const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
	const current = { frame: 2, fingerprint, bytes: Buffer.byteLength(payload), crc32: crc32(payload) };
	// Same value as `payload`, other bytes: a reader that re-serializes the parsed
	// value to verify it checksums `payload` instead of what is on disk.
	const spaced = '{ "value": 1 }';

	it("verifies the payload bytes read from disk, not a re-serialization of them", () => {
		writeFrame({ ...current, bytes: Buffer.byteLength(spaced), crc32: crc32(spaced) }, spaced);
		expect(readJsonSnapshotSync(file, fingerprint)).toEqual({ value: 1 });
	});

	const invalidFrames = {
		"no separator": JSON.stringify({ ...current, value: 1 }),
		"invalid header": `{\n${payload}`,
		"non-record header": `[]\n${payload}`,
		"retired SHA-256 frame": `${JSON.stringify({ fingerprint, payloadDigest: sha256(payload) })}\n${payload}`,
		"retired stage-digest frame": `${JSON.stringify({ fingerprint, stageDigest: sha256(payload) })}\n${payload}`,
		"retired single object": JSON.stringify({ fingerprint, stage: JSON.parse(payload) }),
		"earlier frame version": `${JSON.stringify({ ...current, frame: 1 })}\n${payload}`,
		"length that disagrees with a matching checksum": `${JSON.stringify({ ...current, bytes: current.bytes + 1 })}\n${payload}`,
		"checksum of another same-length payload": `${JSON.stringify({ ...current, crc32: crc32('{"value":2}') })}\n${payload}`,
		"invalid JSON under a matching frame": `${JSON.stringify({ ...current, bytes: 1, crc32: crc32("{") })}\n{`,
		"checksum of the re-serialized payload rather than its bytes": `${JSON.stringify({ ...current, bytes: Buffer.byteLength(spaced) })}\n${spaced}`,
	};
	it.each(Object.entries(invalidFrames))("rejects a frame with %s", (_defect, frame) => {
		fs.writeFileSync(file, frame);
		expect(readJsonSnapshotSync(file, fingerprint)).toBeNull();
	});

	const cyclic: { self?: unknown } = {};
	cyclic.self = cyclic;
	const unserializableValues = {
		undefined,
		cycle: cyclic,
		"throwing serializer": {
			toJSON() {
				throw new Error("serialization failed");
			},
		},
	};
	it.each(Object.entries(unserializableValues))("preserves a prior snapshot on %s", (_failure, value) => {
		writeJsonSnapshotSync(file, fingerprint, { value: "prior" });
		expect(() => writeJsonSnapshotSync(file, fingerprint, value)).toThrow();
		expect(readJsonSnapshotSync(file, fingerprint)).toEqual({ value: "prior" });
		expect(fs.readdirSync(directory)).toEqual(["snapshot.json"]);
	});
});
