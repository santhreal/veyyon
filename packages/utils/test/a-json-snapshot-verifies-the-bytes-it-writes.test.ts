/**
 * WHY: recomputing JSON for a digest duplicates startup work and can checksum
 * different data when a serializer is stateful. The shared snapshot boundary
 * verifies exact bytes, rejects obsolete fingerprints and malformed frames, and
 * preserves the previous snapshot when serialization fails. Domain record shapes
 * are validated by consumers; a digest is not authentication against another writer.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readJsonSnapshotSync, writeJsonSnapshotSync } from "../src/json-snapshot";

describe("integrity-framed JSON snapshots", () => {
	let directory: string;
	let file: string;
	const fingerprint = "v1:synthetic-input";

	beforeEach(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "json-snapshot-"));
		file = path.join(directory, "snapshot.json");
	});
	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

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

	it("returns a miss for an absent file or another input fingerprint", () => {
		expect(readJsonSnapshotSync(file, fingerprint)).toBeNull();
		writeJsonSnapshotSync(file, fingerprint, { value: 1 });
		expect(readJsonSnapshotSync(file, "v0:synthetic-input")).toBeNull();
		expect(readJsonSnapshotSync(file, "v1:other-input")).toBeNull();
	});

	const payload = '{"value":1}';
	const header = { fingerprint, payloadDigest: createHash("sha256").update(payload).digest("hex") };
	const invalidFrames = {
		"no separator": JSON.stringify({ ...header, value: 1 }),
		"invalid header": `{\n${payload}`,
		"non-record header": `[]\n${payload}`,
		"missing digest": `${JSON.stringify({ fingerprint })}\n${payload}`,
		"changed payload": `${JSON.stringify(header)}\n{"value":2}`,
		"truncated payload": `${JSON.stringify(header)}\n${payload.slice(0, -1)}`,
		"invalid JSON": `${JSON.stringify({ fingerprint, payloadDigest: createHash("sha256").update("{").digest("hex") })}\n{`,
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
