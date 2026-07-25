import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The installer may never destroy a file it did not create.
 *
 * Both installers wrote the `vey` alias unconditionally: POSIX used `ln -sf`,
 * which unlinks whatever sits at the path first, and Windows used `Set-Content`,
 * which overwrites. A user with their own `vey` script or shim in the install
 * directory lost it silently and unrecoverably — no prompt, no warning, no
 * backup, on a command they only ran to install a CLI.
 *
 * The rule now: only replace something this installer could itself have put
 * there (a link/shim already pointing at our binary, or a dangling link with
 * nothing to lose). Anything else is the user's and is reported, not removed.
 *
 * Behavioral coverage lives in scripts/install-tests/functions.test.sh (POSIX,
 * runs locally); this suite holds the cross-platform contract, since pwsh is not
 * available on the Linux dev host.
 */

const repoRoot = path.resolve(import.meta.dir, "..");
const installSh = fs.readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf8");
const installPs1 = fs.readFileSync(path.join(repoRoot, "scripts", "install.ps1"), "utf8");

/** The alias-writing function body from each installer. */
function fnBody(body: string, start: string, end: string): string {
	const from = body.indexOf(start);
	expect(from, `missing ${start}`).toBeGreaterThan(-1);
	const to = body.indexOf(end, from);
	expect(to, `missing terminator after ${start}`).toBeGreaterThan(from);
	return body.slice(from, to);
}

const shLinkAlias = fnBody(installSh, "link_alias() {", "\n}\n");
const ps1InstallAlias = fnBody(installPs1, "function Install-Alias {", "\n}\n");

describe("the alias is never written over a file the installer did not create", () => {
	it("install.sh no longer force-links over the alias path", () => {
		// `ln -sf` is the destructive form: it unlinks the existing path first.
		// The only remaining forced link is the dangling-symlink repair, which
		// cannot lose data.
		// Comments explaining WHY `ln -sf` was wrong are not uses of it, so count
		// only executable lines.
		const code = shLinkAlias
			.split("\n")
			.filter(l => !l.trimStart().startsWith("#"))
			.join("\n");
		const forced = code.match(/ln -sf/g) ?? [];
		expect(forced.length, "ln -sf may only remain for the dangling-link repair").toBe(1);
		expect(code).toContain("ln -s ");
	});

	it("install.sh replaces only a link that already points at our binary", () => {
		expect(shLinkAlias).toContain('[ "$(readlink "$link" 2>/dev/null)" = "$target" ]');
	});

	it("install.ps1 rewrites only a shim that already forwards to our binary", () => {
		expect(ps1InstallAlias).toContain("$existing.Contains($Target)");
		expect(ps1InstallAlias).toContain("already points at $BinName");
	});

	it("both report the collision instead of silently skipping it", () => {
		// Law 10: declining to create the alias changes what the user gets, so it
		// must be visible, not a quiet no-op.
		expect(shLinkAlias).toContain("left '$ALIAS_NAME' alone");
		expect(ps1InstallAlias).toContain("left '$AliasName' alone");
	});

	it("both tell the user how to launch in the meantime", () => {
		// A warning that only says "cannot do it" leaves the user stuck; the binary
		// name still works and the message has to say so.
		expect(shLinkAlias).toContain("launch with '$BIN_NAME'");
		expect(ps1InstallAlias).toContain("launch with '$BinName'");
	});

	it("neither deletes or backs up the conflicting file", () => {
		// The fix is to leave it alone. Moving it aside would be another surprise
		// mutation of a directory the user owns.
		for (const [name, body] of [
			["install.sh", shLinkAlias],
			["install.ps1", ps1InstallAlias],
		] as const) {
			expect(body, `${name} must not remove the conflicting alias`).not.toMatch(/\brm -rf\b/);
			expect(body, `${name} must not rename the conflicting alias`).not.toMatch(/\.bak\b/);
		}
	});
});
