//! Dependency isolation verification tests (§8.2).
//!
//! Contract: `veyyon-desktop-kit` MUST NOT depend on `veyyon-desktop-model`.

#[test]
fn the_desktop_kit_crate_does_not_depend_on_desktop_model() {
	let output = std::process::Command::new("cargo")
		.args(["tree", "-p", "veyyon-desktop-kit", "--prefix", "none"])
		.output()
		.expect("cargo tree failed to execute");

	let tree_stdout = String::from_utf8_lossy(&output.stdout);
	assert!(
		!tree_stdout.contains("veyyon-desktop-model"),
		"veyyon-desktop-kit violates dependency rule by linking veyyon-desktop-model:\n{tree_stdout}"
	);
}
