//! WHY: `Theme` carried a fail-closed role accessor and a contrast check while
//! nothing in the crate ever loaded a theme, and no theme file existed. The
//! contrast machinery had no inputs, so §6.9's rule that a rejected theme names
//! the rule it broke was unreachable and the two bundled themes it calls "the
//! reference implementations the contrast rules are asserted against" were
//! absent.
//!
//! CLASS CLOSED: a theme that cannot be rendered loading anyway. Every §6.9
//! load rule is exercised against a real file on disk, and the role set is
//! enumerated from `ColorRole::all()` at run time, so adding a role turns this
//! red until both bundled themes declare it.
//!
//! NOT CAUGHT: that a role is used by the right surface, which needs the kit
//! and the surfaces. Perceptual quality of the palettes: contrast floors are a
//! lower bound on legibility, not a judgement of whether a colour looks right.
//! Grain (§6.5) and the glass material are unmodelled here.

use std::{fs, path::PathBuf};

use veyyon_desktop_tokens::{
	APPEARANCES, ColorRole, THEME_VERSION, Theme, TokenError, load_bundled_themes, load_theme,
};
use veyyon_test_scratch::{TempTree, scratch_dir};

/// The bundled theme directory that ships with the crate.
fn bundled_dir() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("themes")
}

/// Copies the dark theme into a scratch dir so a test can corrupt one rule.
fn scratch_theme(label: &str) -> (TempTree, PathBuf) {
	let tree = scratch_dir(label);
	let source = bundled_dir().join("dark.toml");
	let target = tree.path().join("dark.toml");
	let text = fs::read_to_string(&source).expect("read bundled dark theme");
	fs::write(&target, text).expect("write scratch theme");
	(tree, target)
}

/// Rewrites the scratch theme, replacing `from` with `to`.
///
/// Asserts the substitution happened, because a test that silently edits
/// nothing asserts on the unmodified file and passes for the wrong reason.
fn rewrite(path: &PathBuf, from: &str, to: &str) {
	let text = fs::read_to_string(path).expect("read scratch theme");
	assert!(text.contains(from), "fixture does not contain {from:?}; the test would assert nothing");
	fs::write(path, text.replace(from, to)).expect("write scratch theme");
}

#[test]
fn both_bundled_themes_load_and_declare_every_role() {
	let themes = load_bundled_themes(&bundled_dir()).expect("bundled themes load");

	assert_eq!(themes.len(), APPEARANCES.len(), "one bundled theme per appearance (§6.9)");

	let appearances: Vec<&str> = themes.iter().map(|t| t.appearance.as_str()).collect();
	assert_eq!(appearances, APPEARANCES.to_vec(), "appearances in declared order");

	// Enumerated from the enum rather than a list written here, so a new role
	// fails this until both files declare it.
	for theme in &themes {
		let path = bundled_dir().join(format!("{}.toml", theme.appearance));
		for role in ColorRole::all() {
			theme
				.role(&path, role)
				.unwrap_or_else(|e| panic!("{} lacks {}: {e}", theme.appearance, role.as_str()));
		}
		assert_eq!(
			theme.roles.len(),
			ColorRole::all().len(),
			"{} declares a role outside the role table",
			theme.appearance
		);
		assert_eq!(theme.version, THEME_VERSION);
	}
}

/// The floors are re-asserted here rather than trusted to the loader, so a
/// loader that stopped calling its own contrast check is caught.
#[test]
fn every_rendered_pair_clears_its_contrast_floor() {
	let grounds =
		[ColorRole::Ground, ColorRole::Rail, ColorRole::Canvas, ColorRole::Inset, ColorRole::Float];

	for theme in load_bundled_themes(&bundled_dir()).expect("bundled themes load") {
		let path = bundled_dir().join(format!("{}.toml", theme.appearance));
		let colour = |role: ColorRole| theme.role(&path, role).expect("declared role");

		for (inks, floor) in [
			([ColorRole::Foreground, ColorRole::Secondary], 4.5_f32),
			([ColorRole::Muted, ColorRole::Placeholder], 3.0_f32),
		] {
			for ink in inks {
				for ground in grounds {
					let ratio = colour(ink).contrast_ratio(colour(ground));
					assert!(
						ratio >= floor,
						"{}: {} on {} is {ratio:.2}:1, below {floor}:1",
						theme.appearance,
						ink.as_str(),
						ground.as_str()
					);
				}
			}
		}

		let accent = colour(ColorRole::AccentForeground).contrast_ratio(colour(ColorRole::Accent));
		assert!(accent >= 4.5, "{}: accent pair is {accent:.2}:1", theme.appearance);

		for (fill, ink) in [
			(ColorRole::WorkingFill, ColorRole::WorkingInk),
			(ColorRole::AttentionFill, ColorRole::AttentionInk),
			(ColorRole::ApproveFill, ColorRole::ApproveInk),
			(ColorRole::InputFill, ColorRole::InputInk),
			(ColorRole::PlanFill, ColorRole::PlanInk),
			(ColorRole::DueFill, ColorRole::DueInk),
			(ColorRole::DoneFill, ColorRole::DoneInk),
			(ColorRole::ErrorFill, ColorRole::ErrorInk),
		] {
			let ratio = colour(ink).contrast_ratio(colour(fill));
			assert!(
				ratio >= 4.5,
				"{}: {} on {} is {ratio:.2}:1",
				theme.appearance,
				ink.as_str(),
				fill.as_str()
			);
		}
	}
}

