/**
 * Windows paths that do not mean what they say are refused, not written.
 *
 * WHY THIS SUITE EXISTS. Two Win32 behaviours make a write land somewhere other
 * than the named file, and in both the call SUCCEEDS, which is what makes them
 * dangerous rather than merely annoying:
 *
 *   1. DEVICE NAMES. `CON` is the console, `NUL` discards everything written to
 *      it, `LPT1` is a printer port. Writing to one reports success and creates
 *      no file. The reservation holds in every directory, not only a drive root,
 *      and survives an extension, so `logs/CON.txt` is still the console.
 *
 *   2. TRAILING DOTS AND SPACES. Win32 strips them before the filesystem sees
 *      the name, so `report.`, `report ` and `report` are one file. A tool that
 *      believes it wrote three has written one and overwritten it twice, and any
 *      containment check run on the pre-strip string described a path that was
 *      never opened.
 *
 * The platform is a parameter rather than read from the environment, so these
 * run on every host. A Windows-only CI job would have left the rules unverified
 * on the machines where they are actually written.
 */
import { describe, expect, it } from "bun:test";
import { assertNoWindowsReservedName, resolveToCwd } from "@veyyon/coding-agent/tools/path-utils";

const check = (p: string, platform: NodeJS.Platform = "win32") => assertNoWindowsReservedName(p, p, platform);

describe("reserved device names", () => {
	/** The canonical four. Each opens a device, and the open succeeds. */
	it.each(["CON", "PRN", "AUX", "NUL"])("refuses the bare device name %s", name => {
		expect(() => check(`C:\\work\\${name}`)).toThrow(/reserved Windows device name/);
	});

	/** The numbered port devices, both families. */
	it.each(["COM1", "COM9", "LPT1", "LPT9"])("refuses the port device %s", name => {
		expect(() => check(`C:\\work\\${name}`)).toThrow(/reserved Windows device name/);
	});

	/** Case does not rescue it: Win32 matches these case-insensitively, so `con`
	 * is the console exactly as `CON` is. */
	it("refuses a lowercase device name", () => {
		expect(() => check("C:\\work\\con")).toThrow(/reserved Windows device name/);
	});

	/**
	 * THE case people assume is safe. An extension does not make it a file;
	 * `CON.txt` still opens the console. A check that only compared the whole
	 * component would pass this.
	 */
	it("refuses a device name carrying an extension", () => {
		expect(() => check("C:\\work\\CON.txt")).toThrow(/reserved Windows device name/);
		expect(() => check("C:\\work\\nul.log")).toThrow(/reserved Windows device name/);
	});

	/** The reservation is not limited to the drive root, so a nested directory is
	 * no protection. */
	it("refuses a device name nested deep in a tree", () => {
		expect(() => check("C:\\a\\b\\c\\LPT3\\d.txt")).toThrow(/reserved Windows device name/);
	});

	/** The message must say what will happen, or the operator reads it as an
	 * arbitrary naming rule and works around it. */
	it("explains that the write would go to the device and create no file", () => {
		let message = "";
		try {
			check("C:\\work\\CON");
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("CON");
		expect(message).toContain("writes to the device");
		expect(message).toContain("no file is created");
	});

	/** Names that merely START with a device name are ordinary files. Refusing
	 * `console.ts` or `computer.md` would break everyday work. */
	it.each(["console.ts", "connection.js", "auxiliary.md", "com10", "lpt0", "printer.txt"])(
		"accepts the ordinary filename %s",
		name => {
			expect(() => check(`C:\\work\\${name}`)).not.toThrow();
		},
	);
});

describe("trailing dots and spaces", () => {
	/** Win32 strips the trailing dot, so this silently opens `report`. */
	it("refuses a component with a trailing dot", () => {
		expect(() => check("C:\\work\\report.")).toThrow(/silently strips/);
	});

	/** Same stripping, and a trailing space is far easier to introduce by
	 * accident, from a copied name or a generated title. */
	it("refuses a component with a trailing space", () => {
		expect(() => check("C:\\work\\report ")).toThrow(/silently strips/);
	});

	/** Any run of them, in any order. */
	it("refuses a mixed run of trailing dots and spaces", () => {
		expect(() => check("C:\\work\\report. . ")).toThrow(/silently strips/);
	});

	/** A trailing dot on a DIRECTORY collides just as a filename does. */
	it("refuses a trailing dot on an intermediate directory", () => {
		expect(() => check("C:\\work\\logs.\\a.txt")).toThrow(/silently strips/);
	});

	/** The message must name the file that would really be opened, which is the
	 * whole point: the operator cannot see the difference by eye. */
	it("names the path that would actually be opened", () => {
		let message = "";
		try {
			check("C:\\work\\report.");
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain('"report."');
		expect(message).toContain('"report"');
	});

	/** Dots INSIDE a name are ordinary, and refusing them would reject most real
	 * filenames. */
	it.each(["a.tar.gz", "file.txt", ".gitignore", "..config"])("accepts the ordinary name %s", name => {
		expect(() => check(`C:\\work\\${name}`)).not.toThrow();
	});

	/** `.` and `..` are path navigation, not filenames ending in a dot. Treating
	 * them as violations would break every relative path on Windows. */
	it("accepts the . and .. path segments", () => {
		// WHY: paired with the run of dots that is NOT navigation. The exemption is
		// for those two components exactly, so a checker that skipped any component
		// made of dots would let `...` through, and `...` is a name Win32 strips to
		// nothing.
		expect(() => check("C:\\work\\.\\a.txt")).not.toThrow();
		expect(() => check("C:\\work\\..\\a.txt")).not.toThrow();
		expect(() => check("C:\\work\\...\\a.txt")).toThrow(/silently strips/);
	});
});

describe("POSIX is unaffected", () => {
	/**
	 * These are all legal filenames on Linux and macOS. Applying the Windows rules
	 * everywhere would refuse files that exist on disk and make them unreadable,
	 * which is a worse defect than the one being prevented.
	 */
	it.each(["CON", "NUL", "LPT1", "report.", "report "])("accepts %s on linux", name => {
		expect(() => check(`/home/user/${name}`, "linux")).not.toThrow();
	});

	/** And the real resolver on this host must not have picked up the rules,
	 * which is the integration half of the same claim. */
	it("leaves resolveToCwd unaffected on a non-Windows host", () => {
		if (process.platform === "win32") return;
		expect(resolveToCwd("CON", "/tmp")).toBe("/tmp/CON");
		expect(resolveToCwd("report.", "/tmp")).toBe("/tmp/report.");
	});
});
