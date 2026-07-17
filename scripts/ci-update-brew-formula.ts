#!/usr/bin/env bun
//
// Render the Homebrew formula for `veyyon` from a published GitHub release and
// write it to a tap checkout. The release publishes per-platform bare binaries
// (veyyon-<platform>-<arch>); this reads their sha256 digests straight from the
// release metadata so the formula never drifts from the shipped assets.
//
// Usage:
//   bun scripts/ci-update-brew-formula.ts <tag> --out <path/to/Formula/veyyon.rb>
//   bun scripts/ci-update-brew-formula.ts v1.0.0          # prints to stdout

import { $ } from "bun";

// Which repo's releases the formula downloads from. `VEYYON_REPO` (legacy
// `OMP_REPO`) / the CI-set `GITHUB_REPOSITORY` override the default.
const REPO = process.env.VEYYON_REPO ?? process.env.OMP_REPO ?? process.env.GITHUB_REPOSITORY ?? "santhreal/veyyon";
const HOMEPAGE = "https://veyyon.dev";
const DESC = "Veyyon — terminal coding agent";

interface ReleaseAsset {
	name: string;
	digest?: string;
}

function parseArgs(argv: readonly string[]): { tag: string; out: string | null } {
	const rest = [...argv];
	let out: string | null = null;
	const outIdx = rest.indexOf("--out");
	if (outIdx >= 0) {
		out = rest[outIdx + 1] ?? null;
		if (!out) throw new Error("--out requires a path");
		rest.splice(outIdx, 2);
	}
	const tag = rest.find(a => !a.startsWith("--"));
	if (!tag) throw new Error("usage: ci-update-brew-formula.ts <tag> [--out <file>]");
	return { tag, out };
}

async function fetchAssets(tag: string): Promise<ReleaseAsset[]> {
	const res = await $`gh release view ${tag} --repo ${REPO} --json assets`.quiet().nothrow();
	if (res.exitCode !== 0) {
		throw new Error(`gh release view ${tag} failed: ${res.stderr.toString().trim()}`);
	}
	const parsed = JSON.parse(res.stdout.toString()) as { assets: ReleaseAsset[] };
	return parsed.assets;
}

function sha256For(assets: readonly ReleaseAsset[], name: string): string {
	const asset = assets.find(a => a.name === name);
	if (!asset) throw new Error(`release is missing asset ${name}`);
	if (!asset.digest?.startsWith("sha256:")) {
		throw new Error(`asset ${name} has no sha256 digest (got ${asset.digest ?? "none"})`);
	}
	return asset.digest.slice("sha256:".length);
}

// `${...}` is JS interpolation; the literal `#{version}` / `#{bin}` below are
// Ruby interpolations Homebrew resolves when it evaluates the formula.
export function renderFormula(version: string, sums: Record<string, string>): string {
	// Each `url` carries `using: :nounzip` because the release assets are bare
	// Mach-O/ELF executables, not archives. Without it Homebrew's default
	// CurlDownloadStrategy routes through UnpackStrategy::Uncompressed#extract_nestedly,
	// which nests the file outside the staging CWD; `Dir["veyyon-*"].first` then
	// returns `nil` and `bin.install nil => "veyyon"` raises.
	//
	// The install command is `veyyon`, with `vey` as the short alias (matching the
	// curl installer). Shell completions are intentionally not generated here: the
	// CLI does not yet ship a stable `completions` subcommand, and Homebrew fails
	// the whole formula if `generate_completions_from_executable` errors. Add it
	// back once `veyyon completions <shell>` is a supported command.
	return `class Veyyon < Formula
  desc "${DESC}"
  homepage "${HOMEPAGE}"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/${REPO}/releases/download/v#{version}/veyyon-darwin-arm64",
          using: :nounzip
      sha256 "${sums["veyyon-darwin-arm64"]}"
    end
    on_intel do
      url "https://github.com/${REPO}/releases/download/v#{version}/veyyon-darwin-x64",
          using: :nounzip
      sha256 "${sums["veyyon-darwin-x64"]}"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/${REPO}/releases/download/v#{version}/veyyon-linux-arm64",
          using: :nounzip
      sha256 "${sums["veyyon-linux-arm64"]}"
    end
    on_intel do
      url "https://github.com/${REPO}/releases/download/v#{version}/veyyon-linux-x64",
          using: :nounzip
      sha256 "${sums["veyyon-linux-x64"]}"
    end
  end

  def install
    bin.install Dir["veyyon-*"].first => "veyyon"
    (bin/"veyyon").chmod 0555
    bin.install_symlink "veyyon" => "vey"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/veyyon --version")
  end
end
`;
}

async function main(): Promise<void> {
	const { tag, out } = parseArgs(process.argv.slice(2));
	const version = tag.replace(/^v/, "");
	const assets = await fetchAssets(tag);

	const targets = ["veyyon-darwin-arm64", "veyyon-darwin-x64", "veyyon-linux-arm64", "veyyon-linux-x64"];
	const sums: Record<string, string> = {};
	for (const name of targets) sums[name] = sha256For(assets, name);

	const formula = renderFormula(version, sums);
	if (out) {
		await Bun.write(out, formula);
		console.log(`wrote ${out} for ${tag}`);
	} else {
		process.stdout.write(formula);
	}
}

if (import.meta.main) {
	await main();
}