/// Every tint pair in the enum is covered by the check above. A ninth tint
/// added to `ColorRole` would otherwise be asserted nowhere, because that check
/// names its pairs explicitly to keep the failure message readable.
#[test]
fn the_contrast_check_covers_every_tint_pair_in_the_enum() {
	let covered = [
		ColorRole::WorkingFill,
		ColorRole::AttentionFill,
		ColorRole::ApproveFill,
		ColorRole::InputFill,
		ColorRole::PlanFill,
		ColorRole::DueFill,
		ColorRole::DoneFill,
		ColorRole::ErrorFill,
	];
	let declared: Vec<&str> = ColorRole::all()
		.into_iter()
		.filter_map(|role| role.as_str().strip_suffix("_fill"))
		.collect();
	let asserted: Vec<&str> = covered
		.into_iter()
		.filter_map(|role| role.as_str().strip_suffix("_fill"))
		.collect();
	assert_eq!(declared, asserted, "a tint pair exists that the contrast check does not assert");
}

#[test]
fn a_missing_role_names_the_role() {
	let (_tree, path) = scratch_theme("theme-missing-role");
	rewrite(&path, "muted = \"#8b95a3\"\n", "");

	match load_theme(&path).expect_err("a theme missing a role must not load") {
		TokenError::MissingKey { section, key, .. } => {
			assert_eq!(section, "role");
			assert_eq!(key, "muted");
		},
		other => panic!("expected MissingKey, got {other}"),
	}
}

#[test]
fn a_missing_tint_block_names_the_block() {
	let (_tree, path) = scratch_theme("theme-missing-tint");
	rewrite(&path, "[tint.due]\nfill = \"#4a2f14\"\nink = \"#f0c496\"\n", "");

	match load_theme(&path).expect_err("a theme missing a tint block must not load") {
		TokenError::MissingKey { section, key, .. } => {
			assert_eq!(section, "due");
			assert_eq!(key, "due");
		},
		other => panic!("expected MissingKey, got {other}"),
	}
}

#[test]
fn an_unknown_role_is_rejected_rather_than_ignored() {
	let (_tree, path) = scratch_theme("theme-unknown-role");
	rewrite(&path, "hairline = ", "sidebar_border = \"#2c323b\"\nhairline = ");

	match load_theme(&path).expect_err("an unknown role must not load") {
		TokenError::UnknownKey { section, key, .. } => {
			assert_eq!(section, "role");
			assert_eq!(key, "sidebar_border");
		},
		other => panic!("expected UnknownKey, got {other}"),
	}
}

#[test]
fn a_version_this_binary_does_not_read_is_rejected() {
	let (_tree, path) = scratch_theme("theme-bad-version");
	rewrite(&path, "version = 1", "version = 2");

	match load_theme(&path).expect_err("an unsupported version must not load") {
		TokenError::UnsupportedVersion { found, supported, .. } => {
			assert_eq!(found, 2);
			assert_eq!(supported, THEME_VERSION);
		},
		other => panic!("expected UnsupportedVersion, got {other}"),
	}
}

/// A negative version is reported as written. Narrowing it to an unsigned type
/// before reporting names a version nobody typed.
#[test]
fn a_negative_version_is_reported_as_written() {
	let (_tree, path) = scratch_theme("theme-negative-version");
	rewrite(&path, "version = 1", "version = -3");

	match load_theme(&path).expect_err("a negative version must not load") {
		TokenError::UnsupportedVersion { found, .. } => assert_eq!(found, -3),
		other => panic!("expected UnsupportedVersion, got {other}"),
	}
}

