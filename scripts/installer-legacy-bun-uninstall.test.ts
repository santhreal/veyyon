import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeOwnerReceipt } from "./install-tests/installer-artifacts";

const installSh = path.join(import.meta.dir, "install.sh");
const tempRoots: string[] = [];
const decoder = new TextDecoder();

interface Sandbox {
	root: string;
	home: string;
	installDir: string;
	bashrc: string;
	completionFiles: string[];
	/** Receipt sidecars seeded beside each completion, one per entry above. */
	completionReceipts: string[];
	env: Record<string, string>;
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createSandbox(): Sandbox {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-legacy-bun-uninstall-"));
	tempRoots.push(root);
	const home = path.join(root, "home");
	const installDir = path.join(home, "canonical-bin");
	fs.mkdirSync(installDir, { recursive: true });

	const canonicalBinary = path.join(installDir, "veyyon");
	fs.writeFileSync(canonicalBinary, Buffer.from("canonical veyyon\0binary", "utf8"));
	fs.chmodSync(canonicalBinary, 0o755);
	fs.symlinkSync(canonicalBinary, path.join(installDir, "vey"));

	// A completion file the installer wrote comes with the ownership receipt
	// `mark_artifact_owned` leaves beside it, and `completion_artifact_is_ours`
	// reads that receipt to decide whether uninstall may delete the file. Seeding
	// the files WITHOUT receipts, as this fixture used to, modelled an installer
	// that never ran: the placeholder body matches no shell's Veyyon registration
	// either, so the script correctly read all six as somebody else's and left
	// them, and the suite blamed uninstall for obeying its own ownership rule.
	const completionFiles: string[] = [];
	const completionReceipts: string[] = [];
	for (const [directory, binaryName, aliasName] of [
		[path.join(home, "data/bash-completion/completions"), "veyyon", "vey"],
		[path.join(home, "data/zsh/site-functions"), "_veyyon", "_vey"],
		[path.join(home, "config/fish/completions"), "veyyon.fish", "vey.fish"],
	] as const) {
		fs.mkdirSync(directory, { recursive: true });
		const binaryCompletion = path.join(directory, binaryName);
		const aliasCompletion = path.join(directory, aliasName);
		fs.writeFileSync(binaryCompletion, "installer completion\n");
		fs.copyFileSync(binaryCompletion, aliasCompletion);
		completionFiles.push(binaryCompletion, aliasCompletion);
		completionReceipts.push(writeOwnerReceipt(binaryCompletion), writeOwnerReceipt(aliasCompletion));
	}

	const bashrc = path.join(home, ".bashrc");
	fs.writeFileSync(
		bashrc,
		`user before\n# added by the veyyon installer\nexport PATH='${installDir}':"$PATH"\nuser after\n`,
	);

	return {
		root,
		home,
		installDir,
		bashrc,
		completionFiles,
		completionReceipts,
		env: {
			...process.env,
			HOME: home,
			PATH: "/usr/bin:/bin",
			SHELL: "/bin/bash",
			VEYYON_INSTALL_DIR: installDir,
			VEYYON_SRC_DIR: path.join(home, "source-does-not-exist"),
			XDG_DATA_HOME: path.join(home, "data"),
			XDG_CONFIG_HOME: path.join(home, "config"),
		},
	};
}

function runUninstall(sandbox: Sandbox): { exitCode: number; output: string } {
	const run = Bun.spawnSync(["/bin/sh", installSh, "--uninstall"], {
		cwd: sandbox.root,
		env: sandbox.env,
	});
	return {
		exitCode: run.exitCode,
		output: `${decoder.decode(run.stdout)}${decoder.decode(run.stderr)}`,
	};
}

function pathExists(pathname: string): boolean {
	try {
		fs.lstatSync(pathname);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/**
 * CONTRACT: a completed uninstall leaves none of the surfaces this installer
 * manages behind. The binary, the `vey` alias, every completion file, AND the
 * ownership receipt beside each completion, plus the PATH line in the rc.
 *
 * The receipt sweep is the part that was missing. `do_uninstall` calls
 * `remove_owner_receipt` on every successful removal, so a receipt outliving the
 * file it describes is a real defect and not cosmetic: the sidecar is what
 * `artifact_has_owner_receipt` reads, so an orphan makes the NEXT unrelated file
 * to take that name read as installer-owned, and a later install would overwrite
 * a stranger's file it should have refused to touch. The suite could not see
 * that before, because its fixture wrote no receipts at all.
 */
function expectManagedSurfacesRemoved(sandbox: Sandbox): void {
	expect(fs.existsSync(path.join(sandbox.installDir, "veyyon"))).toBe(false);
	expect(pathExists(path.join(sandbox.installDir, "vey"))).toBe(false);
	for (const completion of sandbox.completionFiles) expect(fs.existsSync(completion)).toBe(false);
	for (const receipt of sandbox.completionReceipts) expect(pathExists(receipt)).toBe(false);
	expect(fs.readFileSync(sandbox.bashrc, "utf8")).toBe("user before\nuser after\n");
}

describe("legacy Bun launcher uninstall ownership", () => {
	/**
	 * Regression: uninstall used to delete any executable named `veyyon` from the
	 * shared ~/.bun/bin directory, even when the user created it. Drive the real
	 * script twice and require every foreign byte to survive both passes.
	 */
	it("preserves a foreign legacy-path executable byte-for-byte", () => {
		const sandbox = createSandbox();
		const legacyBin = path.join(sandbox.home, ".bun/bin");
		fs.mkdirSync(legacyBin, { recursive: true });
		const foreignLauncher = path.join(legacyBin, "veyyon");
		const foreignBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0xff, 0x10, 0x76, 0x65, 0x79]);
		fs.writeFileSync(foreignLauncher, foreignBytes);
		fs.chmodSync(foreignLauncher, 0o751);

		const first = runUninstall(sandbox);
		expect(first.exitCode).toBe(0);
		expect(first.output).toContain(`left ${foreignLauncher} alone (not created by this installer)`);
		expect(fs.readFileSync(foreignLauncher)).toEqual(foreignBytes);
		expect(fs.statSync(foreignLauncher).mode & 0o777).toBe(0o751);
		expectManagedSurfacesRemoved(sandbox);

		const second = runUninstall(sandbox);
		expect(second.exitCode).toBe(0);
		expect(second.output).toContain("nothing to uninstall.");
		expect(fs.readFileSync(foreignLauncher)).toEqual(foreignBytes);
		expect(fs.statSync(foreignLauncher).mode & 0o777).toBe(0o751);
	});

	/**
	 * Regression guard for the safe side of the ownership gate: the historical
	 * Bun global install produced an exact package-bin symlink, and uninstall must
	 * still reclaim that identifiable Veyyon-owned launcher without touching its target.
	 */
	it("removes the legacy launcher symlink created by Bun global install", () => {
		const sandbox = createSandbox();
		const legacyBin = path.join(sandbox.home, ".bun/bin");
		const packageCli = path.join(sandbox.home, ".bun/install/global/node_modules/@veyyon/pi-coding-agent/src/cli.ts");
		fs.mkdirSync(legacyBin, { recursive: true });
		fs.mkdirSync(path.dirname(packageCli), { recursive: true });
		const targetBytes = Buffer.from("#!/usr/bin/env bun\nowned package launcher\n");
		fs.writeFileSync(packageCli, targetBytes);
		const ownedLauncher = path.join(legacyBin, "veyyon");
		fs.symlinkSync("../install/global/node_modules/@veyyon/pi-coding-agent/src/cli.ts", ownedLauncher);

		const first = runUninstall(sandbox);
		expect(first.exitCode).toBe(0);
		expect(first.output).toContain(`removed ${ownedLauncher}`);
		expect(pathExists(ownedLauncher)).toBe(false);
		expect(fs.readFileSync(packageCli)).toEqual(targetBytes);
		expectManagedSurfacesRemoved(sandbox);

		const second = runUninstall(sandbox);
		expect(second.exitCode).toBe(0);
		expect(second.output).toContain("nothing to uninstall.");
		expect(pathExists(ownedLauncher)).toBe(false);
		expect(fs.readFileSync(packageCli)).toEqual(targetBytes);
	});
});
