use std::{
	collections::BTreeSet,
	fs,
	path::{Path, PathBuf},
};

use veyyon_desktop_tokens::{RightPanelMode, dump_to_dir, load_from_dir};
use veyyon_test_scratch::scratch_dir;

#[test]
fn test_tokens_dump_and_load_roundtrip() {
	let shipped_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tokens");
	let original = load_from_dir(&shipped_dir).expect("load shipped tokens");

	let tree = scratch_dir("tokens-roundtrip");
	dump_to_dir(&original, tree.path()).expect("dump tokens");

	let reloaded = load_from_dir(tree.path()).expect("reload dumped tokens");
	assert_eq!(original, reloaded, "reloaded tokens must be identical to original tokens");
}

#[test]
fn test_tokens_dump_and_load_roundtrip_with_modified_surface_fields() {
	let shipped_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tokens");
	let mut original = load_from_dir(&shipped_dir).expect("load shipped tokens");

	// Mutate fields across different surfaces to non-default values
	original.surface.queue.width_default_px = 300.0;
	original.surface.queue.max_hover_actions = 4;
	original.surface.composer.rest_height_px = 80.0;
	original.surface.shell.window_min_width_px = 1024.0;
	original.surface.panels.right_panel_default_width_px = 600.0;

	let tree = scratch_dir("tokens-roundtrip-modified");
	dump_to_dir(&original, tree.path()).expect("dump modified tokens");

	let reloaded = load_from_dir(tree.path()).expect("reload dumped modified tokens");
	assert_eq!(
		original, reloaded,
		"reloaded tokens with modified surface fields must match original modified tokens"
	);
}

/// WHY: A dumper that formats float pixel dimensions using integer casting
/// silently truncates fractional inline panel widths (e.g. 540.5 -> 540). This
/// suite proves that arbitrary finite decimal inline widths survive
/// serialization and deserialization without precision loss.
#[test]
fn test_tokens_dump_and_load_preserves_non_integer_inline_width() {
	let shipped_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tokens");
	let mut original = load_from_dir(&shipped_dir).expect("load shipped tokens");

	original.surface.breakpoints.wide.right_panel_mode = RightPanelMode::Inline { width_px: 540.5 };
	original.surface.breakpoints.standard.right_panel_mode =
		RightPanelMode::Inline { width_px: 360.25 };

	let tree = scratch_dir("tokens-roundtrip-float-inline");
	dump_to_dir(&original, tree.path()).expect("dump modified tokens");

	let reloaded = load_from_dir(tree.path()).expect("reload dumped modified tokens");
	assert_eq!(
		original, reloaded,
		"reloaded tokens with non-integer inline widths must match original"
	);
	assert_eq!(reloaded.surface.breakpoints.wide.right_panel_mode, RightPanelMode::Inline {
		width_px: 540.5,
	});
	assert_eq!(reloaded.surface.breakpoints.standard.right_panel_mode, RightPanelMode::Inline {
		width_px: 360.25,
	});
}

/// WHY: `surface/agents.toml` reached the loader with no dumper behind it, so
/// `dump_to_dir` wrote a tree the loader then refused, and every caller that
/// seeds a scratch token tree failed on a missing file. The set of relative
/// paths is read off the shipped directory at run time, so a surface file added
/// later and left out of the dumper turns this red.
///
/// It does not catch a dumper that writes a file with the wrong contents; the
/// equality roundtrips above cover that for every field the loader reads.
#[test]
fn every_shipped_token_file_is_written_back_by_the_dumper() {
	let shipped_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tokens");
	let original = load_from_dir(&shipped_dir).expect("load shipped tokens");

	let tree = scratch_dir("tokens-dump-covers-every-file");
	dump_to_dir(&original, tree.path()).expect("dump tokens");

	let shipped = toml_files(&shipped_dir);
	let dumped = toml_files(tree.path());
	let missing: Vec<&PathBuf> = shipped.difference(&dumped).collect();
	assert!(missing.is_empty(), "the dumper writes no file for {missing:?}");
}

fn toml_files(dir: &Path) -> BTreeSet<PathBuf> {
	let mut found = BTreeSet::new();
	collect_toml(dir, dir, &mut found);
	found
}

fn collect_toml(root: &Path, dir: &Path, found: &mut BTreeSet<PathBuf>) {
	let entries = fs::read_dir(dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display()));
	for entry in entries.flatten() {
		let path = entry.path();
		if path.is_dir() {
			collect_toml(root, &path, found);
		} else if path.extension().is_some_and(|ext| ext == "toml") {
			let relative = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
			found.insert(relative);
		}
	}
}
