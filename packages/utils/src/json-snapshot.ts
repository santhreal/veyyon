import * as fs from "node:fs";
import { crc32 } from "node:zlib";
import { atomicWriteFileSync } from "./atomic-write";
import { tryParseJson } from "./json";
import { isRecord } from "./type-guards";

/**
 * Layout of the header line. A header without this exact value is a miss, so a
 * file framed by an earlier layout (a SHA-256 `payloadDigest`, a `stageDigest`,
 * or one JSON object) rebuilds instead of being served.
 */
const SNAPSHOT_FRAME_VERSION = 2;

/**
 * Read a disposable snapshot, verifying its frame version, input fingerprint,
 * payload length and payload CRC-32 before the single parse. The checksum
 * detects torn writes and on-disk corruption; it is not authentication against
 * another writer.
 */
export function readJsonSnapshotSync(filePath: string, fingerprint: string): unknown {
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(filePath);
	} catch {
		return null;
	}
	const split = bytes.indexOf(0x0a);
	if (split < 0) return null;
	const header = tryParseJson<unknown>(bytes.toString("utf8", 0, split));
	if (!isRecord(header) || header.frame !== SNAPSHOT_FRAME_VERSION || header.fingerprint !== fingerprint) {
		return null;
	}
	const payload = bytes.subarray(split + 1);
	if (header.bytes !== payload.length || header.crc32 !== crc32(payload)) return null;
	return tryParseJson(payload.toString("utf8"));
}

/** Serialize once and atomically replace a rebuildable cache; power-loss durability is unnecessary. */
export function writeJsonSnapshotSync(filePath: string, fingerprint: string, value: unknown): void {
	const payload = JSON.stringify(value);
	if (payload === undefined) throw new TypeError(`Snapshot payload is not JSON-serializable: ${filePath}`);
	const bytes = Buffer.from(payload);
	const header = Buffer.from(
		`${JSON.stringify({ frame: SNAPSHOT_FRAME_VERSION, fingerprint, bytes: bytes.length, crc32: crc32(bytes) })}\n`,
	);
	atomicWriteFileSync(filePath, Buffer.concat([header, bytes]), { fsync: false });
}
