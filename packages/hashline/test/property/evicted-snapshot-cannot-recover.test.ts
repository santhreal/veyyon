/**
 * A snapshot the store has evicted cannot be written through Patcher.
 *
 * WHY THIS SUITE EXISTS. `InMemorySnapshotStore` already pins that per-path
 * history is sliced to `maxVersionsPerPath`, and Recovery already returns null
 * for an evicted hash (`recovery-tryrecover-null-matrix`). Those suites never
 * call `Patcher.apply`. A 4-hex tag that *was* recorded and then dropped is
 * still a well-formed header; if Patcher treated it as recoverable it would
 * rewrite a file it no longer has a binding for.
 *
 * Dead-tag / `MismatchError` wording suites exist. This file only pins: evicted
 * well-formed tag → throw, live bytes unchanged.
 */
import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	formatHashlineHeader,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	MismatchError,
	Patch,
	Patcher,
} from "@veyyon/hashline";

const PATH = "src/evict.ts";

describe("an evicted snapshot tag cannot write", () => {
	it("Patcher.apply throws MismatchError and leaves the live bytes when the section tag was evicted", async () => {
		const live = "v2\nunchanged-anchor\ntail-2\n";
		const fs = new InMemoryFilesystem([[PATH, live]]);
		const store = new InMemorySnapshotStore({ maxVersionsPerPath: 2 });
		const tag0 = store.record(PATH, "v0\nunchanged-anchor\ntail-0\n");
		store.record(PATH, "v1\nunchanged-anchor\ntail-1\n");
		store.record(PATH, live);
		expect(store.byHash(PATH, tag0)).toBeNull();

		const patcher = new Patcher({ fs, snapshots: store });
		const patch = Patch.parse([formatHashlineHeader(PATH, tag0), "SWAP 2.=2:", "+should-not-land"].join("\n"));
		await expect(patcher.apply(patch)).rejects.toBeInstanceOf(MismatchError);
		expect(fs.get(PATH)).toBe(live);
		expect(computeFileHash(fs.get(PATH) ?? "")).toBe(computeFileHash(live));
	});
});
