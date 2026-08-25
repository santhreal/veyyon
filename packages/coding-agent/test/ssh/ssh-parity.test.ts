/**
 * SSH subsystem parity oracle: pins exact behavior of utility functions,
 * host validation, OS classification, probe parsing, and config constants.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite must reproduce these exact
 * behaviors: argument-injection guards, POSIX quoting, host classification,
 * probe marker extraction, and config validation rules. Each test pins an
 * observable contract with exact values.
 */
import { describe, expect, it } from "bun:test";
import {
	sanitizeHostName,
	buildSshTarget,
	quotePosixPath,
	wrapInPosixShell,
} from "@veyyon/coding-agent/ssh/utils";
import { validateHostName } from "@veyyon/coding-agent/ssh/config-writer";
import {
	supportsSshControlMaster,
	parseHostInfo,
	osFromUname,
	extractProbePayload,
	findProbeMarker,
	HOST_PROBE_MARKER,
	TRANSFER_PROBE_MARKER,
	type SSHHostOs,
} from "@veyyon/coding-agent/ssh/connection-manager";

describe("sanitizeHostName", () => {
	it("passes through valid hostnames unchanged", () => {
		expect(sanitizeHostName("my-server")).toBe("my-server");
		expect(sanitizeHostName("host.example.com")).toBe("host.example.com");
		expect(sanitizeHostName("host_123")).toBe("host_123");
	});

	it("replaces disallowed characters with underscore", () => {
		expect(sanitizeHostName("my server")).toBe("my_server");
		expect(sanitizeHostName("host@example")).toBe("host_example");
		expect(sanitizeHostName("a/b/c")).toBe("a_b_c");
	});

	it("falls back to 'remote' for empty input only", () => {
		expect(sanitizeHostName("")).toBe("remote");
	});

	it("replaces all-disallowed-character runs with a single underscore", () => {
		expect(sanitizeHostName("@#$%")).toBe("_");
		expect(sanitizeHostName("///")).toBe("_");
		expect(sanitizeHostName("   ")).toBe("_");
	});
});

describe("buildSshTarget", () => {
	it("builds user@host when username is provided", () => {
		expect(buildSshTarget("alice", "server.example.com")).toBe("alice@server.example.com");
	});

	it("returns bare host when username is undefined", () => {
		expect(buildSshTarget(undefined, "server.example.com")).toBe("server.example.com");
	});

	it("returns bare host when username is empty string", () => {
		expect(buildSshTarget("", "server.example.com")).toBe("server.example.com");
	});

	it("throws when host starts with dash (argument-injection guard)", () => {
		expect(() => buildSshTarget(undefined, "-oProxyCommand=evil")).toThrow(
			'Invalid SSH host "-oProxyCommand=evil": an SSH destination must not begin with "-" (argument-injection guard)',
		);
	});

	it("throws when username starts with dash (argument-injection guard)", () => {
		expect(() => buildSshTarget("-oProxyCommand=evil", "server")).toThrow(
			'Invalid SSH username "-oProxyCommand=evil": an SSH username must not begin with "-" (argument-injection guard)',
		);
	});
});

describe("quotePosixPath", () => {
	it("wraps a simple path in single quotes", () => {
		expect(quotePosixPath("/home/user/file")).toBe("'/home/user/file'");
	});

	it("returns empty-quoted string for empty input", () => {
		expect(quotePosixPath("")).toBe("''");
	});

	it("escapes embedded single quotes", () => {
		expect(quotePosixPath("it's")).toBe("'it'\\''s'");
		expect(quotePosixPath("a'b'c")).toBe("'a'\\''b'\\''c'");
	});
});

describe("wrapInPosixShell", () => {
	it("wraps command in <shell> -c '<command>'", () => {
		expect(wrapInPosixShell("sh", "ls -la")).toBe("sh -c 'ls -la'");
		expect(wrapInPosixShell("bash", "echo hello")).toBe("bash -c 'echo hello'");
		expect(wrapInPosixShell("zsh", "test -f /etc/hosts")).toBe("zsh -c 'test -f /etc/hosts'");
	});

	it("escapes single quotes in the command", () => {
		expect(wrapInPosixShell("sh", "echo 'hi'")).toBe("sh -c 'echo '\\''hi'\\'''");
	});
});

describe("validateHostName", () => {
	it("returns undefined for valid hostnames", () => {
		expect(validateHostName("my-server")).toBeUndefined();
		expect(validateHostName("host.example.com")).toBeUndefined();
		expect(validateHostName("host_123")).toBeUndefined();
		expect(validateHostName("a")).toBeUndefined();
	});

	it("returns error for empty name", () => {
		expect(validateHostName("")).toBe("Host name cannot be empty");
	});

	it("returns error for names over 100 characters", () => {
		const long = "a".repeat(101);
		expect(validateHostName(long)).toBe("Host name is too long (max 100 characters)");
	});

	it("returns error for names with invalid characters", () => {
		expect(validateHostName("host with spaces")).toBe(
			"Host name can only contain letters, numbers, dash, underscore, and dot",
		);
		expect(validateHostName("host@example")).toBe(
			"Host name can only contain letters, numbers, dash, underscore, and dot",
		);
		expect(validateHostName("host/path")).toBe(
			"Host name can only contain letters, numbers, dash, underscore, and dot",
		);
	});

	it("accepts exactly 100 characters", () => {
		const exact = "a".repeat(100);
		expect(validateHostName(exact)).toBeUndefined();
	});
});

