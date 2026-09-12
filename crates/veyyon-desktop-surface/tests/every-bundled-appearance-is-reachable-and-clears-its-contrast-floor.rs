//! WHY: §6.9 ships one theme per appearance and holds each to a contrast
//! floor, and the failure that survives a working preview is an appearance
//! that is shipped but unreachable: a theme file added to the directory and
//! never named, a role added to the enum and never declared, a file whose
//! `[meta] appearance` disagrees with its name, or a floor that stopped being
//! enforced because nothing ever loaded a theme that breaks it.
//!
//! CLASS CLOSED, swept from the build rather than from a list written here:
//! 1. The set of theme files on disk is exactly `APPEARANCES` -- a theme file
//!    added without naming it, or a name with no file, is red.
//! 2. Every bundled appearance loads, declares every `ColorRole` the enum
//!    holds, states its own name in `[meta]`, and is at `THEME_VERSION` -- a
//!    role added to the enum is red until every theme declares it.
//! 3. The contrast floor is live, not historical: a theme whose foreground is
//!    dropped onto its own ground is refused with `ContrastTooLow`, so the two
//!    shipped files passing is a result and not an absence of checking.
//! 4. Every bundled appearance installs into a window and draws it in its own
//!    colours: the frames of any two appearances differ, so a second theme that
//!    resolves to the first one's colours is red.
//!
//! NOT CAUGHT: whether an appearance is pleasant to read, which no ratio
//! states; and the preview and selection behaviour, which is
//! `an-appearance-previews-under-the-pointer-and-the-choice-sticks.rs`.

#[path = "support/appearance/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared appearance helpers")]
mod appearance;

use std::{collections::BTreeSet, fs, path::PathBuf};

use appearance::{changed_pixels, driven, on_the_themes_page};
use veyyon_desktop_scene::frame::RgbaFrame;
use veyyon_desktop_tokens::{
	APPEARANCES, ColorRole, THEME_VERSION, TokenError, load_bundled_theme, load_theme,
};
use veyyon_test_scratch::scratch_dir;

/// Where the bundled themes are read from, reached from this crate rather
/// than from the loader, so a file the loader never names is still seen.
fn themes_dir() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("..")
		.join("veyyon-desktop-tokens")
		.join("themes")
}

#[test]
fn the_themes_directory_holds_exactly_the_appearances_the_build_names() {
	let on_disk: BTreeSet<String> = fs::read_dir(themes_dir())
		.expect("the bundled themes directory is readable")
		.map(|entry| entry.expect("a directory entry is readable").path())
		.filter(|path| {
			path
				.extension()
				.is_some_and(|extension| extension == "toml")
		})
		.map(|path| {
			path
				.file_stem()
				.expect("a theme file has a name")
				.to_string_lossy()
				.into_owned()
		})
		.collect();
	let named: BTreeSet<String> = APPEARANCES.into_iter().map(ToOwned::to_owned).collect();

	assert_eq!(
		on_disk, named,
		"the theme files on disk and the appearances the build names disagree: a file nobody names \
		 is unreachable, and a name with no file fails at startup"
	);
}

#[test]
fn every_bundled_appearance_declares_every_role_and_states_its_own_name() {
	for appearance in APPEARANCES {
		let theme = load_bundled_theme(appearance)
			.unwrap_or_else(|error| panic!("the bundled {appearance} theme loads: {error}"));
		assert_eq!(
			theme.appearance, appearance,
			"{appearance}.toml declares appearance {:?}, so the file it is read from and the \
			 appearance it answers to disagree",
			theme.appearance
		);
		assert_eq!(
			theme.version, THEME_VERSION,
			"the bundled {appearance} theme is at version {}, not the {THEME_VERSION} this build \
			 reads",
			theme.version
		);
		assert!(
			!theme.name.trim().is_empty(),
			"the bundled {appearance} theme has no name, so its row on the page draws nothing"
		);
		let missing: Vec<&'static str> = ColorRole::all()
			.into_iter()
			.filter(|role| !theme.roles.contains_key(role))
			.map(ColorRole::as_str)
			.collect();
		assert!(
			missing.is_empty(),
			"the bundled {appearance} theme declares no {missing:?}: a surface drawn from it would \
			 resolve those roles to nothing"
		);
	}
}

#[test]
fn a_theme_whose_text_is_under_the_floor_is_refused_rather_than_loaded() {
	let scratch = scratch_dir("appearance-contrast");
	let source = themes_dir().join("dark.toml");
	let text = fs::read_to_string(&source).expect("the bundled dark theme is readable");
	let ground = text
		.lines()
		.find(|line| line.trim_start().starts_with("ground"))
		.expect("the dark theme declares a ground");
	let foreground = text
		.lines()
		.find(|line| line.trim_start().starts_with("foreground"))
		.expect("the dark theme declares a foreground");
	// The foreground is set to the ground it is drawn on, which is a ratio of
	// 1.0:1 -- the one value no floor can admit.
	let ground_value = ground
		.split_once('=')
		.expect("the ground line is a key and a value")
		.1
		.trim();
	let broken = text.replace(foreground, &format!("foreground = {ground_value}"));
	let path = scratch.path().join("dark.toml");
	fs::write(&path, broken).expect("the broken theme is written");

	let error = load_theme(&path).expect_err("a theme whose text is invisible is refused");
	let TokenError::ContrastTooLow { foreground, background, ratio, required, .. } = error else {
		panic!("a theme whose foreground is its ground was refused as {error}, not for contrast");
	};
	assert_eq!(foreground, "foreground", "the refusal names another role");
	assert!(
		ratio < required,
		"the refusal reports {ratio}:1 against a floor of {required}:1, which is not a failure"
	);
	assert!(
		!background.is_empty(),
		"the refusal does not name the ground the text was measured against"
	);
}

#[test]
fn every_bundled_appearance_installs_and_draws_the_window_in_its_own_colours() {
	let frames: Vec<(&'static str, RgbaFrame)> = APPEARANCES
		.into_iter()
		.map(|appearance| {
			let frame = driven(appearance, on_the_themes_page(), |session| {
				session
					.frame()
					.expect("a window drawn in this appearance renders")
					.frame
			});
			(appearance, frame)
		})
		.collect();

	for (index, (appearance, frame)) in frames.iter().enumerate() {
		for (other, other_frame) in frames.iter().skip(index + 1) {
			let changed = changed_pixels(frame, other_frame);
			assert!(
				changed > 0,
				"a window drawn in {appearance} and one drawn in {other} are the same frame: one of \
				 the two appearances never reached the colours"
			);
		}
	}
}
