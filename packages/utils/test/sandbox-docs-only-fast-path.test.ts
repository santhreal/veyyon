import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

function runChild(
	source: string,
	env: Record<string, string | undefined>,
	extraArgs: string[] = [],
): { code: number; output: string } {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-gate-docs-"));
	const file = path.join(tmp, "probe.ts");
	fs.writeFileSync(file, source, "utf8");
	const proc = Bun.spawnSync(["bun", ...extraArgs, file], {
		cwd: REPO_ROOT,
		env: { ...process.env, ...env, VEYYON_TEST_SANDBOX: undefined, VEYYON_TEST_HOST_HOME: undefined },
		stdout: "pipe",
		stderr: "pipe",
	});
	fs.rmSync(tmp, { recursive: true, force: true });
	const out = (proc.stdout ? proc.stdout.toString() : "") + (proc.stderr ? proc.stderr.toString() : "");
	return { code: proc.exitCode ?? 1, output: out };
}

function withTempDocsFile(name: string, content: string, body: (file: string) => void): void {
	const full = path.join(REPO_ROOT, name);
	const existed = fs.existsSync(full);
	const prior = existed ? fs.readFileSync(full, "utf8") : null;
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, "utf8");
	try {
		body(full);
	} finally {
		if (existed && prior !== null) fs.writeFileSync(full, prior, "utf8");
		else fs.rmSync(full, { force: true });
	}
}

describe("docs-only fast path", () => {
	const gateImport = `import "${path.join(REPO_ROOT, "packages/utils/test/helpers/sandbox-gate.ts")}";`;

	it("allows --sandbox=off when every changed file is docs-only", () => {
		withTempDocsFile("docs/test-fast-path-docs-only.md", "typo", () => {
			const { code, output } = runChild(`${gateImport}\nconsole.log("ALLOW")`, {}, ["--sandbox=off"]);
			expect(code).toBe(0);
			expect(output).toContain("ALLOW");
		});
	});

	it("still refuses without --sandbox=off even for docs-only", () => {
		withTempDocsFile("docs/test-fast-path-docs-only2.md", "typo", () => {
			const { code, output } = runChild(`${gateImport}\nconsole.log("ALLOW")`, {}, []);
			expect(code).toBe(1);
			expect(output).toContain("REFUSED");
		});
	});

	it("refuses --sandbox=off when a code file is among changes", () => {
		withTempDocsFile("docs/test-fast-path-docs-only3.md", "typo", () => {
			const codeFile = path.join(REPO_ROOT, "packages/utils/src/test-code-fast-path-temp.ts");
			fs.writeFileSync(codeFile, "export const x = 1;\n", "utf8");
			try {
				const { code, output } = runChild(`${gateImport}\nconsole.log("ALLOW")`, {}, ["--sandbox=off"]);
				expect(code).toBe(1);
				expect(output).toContain("REFUSED");
				expect(output).toContain("For docs-only changes");
			} finally {
				fs.rmSync(codeFile, { force: true });
			}
		});
	});
});
