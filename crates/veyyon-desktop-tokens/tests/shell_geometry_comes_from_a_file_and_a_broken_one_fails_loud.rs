//! WHY: §4.1 fixes the window minimum, the titlebar height, the control size,
//! the control gap and the control insets, and none of them had a source on
//! disk. A shell built without them would have had to write the numbers into
//! Rust, which the style lint rejects, so the values would have drifted from
//! the section that specifies them.
//!
//! CLASS CLOSED: a shell dimension that is absent, malformed or off the spacing
//! scale loading as zero. The previous surface loader defaulted a missing
//! `min_width_px` to 0 through `unwrap_or(0)`, which yields a window with no
//! minimum and a breakpoint that always matches; this loader rejects instead.
//!
//! NOT CAUGHT: that the shell actually renders at these dimensions, which needs
//! the shell view. Platform control insets, which are added at run time from
//! what the window system reports and cannot be asserted from a file.

use std::{
	fs,
	path::{Path, PathBuf},
};

use veyyon_desktop_tokens::{TokenError, dump_to_dir, load_from_dir};
use veyyon_test_scratch::{TempTree, scratch_dir};

/// The shipped token directory.
fn shipped() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tokens")
}

/// Copies the shipped tokens into a scratch dir so one rule can be corrupted.
fn scratch_tokens(label: &str) -> (TempTree, PathBuf) {
	let tree = scratch_dir(label);
	let tokens = load_from_dir(&shipped()).expect("shipped tokens load");
	dump_to_dir(&tokens, tree.path()).expect("dump tokens");
	let dir = tree.path().to_path_buf();
	(tree, dir)
}

/// Rewrites shell.toml, asserting the substitution actually happened.
fn rewrite(dir: &Path, from: &str, to: &str) {
	let path = dir.join("surface/shell.toml");
	let text = fs::read_to_string(&path).expect("read shell.toml");
	assert!(text.contains(from), "fixture lacks {from:?}; the test would assert nothing");
	fs::write(&path, text.replace(from, to)).expect("write shell.toml");
}

/// The §4.1 table, asserted against the file rather than against a constant in
/// the shell. Each value carries its derivation in that section.
#[test]
fn the_shipped_shell_matches_the_specified_geometry() {
	let shell = load_from_dir(&shipped())
		.expect("shipped tokens load")
		.surface
		.shell;

	assert_eq!(shell.window_min_width_px, 800.0, "768 prose + 16 gutters, queue collapsed");
	assert_eq!(shell.window_min_height_px, 560.0);
	assert_eq!(shell.titlebar_height_px, 52.0, "28 control + 12 above + 12 below");
	assert_eq!(shell.titlebar_control_px, 28.0);
	assert_eq!(shell.titlebar_control_gap_px, 8.0, "one gap, from the §6.1 scale");
	assert_eq!(shell.titlebar_inset_left_px, 12.0);
	assert_eq!(shell.titlebar_inset_right_px, 12.0);
	assert_eq!(shell.grain_tile_px, 128.0, "128x128 R8 blue noise (§6.5)");
	assert_eq!(shell.grain_opacity, 0.025, "grain sits at 2.5% on level 0 only");
}

/// The titlebar height is not free: §4.1 derives it from the control it holds
/// plus symmetric padding. A height that no longer matches means one of the two
/// was changed without the other.
#[test]
fn the_titlebar_height_still_derives_from_the_control_it_holds() {
	let shell = load_from_dir(&shipped())
		.expect("shipped tokens load")
		.surface
		.shell;
	let padding = shell.titlebar_height_px - shell.titlebar_control_px;

	assert!(padding > 0.0, "a titlebar shorter than its control cannot draw it");
	assert_eq!(padding % 2.0, 0.0, "padding is symmetric, so the remainder is even");
	assert_eq!(padding / 2.0, shell.titlebar_inset_left_px, "12px above and below, per §4.1");
}