describe("supportsSshControlMaster", () => {
	it("returns true for linux", () => {
		expect(supportsSshControlMaster("linux")).toBe(true);
	});

	it("returns true for darwin", () => {
		expect(supportsSshControlMaster("darwin")).toBe(true);
	});

	it("returns false for win32", () => {
		expect(supportsSshControlMaster("win32")).toBe(false);
	});
});

describe("osFromUname", () => {
	it("classifies darwin as macos", () => {
		expect(osFromUname("Darwin")).toBe("macos");
		expect(osFromUname("darwin")).toBe("macos");
	});

	it("classifies linux as linux", () => {
		expect(osFromUname("Linux")).toBe("linux");
		expect(osFromUname("linux")).toBe("linux");
	});

	it("classifies gnu as linux", () => {
		expect(osFromUname("GNU")).toBe("linux");
	});

	it("classifies mingw/msys/cygwin/windows as windows", () => {
		expect(osFromUname("MINGW64_NT-10.0")).toBe("windows");
		expect(osFromUname("MSYS_NT-10.0")).toBe("windows");
		expect(osFromUname("CYGWIN_NT-10.0")).toBe("windows");
		expect(osFromUname("Windows")).toBe("windows");
	});

	it("returns undefined for unknown", () => {
		expect(osFromUname("FreeBSD")).toBeUndefined();
		expect(osFromUname("")).toBeUndefined();
	});
});

describe("extractProbePayload", () => {
	it("extracts payload after marker from stdout", () => {
		const stdout = `banner\n${HOST_PROBE_MARKER}linux|/bin/bash|5.1\n`;
		expect(extractProbePayload(stdout, "")).toBe("linux|/bin/bash|5.1");
	});

	it("extracts payload after marker from stderr when stdout is empty", () => {
		const stderr = `${HOST_PROBE_MARKER}darwin|/bin/zsh|5.0`;
		expect(extractProbePayload("", stderr)).toBe("darwin|/bin/zsh|5.0");
	});

	it("returns null when marker is absent", () => {
		expect(extractProbePayload("no marker here", "")).toBeNull();
	});

	it("uses custom marker", () => {
		const stdout = `VEYYON_TRANSFER_OK|sh\nLinux\n`;
		expect(extractProbePayload(stdout, "", TRANSFER_PROBE_MARKER)).toBe("sh");
	});

	it("skips blank lines and finds marker on any line", () => {
		const stdout = `\n\n${HOST_PROBE_MARKER}payload\n`;
		expect(extractProbePayload(stdout, "")).toBe("payload");
	});
});

describe("findProbeMarker", () => {
	it("finds marker anywhere in stdout and returns the rest", () => {
		const stdout = `noise${TRANSFER_PROBE_MARKER}Linux\nmore`;
		expect(findProbeMarker(stdout, "", TRANSFER_PROBE_MARKER)).toBe("Linux\nmore");
	});

	it("falls back to stderr", () => {
		const stderr = `prefix${TRANSFER_PROBE_MARKER}Darwin`;
		expect(findProbeMarker("", stderr, TRANSFER_PROBE_MARKER)).toBe("Darwin");
	});

	it("returns null when marker is in neither stream", () => {
		expect(findProbeMarker("nope", "also nope", TRANSFER_PROBE_MARKER)).toBeNull();
	});
});

describe("parseHostInfo", () => {
	it("returns null for non-object input", () => {
		expect(parseHostInfo(null)).toBeNull();
		expect(parseHostInfo("string")).toBeNull();
		expect(parseHostInfo(42)).toBeNull();
		expect(parseHostInfo(undefined)).toBeNull();
	});

	it("parses a valid host info object", () => {
		const info = parseHostInfo({
			version: 4,
			os: "linux",
			shell: "bash",
			transferShell: "sh",
			compatShell: undefined,
			compatEnabled: false,
		});
		expect(info).toEqual({
			version: 4,
			os: "linux",
			shell: "bash",
			transferShell: "sh",
			compatShell: undefined,
			compatEnabled: false,
		});
	});

	it("defaults unknown fields", () => {
		const info = parseHostInfo({});
		expect(info).toEqual({
			version: 0,
			os: "unknown",
			shell: "unknown",
			transferShell: undefined,
			compatShell: undefined,
			compatEnabled: false,
		});
	});

	it("defaults invalid os/shell to unknown", () => {
		const info = parseHostInfo({ os: "bsd", shell: "fish" });
		expect(info?.os).toBe("unknown");
		expect(info?.shell).toBe("unknown");
	});
});

describe("SSH probe markers are pinned", () => {
	it("HOST_PROBE_MARKER is exactly VEYYON_HOST_PROBE=", () => {
		expect(HOST_PROBE_MARKER).toBe("VEYYON_HOST_PROBE=");
	});

	it("TRANSFER_PROBE_MARKER is exactly VEYYON_TRANSFER_OK|", () => {
		expect(TRANSFER_PROBE_MARKER).toBe("VEYYON_TRANSFER_OK|");
	});
});
