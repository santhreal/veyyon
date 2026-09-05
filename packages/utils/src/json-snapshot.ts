import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { atomicWriteFileSync } from "./atomic-write";
import { isRecord } from "./type-guards";

/** Read a disposable snapshot, verifying its input fingerprint and exact payload bytes. */
export function readJsonSnapshotSync(filePath: string, fingerprint: string): unknown {
	try {
		const bytes = fs.readFileSync(filePath);
		const split = bytes.indexOf(0x0a);
		if (split < 0) return null;
		const header: unknown = JSON.parse(bytes.toString("utf8", 0, split));
		if (!isRecord(header) || header.fingerprint !== fingerprint || typeof header.payloadDigest !== "string") {
			return null;
		}
		const payload = bytes.subarray(split + 1);
		if (createHash("sha256").update(payload).digest("hex") !== header.payloadDigest) return null;
		return JSON.parse(payload.toString("utf8"));
	} catch {
		return null;
	}
}

/** Serialize once and atomically replace a rebuildable cache; power-loss durability is unnecessary. */
export function writeJsonSnapshotSync(filePath: string, fingerprint: string, value: unknown): void {
	const payload = JSON.stringify(value);
	if (payload === undefined) throw new TypeError(`Snapshot payload is not JSON-serializable: ${filePath}`);
	const bytes = Buffer.from(payload);
	const payloadDigest = createHash("sha256").update(bytes).digest("hex");
	const header = Buffer.from(`${JSON.stringify({ fingerprint, payloadDigest })}\n`);
	atomicWriteFileSync(filePath, Buffer.concat([header, bytes]), { fsync: false });
}
