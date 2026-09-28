//! WHY: the shipped `veyyon-desktop` binary linked GPUI with `test-support`.
//! A normal dependency (`veyyon-desktop-scene` → `veyyon-desktop-kit[headless]`
//! → `gpui_platform[test-support]`) turned the feature on, and a dependency's
//! features reach every binary that links it. Under `test-support` GPUI draws
//! every dirty window at the end of each effect flush instead of on the
//! platform frame clock, and runs the leak detector at quit: the window drew
//! about 800 frames a second behind a spinner and the process panicked on
//! quit. Nothing failed, because every test builds with the feature anyway.
//!
//! CLASS CLOSED: any crate in the binary's normal dependency graph with a
//! test-only feature (`test-support`, `bench-support`, `leak-detection`)
//! enabled, and any retired view-layer crate or the dev-only scene crate
//! linked into the binary. The graph is read from `cargo tree -e no-dev` at
//! run time, so a new dependency that turns a test-only feature on anywhere
//! below the binary turns this red without an edit here.
//!
//! NOT CAUGHT: a test-only code path behind a `cfg(test)` or a feature with a
//! different name, and a dependency added only for a target other than the
//! host the suite runs on (`cargo tree` resolves for the host target).

use std::{env, ffi::OsString, path::Path, process::Command};

/// Features that exist to support tests and benches and must never reach the
/// shipped binary.
const TEST_ONLY_FEATURES: [&str; 3] = ["test-support", "bench-support", "leak-detection"];

/// Crates that must not be linked into the binary: the retired view layer and
/// the dev-only headless scene renderer.
const FORBIDDEN_CRATES: [&str; 5] = [
	"veyyon-desktop-surface",
	"veyyon-desktop-kit",
	"veyyon-desktop-tokens",
	"veyyon-desktop-motion",
	"veyyon-desktop-scene",
];

/// One package line of `cargo tree --prefix none -f '{p} {f}'`.
#[derive(Debug, PartialEq, Eq)]
struct Package<'a> {
	name:     &'a str,
	features: Vec<&'a str>,
}

/// Parses one line: `name vX.Y.Z [(proc-macro)] [(source)] [f1,f2] [(*)]`.
///
/// A source or proc-macro marker is parenthesised and a feature list never
/// holds a space or a parenthesis, so the features are the last token when it
/// does not close a parenthesis.
fn parse(line: &str) -> Option<Package<'_>> {
	let line = line.trim_end();
	let line = line.strip_suffix("(*)").unwrap_or(line).trim_end();
	let mut head = line.splitn(3, ' ');
	let name = head.next().filter(|name| !name.is_empty())?;
	let version = head.next()?;
	if !version.starts_with('v') {
		return None;
	}
	let rest = head.next().unwrap_or("").trim();
	let features = if rest.is_empty() || rest.ends_with(')') {
		Vec::new()
	} else {
		let token = rest.rsplit(' ').next().unwrap_or(rest);
		token
			.split(',')
			.filter(|feature| !feature.is_empty())
			.collect()
	};
	Some(Package { name, features })
}

/// Runs `cargo tree` over the binary's normal dependency graph.
fn dependency_graph() -> String {
	let cargo = env::var_os("CARGO").unwrap_or_else(|| OsString::from(env!("CARGO")));
	let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
	let output = Command::new(&cargo)
		.arg("tree")
		.arg("--manifest-path")
		.arg(&manifest)
		.args(["-p", "veyyon-desktop", "-e", "no-dev", "--prefix", "none"])
		.args(["-f", "{p} {f}", "--frozen"])
		.output()
		.unwrap_or_else(|error| panic!("{} did not start: {error}", Path::new(&cargo).display()));
	assert!(
		output.status.success(),
		"cargo tree failed ({}): {}",
		output.status,
		String::from_utf8_lossy(&output.stderr)
	);
	String::from_utf8(output.stdout).expect("cargo tree prints UTF-8")
}

#[test]
fn the_binary_graph_enables_no_test_only_feature_and_links_no_retired_crate() {
	let graph = dependency_graph();
	let packages: Vec<Package<'_>> = graph.lines().filter_map(parse).collect();
	assert!(
		packages
			.first()
			.is_some_and(|root| root.name == "veyyon-desktop"),
		"cargo tree did not start at the binary:\n{graph}"
	);

	let mut offences: Vec<String> = Vec::new();
	for package in &packages {
		let banned: Vec<&str> = package
			.features
			.iter()
			.copied()
			.filter(|feature| TEST_ONLY_FEATURES.contains(feature))
			.collect();
		if !banned.is_empty() {
			offences.push(format!("{} enables {}", package.name, banned.join(",")));
		}
		if FORBIDDEN_CRATES.contains(&package.name) {
			offences.push(format!("{} is linked into the binary", package.name));
		}
	}
	offences.sort();
	offences.dedup();
	assert!(
		offences.is_empty(),
		"the shipped veyyon-desktop binary links test-only code:\n  {}",
		offences.join("\n  ")
	);
}

#[test]
fn a_tree_line_parses_into_its_name_and_features() {
	let cases: [(&str, Option<Package<'_>>); 6] = [
		(
			"gpui v0.2.2 (https://example.invalid/gpui.git?rev=1#1) default,test-support,x11",
			Some(Package { name: "gpui", features: vec!["default", "test-support", "x11"] }),
		),
		(
			"proc-macro2 v1.0.107 default,proc-macro (*)",
			Some(Package { name: "proc-macro2", features: vec!["default", "proc-macro"] }),
		),
		(
			"veyyon-desktop v1.4.1 (/repo/crates/veyyon-desktop) ",
			Some(Package { name: "veyyon-desktop", features: vec![] }),
		),
		(
			"gpui_macros v0.1.0 (proc-macro) (https://example.invalid/g.git#1) ",
			Some(Package { name: "gpui_macros", features: vec![] }),
		),
		("libc v0.2.1 ", Some(Package { name: "libc", features: vec![] })),
		("", None),
	];
	for (line, expected) in cases {
		assert_eq!(parse(line), expected, "line {line:?}");
	}
}
