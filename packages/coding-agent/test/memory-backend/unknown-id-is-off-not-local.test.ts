/**
 * `resolveMemoryBackend` is the sole runtime selector. Anything that is not
 * the three named ids is `off` — including typos, empty string, and the
 * legacy `memories.enabled` flag, which this function never reads.
 *
 * Existing memory-backend-resolve.test.ts pins hindsight regardless of
 * `memories.enabled`, and local status. It does not pin:
 *
 *   - `"Local"` / `"OFF"` case
 *   - `""` / `"sqlite"` / `"on"`
 *   - `mnemopi` actually resolving to id mnemopi (dynamic import)
 *   - off remaining off even when `memories.enabled` is true
 *
 * Search/save on off without a session is already in that file; do not clone.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { resolveMemoryBackend } from "@veyyon/coding-agent/memory-backend";

describe("resolveMemoryBackend unknown ids are the off backend", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("returns off for the explicit off id", async () => {
		const settings = Settings.isolated({ "memory.backend": "off" });
		expect((await resolveMemoryBackend(settings)).id).toBe("off");
	});

	it("returns off for an empty backend id", async () => {
		const settings = Settings.isolated({ "memory.backend": "" });
		expect((await resolveMemoryBackend(settings)).id).toBe("off");
	});

	it("returns off for a typo, not a fuzzy match onto local", async () => {
		const settings = Settings.isolated({ "memory.backend": "locall" });
		expect((await resolveMemoryBackend(settings)).id).toBe("off");
	});

	it("returns off for sqlite / on / true, which are not backend ids", async () => {
		expect((await resolveMemoryBackend(Settings.isolated({ "memory.backend": "sqlite" }))).id).toBe(
			"off",
		);
		expect((await resolveMemoryBackend(Settings.isolated({ "memory.backend": "on" }))).id).toBe(
			"off",
		);
		expect((await resolveMemoryBackend(Settings.isolated({ "memory.backend": "true" }))).id).toBe(
			"off",
		);
	});

	it("does not treat 'Local' as local (ids are case-sensitive)", async () => {
		expect((await resolveMemoryBackend(Settings.isolated({ "memory.backend": "Local" }))).id).toBe(
			"off",
		);
	});

	it("does not treat 'Mnemopi' as mnemopi", async () => {
		expect((await resolveMemoryBackend(Settings.isolated({ "memory.backend": "Mnemopi" }))).id).toBe(
			"off",
		);
	});

	it("does not revive local just because memories.enabled is true", async () => {
		const settings = Settings.isolated({ "memory.backend": "off", "memories.enabled": true });
		expect((await resolveMemoryBackend(settings)).id).toBe("off");
	});

	it("still selects local when the id is exactly local, even if memories.enabled is false", async () => {
		const settings = Settings.isolated({ "memory.backend": "local", "memories.enabled": false });
		expect((await resolveMemoryBackend(settings)).id).toBe("local");
	});

	it("selects mnemopi by exact id", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		expect((await resolveMemoryBackend(settings)).id).toBe("mnemopi");
	});
});
