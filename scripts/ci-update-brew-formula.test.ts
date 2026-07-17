import { describe, expect, it } from "bun:test";
import { renderFormula } from "./ci-update-brew-formula";

const SUMS = {
	"veyyon-darwin-arm64": "darwin_arm64_sha",
	"veyyon-darwin-x64": "darwin_x64_sha",
	"veyyon-linux-arm64": "linux_arm64_sha",
	"veyyon-linux-x64": "linux_x64_sha",
};

describe("renderFormula", () => {
	const formula = renderFormula("1.0.0", SUMS);

	it("declares the veyyon formula class, version, and MIT license", () => {
		expect(formula).toContain("class Veyyon < Formula");
		expect(formula).toContain('version "1.0.0"');
		expect(formula).toContain('license "MIT"');
		// Never the upstream branding.
		expect(formula).not.toContain("class Omp");
	});

	// Regression: bare-binary URLs must opt out of Homebrew's UnpackStrategy.
	// Without `using: :nounzip` the default CurlDownloadStrategy nests the file
	// outside the staging CWD, `Dir["veyyon-*"].first` returns `nil`, and
	// `bin.install nil => "veyyon"` raises (issue #2398).
	it("attaches `using: :nounzip` to every per-platform url stanza", () => {
		const matches = formula.match(/using: :nounzip/g) ?? [];
		expect(matches).toHaveLength(4);
		for (const arch of ["veyyon-darwin-arm64", "veyyon-darwin-x64", "veyyon-linux-arm64", "veyyon-linux-x64"]) {
			expect(formula).toMatch(
				new RegExp(
					`url "https://github\\.com/[^"]+/${arch}",\\s+using: :nounzip\\s+sha256 "${SUMS[arch as keyof typeof SUMS]}"`,
				),
			);
		}
	});

	it("installs the veyyon binary and links the `vey` alias next to it", () => {
		expect(formula).toContain('bin.install Dir["veyyon-*"].first => "veyyon"');
		expect(formula).toContain('bin.install_symlink "veyyon" => "vey"');
		// The `omp-*` glob never matched the real `veyyon-*` assets (would raise).
		expect(formula).not.toContain('Dir["omp-*"]');
	});

	it("does not generate completions (the CLI has no stable completions command yet)", () => {
		// A `generate_completions_from_executable` call fails the whole formula if
		// the binary lacks the subcommand; keep it out until `veyyon completions`
		// is supported. This is the twin of the install-time behavior.
		expect(formula).not.toContain("generate_completions_from_executable");
	});

	it("tests the installed binary by its real command name", () => {
		expect(formula).toContain('shell_output("#{bin}/veyyon --version")');
	});

	it("emits the expected per-asset sha256 next to each url", () => {
		for (const name in SUMS) {
			const sha = SUMS[name as keyof typeof SUMS];
			expect(formula).toContain(`/${name}",`);
			expect(formula).toContain(`sha256 "${sha}"`);
		}
	});
});
