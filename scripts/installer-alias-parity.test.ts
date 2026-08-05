import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { APP_ALIAS, APP_NAME } from "@veyyon/utils";

/**
 * Locks the short launch alias to ONE owner across three languages.
 *
 * `vey` is written down in four places that must agree: the TypeScript constant
 * `APP_ALIAS` (which the completion generator binds completions to), and the
 * `ALIAS_NAME` variables in the POSIX and PowerShell installers (which create the
 * symlink/shim and install the alias completion files). Nothing in the type
 * system connects them, so a rename in one place silently produces an installed
 * command with no completions, or completions bound to a command that does not
 * exist. These tests are that connection.
 *
 * The behavioral half — that the alias completion files are actually written and
 * removed — lives in scripts/install-tests/functions.test.sh.
 */

const repoRoot = path.resolve(import.meta.dir, "..");
const installSh = fs.readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf8");
const installPs1 = fs.readFileSync(path.join(repoRoot, "scripts", "install.ps1"), "utf8");

/** Read a top-level `NAME="value"` / `$Name = "value"` assignment from a script. */
function shVar(body: string, name: string): string | undefined {
	return new RegExp(`^${name}="([^"]+)"`, "m").exec(body)?.[1];
}
function ps1Var(body: string, name: string): string | undefined {
	return new RegExp(`^\\$${name}\\s*=\\s*"([^"]+)"`, "m").exec(body)?.[1];
}

describe("the launch alias has one owner across the TS constant and both installers", () => {
	it("install.sh's ALIAS_NAME is exactly APP_ALIAS", () => {
		// The literal as well: the alias is what a user types, so a rename is a
		// breaking change for every existing install, not a refactor. Against
		// APP_ALIAS alone the parity check follows the rename and says nothing.
		expect(shVar(installSh, "ALIAS_NAME")).toBe("vey");
		expect(shVar(installSh, "ALIAS_NAME")).toBe(APP_ALIAS);
	});

	it("install.ps1's AliasName is exactly APP_ALIAS", () => {
		expect(ps1Var(installPs1, "AliasName")).toBe(APP_ALIAS);
	});

	it("both installers' binary name is exactly APP_NAME", () => {
		// The same drift risk applies to the primary name: completions, the PATH
		// entry, and the downloaded asset all key off it.
		expect(shVar(installSh, "BIN_NAME")).toBe(APP_NAME);
		expect(ps1Var(installPs1, "BinName")).toBe(APP_NAME);
	});

	it("the alias is distinct from the binary name", () => {
		// A degenerate config where both are the same would make the installer link
		// a file onto itself and make `complete -F _veyyon veyyon veyyon` nonsense.
		expect(APP_ALIAS).not.toBe(APP_NAME);
		expect(APP_ALIAS.length).toBeGreaterThan(0);
	});
});

describe("install.sh derives every completion filename from one owner", () => {
	it("completion_file_for is the single per-shell filename convention", () => {
		// Both install_completions and do_uninstall call it, so an installed file
		// can never be missed by uninstall (they used to hardcode separate lists).
		expect(installSh).toContain("completion_file_for() {");
		const helperCalls = installSh.match(/completion_file_for "/g) ?? [];
		expect(helperCalls.length).toBeGreaterThanOrEqual(3);
		// No hand-rolled duplicate of the zsh/fish naming convention survives.
		expect(installSh).not.toContain('for name in "$BIN_NAME" "_$BIN_NAME" "$BIN_NAME.fish"');
	});

	it("install_completions writes through a temp file, never onto the live path", () => {
		// A completion file is sourced at shell startup, so a half-written one breaks
		// every new shell the user opens. Same contract as finalize_binary.
		expect(installSh).toMatch(/tmp="\$out\/\.\$name\.\$\$"/);
		expect(installSh).toContain('mv -f "$tmp" "$out/$name"');
	});

	it("install_completions installs the alias file for bash and fish but not zsh", () => {
		// bash and fish autoload by command name (so the alias needs its own file);
		// zsh binds both names from the generated script's own `#compdef` line.
		expect(installSh).toContain('completion_file_for "$sh" "$ALIAS_NAME"');
		expect(installSh).toContain('[ "$sh" != "zsh" ]');
	});

	it("a failed alias copy is reported, never swallowed", () => {
		// Law 10: a best-effort step may fail, but it may not fail silently — the
		// user must learn that `vey <TAB>` will not work.
		expect(installSh).toMatch(/warn "could not install \$sh completions for '\$ALIAS_NAME'/);
	});
});
