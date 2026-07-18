import { afterEach, describe, expect, it } from "bun:test";
import { canUseInteractiveBashPty } from "@veyyon/coding-agent/tools/bash-pty-selection";

const originalPlatform = process.platform;
const originalNoPty = Bun.env.VEYYON_NO_PTY;

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

function setNoPty(value: string | undefined): void {
	delete Bun.env.VEYYON_NO_PTY;
	if (value !== undefined) Bun.env.VEYYON_NO_PTY = value;
}

function interactiveContext() {
	return { hasUI: true, ui: {} };
}

describe("bash PTY selection", () => {
	afterEach(() => {
		restorePlatform();
		delete Bun.env.VEYYON_NO_PTY;
		delete Bun.env.OMP_NO_PTY;
		delete Bun.env.PI_NO_PTY;
		if (originalNoPty !== undefined) Bun.env.VEYYON_NO_PTY = originalNoPty;
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
		setNoPty("1");
		expect(canUseInteractiveBashPty(true, interactiveContext())).toBe(false);
	});

	it("ignores the removed OMP_NO_PTY / PI_NO_PTY legacy aliases", () => {
		setPlatform("linux");
		setNoPty(undefined);
		Bun.env.OMP_NO_PTY = "1";
		Bun.env.PI_NO_PTY = "1";
		expect(canUseInteractiveBashPty(true, interactiveContext())).toBe(true);
	});

	it("disables interactive PTY when pty is false", () => {
		setPlatform("win32");
		expect(canUseInteractiveBashPty(false, interactiveContext())).toBe(false);
	});
});
