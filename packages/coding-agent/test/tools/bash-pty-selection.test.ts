import { afterEach, describe, expect, it } from "bun:test";
import { canUseInteractiveBashPty } from "@veyyon/pi-coding-agent/tools/bash-pty-selection";

const originalPlatform = process.platform;
const originalNoPty = Bun.env.PI_NO_PTY;
const originalVeyyonNoPty = Bun.env.VEYYON_NO_PTY;
const originalOmpNoPty = Bun.env.OMP_NO_PTY;

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		value: platform,
		configurable: true,
		writable: true,
	});
}

function restorePlatform(): void {
	Object.defineProperty(process, "platform", {
		value: originalPlatform,
		configurable: true,
		writable: true,
	});
}

function clearNoPtyAliases(): void {
	delete Bun.env.PI_NO_PTY;
	delete Bun.env.VEYYON_NO_PTY;
	delete Bun.env.OMP_NO_PTY;
}

function setNoPty(value: string | undefined, key: "PI_NO_PTY" | "VEYYON_NO_PTY" | "OMP_NO_PTY" = "PI_NO_PTY"): void {
	clearNoPtyAliases();
	if (value === undefined) return;
	Bun.env[key] = value;
}

function interactiveContext() {
	return { hasUI: true, ui: {} };
}

describe("bash PTY selection", () => {
	afterEach(() => {
		restorePlatform();
		clearNoPtyAliases();
		if (originalNoPty !== undefined) Bun.env.PI_NO_PTY = originalNoPty;
		if (originalVeyyonNoPty !== undefined) Bun.env.VEYYON_NO_PTY = originalVeyyonNoPty;
		if (originalOmpNoPty !== undefined) Bun.env.OMP_NO_PTY = originalOmpNoPty;
	});

	it("allows interactive PTY on Windows when requested with UI", () => {
		setPlatform("win32");
		setNoPty(undefined);

		expect(canUseInteractiveBashPty(true, interactiveContext())).toBe(true);
	});

	it("allows interactive PTY on non-Windows when requested with UI and not disabled", () => {
		setPlatform("linux");
		setNoPty(undefined);

		expect(canUseInteractiveBashPty(true, interactiveContext())).toBe(true);
		expect(canUseInteractiveBashPty(false, interactiveContext())).toBe(false);
		expect(canUseInteractiveBashPty(true, undefined)).toBe(false);

		setNoPty("1");
		expect(canUseInteractiveBashPty(true, interactiveContext())).toBe(false);
	});

	it("disables interactive PTY when VEYYON_NO_PTY=1", () => {
		setPlatform("linux");
		setNoPty("1", "VEYYON_NO_PTY");
		expect(canUseInteractiveBashPty(true, interactiveContext())).toBe(false);
	});

	it("disables interactive PTY when pty is false", () => {
		setPlatform("win32");
		expect(canUseInteractiveBashPty(false, interactiveContext())).toBe(false);
	});
});