/// A window minimum below the titlebar is incoherent: the shell would have no
/// room for any surface at all.
#[test]
fn the_window_minimum_leaves_room_below_the_titlebar() {
	let surface = load_from_dir(&shipped())
		.expect("shipped tokens load")
		.surface;
	let below = surface.shell.window_min_height_px - surface.shell.titlebar_height_px;

	assert!(below > 0.0, "the window minimum has to exceed the titlebar");
	assert!(
		below > surface.panels.terminal_drawer_min_height_px,
		"a minimum window that cannot hold the drawer's own minimum ({below}px available, drawer \
		 needs {}px) leaves no transcript at all",
		surface.panels.terminal_drawer_min_height_px
	);
}

#[test]
fn a_missing_dimension_is_rejected_rather_than_defaulted_to_zero() {
	let (_tree, dir) = scratch_tokens("shell-missing-dimension");
	rewrite(&dir, "height_px = 52\n", "");

	match load_from_dir(&dir).expect_err("a missing titlebar height must not load") {
		TokenError::MissingKey { section, key, .. } => {
			assert_eq!(section, "titlebar");
			assert_eq!(key, "height_px");
		},
		other => panic!("expected MissingKey, got {other}"),
	}
}

#[test]
fn a_negative_dimension_is_rejected() {
	let (_tree, dir) = scratch_tokens("shell-negative-dimension");
	rewrite(&dir, "height_px = 52", "height_px = -52");

	match load_from_dir(&dir).expect_err("a negative titlebar height must not load") {
		TokenError::OffScale { value, scale_name, .. } => {
			assert_eq!(value, "-52");
			assert_eq!(scale_name, "titlebar.height_px");
		},
		other => panic!("expected OffScale, got {other}"),
	}
}

/// A gap references the §6.1 scale by name. A raw number would put a value off
/// the scale into the one place the scale is supposed to be authoritative.
#[test]
fn a_gap_off_the_spacing_scale_is_rejected() {
	let (_tree, dir) = scratch_tokens("shell-off-scale-gap");
	rewrite(&dir, "control_gap_px = \"s4\"", "control_gap_px = \"s99\"");

	match load_from_dir(&dir).expect_err("a gap off the scale must not load") {
		TokenError::OffScale { value, .. } => assert_eq!(value, "s99"),
		other => panic!("expected OffScale, got {other}"),
	}
}

#[test]
fn an_unknown_shell_key_is_rejected() {
	let (_tree, dir) = scratch_tokens("shell-unknown-key");
	rewrite(&dir, "[titlebar]", "[titlebar]\ntab_strip_height_px = 32");

	match load_from_dir(&dir).expect_err("an unknown key must not load") {
		TokenError::UnknownKey { section, key, .. } => {
			assert_eq!(section, "titlebar");
			assert_eq!(key, "tab_strip_height_px");
		},
		other => panic!("expected UnknownKey, got {other}"),
	}
}

#[test]
fn an_opacity_above_one_is_rejected() {
	let (_tree, dir) = scratch_tokens("shell-bad-opacity");
	rewrite(&dir, "opacity = 0.025", "opacity = 2.5");

	match load_from_dir(&dir).expect_err("an opacity above 1.0 must not load") {
		TokenError::OffScale { scale_name, allowed, .. } => {
			assert_eq!(scale_name, "grain.opacity");
			assert_eq!(allowed, "0.0 to 1.0");
		},
		other => panic!("expected OffScale, got {other}"),
	}
}

/// A shell.toml that is absent entirely fails, rather than the surface set
/// loading with a shell of zeroes.
#[test]
fn an_absent_shell_file_fails_the_whole_load() {
	let (_tree, dir) = scratch_tokens("shell-absent");
	fs::remove_file(dir.join("surface/shell.toml")).expect("remove shell.toml");

	match load_from_dir(&dir).expect_err("an absent shell file must fail the load") {
		TokenError::Io { path, .. } => assert!(path.ends_with("shell.toml")),
		other => panic!("expected Io, got {other}"),
	}
}
