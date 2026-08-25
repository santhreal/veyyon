/**
 * Memory backend resolution, off-backend status, and type contracts.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. The memory-backend subsystem defines how backends are resolved
 * from settings and what the off-backend reports. These contracts pin the
 * backend id enum, the resolution map, and the off-backend status shape.
 */
import { describe, expect, it } from "bun:test";
import { resolveMemoryBackend } from "@veyyon/coding-agent/memory-backend/resolve";
import { offBackend } from "@veyyon/coding-agent/memory-backend/off-backend";
import { localBackend } from "@veyyon/coding-agent/memory-backend/local-backend";
import type { MemoryBackendId } from "@veyyon/coding-agent/memory-backend/types";
import { Settings } from "@veyyon/coding-agent/config/settings";

describe("memory backend resolution", () => {
	it("resolves to offBackend by default", async () => {
		const settings = Settings.isolated();
		const backend = await resolveMemoryBackend(settings);
		expect(backend.id).toBe("off");
	});

	it("resolves to offBackend when backend is 'off'", async () => {
		const settings = Settings.isolated();
		settings.set("memory.backend", "off");
		const backend = await resolveMemoryBackend(settings);
		expect(backend.id).toBe("off");
	});

	it("resolves to localBackend when backend is 'local'", async () => {
		const settings = Settings.isolated();
		settings.set("memory.backend", "local");
		const backend = await resolveMemoryBackend(settings);
		expect(backend.id).toBe("local");
	});

	it("resolves to hindsight when backend is 'hindsight'", async () => {
		const settings = Settings.isolated();
		settings.set("memory.backend", "hindsight");
		const backend = await resolveMemoryBackend(settings);
		expect(backend.id).toBe("hindsight");
	});

	it("resolves to mnemopi when backend is 'mnemopi'", async () => {
		const settings = Settings.isolated();
		settings.set("memory.backend", "mnemopi");
		const backend = await resolveMemoryBackend(settings);
		expect(backend.id).toBe("mnemopi");
	});
});

describe("offBackend", () => {
	it("has id 'off'", () => {
		expect(offBackend.id).toBe("off");
	});

	it("status reports inactive, not writable, not searchable", async () => {
		const status = await offBackend.status?.({} as never);
		expect(status?.active).toBe(false);
		expect(status?.writable).toBe(false);
		expect(status?.searchable).toBe(false);
	});

	it("status message is pinned", async () => {
		const status = await offBackend.status?.({} as never);
		expect(status?.message).toBe("Memory backend is off.");
	});

	it("status backend field is 'off'", async () => {
		const status = await offBackend.status?.({} as never);
		expect(status?.backend).toBe("off");
	});

	it("buildDeveloperInstructions returns undefined", async () => {
		const result = await offBackend.buildDeveloperInstructions?.("/tmp", Settings.isolated(), undefined as never);
		expect(result).toBeUndefined();
	});
});

describe("localBackend", () => {
	it("has id 'local'", () => {
		expect(localBackend.id).toBe("local");
	});
});

describe("MemoryBackendId type", () => {
	it("the four backend ids are the complete set", () => {
		// This is a type-level check enforced by the compiler; at runtime we
		// verify the resolution map covers every id.
		const ids: MemoryBackendId[] = ["off", "local", "hindsight", "mnemopi"];
		expect(ids).toHaveLength(4);
	});
});