#[test]
fn an_unknown_appearance_names_the_two_that_are_allowed() {
	let (_tree, path) = scratch_theme("theme-bad-appearance");
	rewrite(&path, "appearance = \"dark\"", "appearance = \"solarized\"");

	match load_theme(&path).expect_err("an unknown appearance must not load") {
		TokenError::OffScale { value, scale_name, allowed, .. } => {
			assert_eq!(value, "solarized");
			assert_eq!(scale_name, "appearance");
			assert_eq!(allowed, "dark, light");
		},
		other => panic!("expected OffScale, got {other}"),
	}
}

/// A hand-edited hex value is the input that previously panicked on a character
/// boundary. It must arrive as a typed error naming the key and the value.
#[test]
fn a_malformed_colour_names_the_key_and_never_panics() {
	for bad in ["#12g456", "#12345", "not-a-colour", "#Àbcdef", ""] {
		let (_tree, path) = scratch_theme("theme-bad-colour");
		rewrite(&path, "accent = \"#f0862e\"", &format!("accent = \"{bad}\""));

		match load_theme(&path).expect_err("a malformed colour must not load") {
			TokenError::ColorInvalid { key, value, .. } => {
				assert_eq!(key, "accent");
				assert_eq!(value, bad);
			},
			other => panic!("expected ColorInvalid for {bad:?}, got {other}"),
		}
	}
}

#[test]
fn a_pair_below_the_floor_names_both_roles_and_the_ratio() {
	let (_tree, path) = scratch_theme("theme-low-contrast");
	// Foreground moved to a near-ground value: legible nowhere.
	rewrite(&path, "foreground = \"#fafafa\"", "foreground = \"#1e2229\"");

	match load_theme(&path).expect_err("a pair below the floor must not load") {
		TokenError::ContrastTooLow { foreground, background, ratio, required, .. } => {
			assert_eq!(foreground, "foreground");
			assert!(
				["ground", "rail", "canvas", "inset", "float"].contains(&background.as_str()),
				"unexpected ground {background}"
			);
			assert!(ratio < required, "{ratio} should be below {required}");
			assert!((required - 4.5).abs() < f32::EPSILON, "body text floor is 4.5:1");
		},
		other => panic!("expected ContrastTooLow, got {other}"),
	}
}

/// A tint ink is checked against its own fill, not against a ground. A badge
/// draws the pair together, so a readable-on-canvas ink proves nothing.
#[test]
fn a_tint_ink_is_checked_against_its_own_fill() {
	let (_tree, path) = scratch_theme("theme-low-tint");
	rewrite(
		&path,
		"[tint.plan]\nfill = \"#333a44\"\nink = \"#e6e9ee\"",
		"[tint.plan]\nfill = \"#333a44\"\nink = \"#3a414b\"",
	);

	match load_theme(&path).expect_err("a tint pair below the floor must not load") {
		TokenError::ContrastTooLow { foreground, background, .. } => {
			assert_eq!(foreground, "plan_ink");
			assert_eq!(background, "plan_fill");
		},
		other => panic!("expected ContrastTooLow, got {other}"),
	}
}

#[test]
fn a_theme_with_an_unknown_section_is_rejected() {
	let (_tree, path) = scratch_theme("theme-unknown-section");
	rewrite(&path, "[role]", "[palette]\nblue_500 = \"#4a8cf7\"\n\n[role]");

	match load_theme(&path).expect_err("an unknown section must not load") {
		TokenError::UnknownKey { key, .. } => assert_eq!(key, "palette"),
		other => panic!("expected UnknownKey, got {other}"),
	}
}

/// The bundled directory has to hold both appearances. A build shipping one
/// cannot honour a light-mode host, and the failure names the file.
#[test]
fn a_bundled_directory_missing_an_appearance_fails() {
	let tree = scratch_dir("theme-one-appearance");
	let text = fs::read_to_string(bundled_dir().join("dark.toml")).expect("read dark");
	fs::write(tree.path().join("dark.toml"), text).expect("write dark");

	let err = load_bundled_themes(tree.path()).expect_err("a missing appearance must fail");
	match err {
		TokenError::Io { path, .. } => {
			assert!(path.ends_with("light.toml"), "expected light.toml, got {}", path.display());
		},
		other => panic!("expected Io for the absent file, got {other}"),
	}
}

/// Loading is a pure read: two loads of the same file agree. Colour arithmetic
/// runs in floating point, so a non-deterministic parse would surface as a
/// theme that fails contrast only sometimes.
#[test]
fn loading_the_same_file_twice_yields_the_same_theme() {
	let path = bundled_dir().join("dark.toml");
	let first: Theme = load_theme(&path).expect("first load");
	let second: Theme = load_theme(&path).expect("second load");
	assert_eq!(first, second);
}
