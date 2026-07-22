import { describe, expect, it } from "bun:test";
import { formatSystemInfo, type SystemInfo } from "../../src/debug/system-info";

/**
 * formatSystemInfo renders a collected SystemInfo into the fixed text block shown
 * in a debug report. It had no test. The exact layout matters because the block
 * is copied into bug reports, so the label column, the memory line composed from
 * formatBytes (total with free in parentheses), and the CONDITIONAL Terminal line
 * (present only when info.terminal is set, appended after Shell) are pinned here.
 * A regression that always emitted the Terminal line would print "Terminal: "
 * with an empty value; one that dropped it would lose the field entirely.
 */

const baseInfo: SystemInfo = {
	os: "Linux 6.17.0 (linux)",
	arch: "x64",
	cpu: "Test CPU @ 3.0GHz",
	memory: { total: 16 * 1024 * 1024 * 1024, free: 8 * 1024 * 1024 * 1024 },
	versions: { app: "1.2.3", bun: "1.3.14", node: "v22.0.0" },
	cwd: "/home/dev/project",
	shell: "/bin/bash",
	terminal: undefined,
};

describe("formatSystemInfo", () => {
	it("omits the Terminal line when info.terminal is undefined", () => {
		expect(formatSystemInfo(baseInfo)).toBe(
			[
				"System Information",
				"━━━━━━━━━━━━━━━━━━",
				"OS:      Linux 6.17.0 (linux)",
				"Arch:    x64",
				"CPU:     Test CPU @ 3.0GHz",
				"Memory:  16.0GB (8.0GB free)",
				"Bun:     1.3.14",
				"App:     veyyon 1.2.3",
				"Node:    v22.0.0 (compat)",
				"CWD:     /home/dev/project",
				"Shell:   /bin/bash",
			].join("\n"),
		);
	});

	it("appends the Terminal line after Shell when info.terminal is set", () => {
		const withTerminal: SystemInfo = { ...baseInfo, terminal: "iTerm.app" };
		expect(formatSystemInfo(withTerminal)).toBe(
			[
				"System Information",
				"━━━━━━━━━━━━━━━━━━",
				"OS:      Linux 6.17.0 (linux)",
				"Arch:    x64",
				"CPU:     Test CPU @ 3.0GHz",
				"Memory:  16.0GB (8.0GB free)",
				"Bun:     1.3.14",
				"App:     veyyon 1.2.3",
				"Node:    v22.0.0 (compat)",
				"CWD:     /home/dev/project",
				"Shell:   /bin/bash",
				"Terminal: iTerm.app",
			].join("\n"),
		);
	});

	it("composes the memory line as total with free in parentheses via formatBytes", () => {
		const info: SystemInfo = {
			...baseInfo,
			memory: { total: 8 * 1024 * 1024 * 1024, free: 0 },
		};
		expect(formatSystemInfo(info)).toContain("Memory:  8.0GB (0B free)");
	});
});
