//! The themes that ship with veyyon.
//!
//! Embedded from the coding-agent package at build time, so there is one set of
//! theme files in the repository and both front ends read it. See `build.rs`.

use crate::{file::ThemeError, palette::Palette};

include!(concat!(env!("OUT_DIR"), "/bundled.rs"));

/// The name of the theme a fresh install uses.
pub const DEFAULT: &str = "dark";

/// Every bundled theme's name, sorted.
pub fn names() -> impl Iterator<Item = &'static str> {
	BUNDLED.iter().map(|(name, _)| *name)
}

/// The bytes of a bundled theme's file, or `None` when no theme has that name.
pub fn source(name: &str) -> Option<&'static str> {
	BUNDLED
		.binary_search_by_key(&name, |(bundled, _)| *bundled)
		.ok()
		.map(|index| BUNDLED[index].1)
}

/// Resolve a bundled theme. `None` when no theme has that name.
///
/// Parsed on each call rather than cached: a palette is 76 colours and the
/// caller holds it for the lifetime of the window, so the parse happens once
/// per theme switch and a cache would only add a lock.
pub fn load(name: &str) -> Option<Result<Palette, ThemeError>> {
	source(name).map(|json| Palette::parse(name, json))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::role::Role;

	/// Every bundled theme resolves. This is the whole point of the crate: theme
	/// files written for a terminal, each producing a full window palette with
	/// no per-theme special case.
	///
	/// The count is pinned rather than bounded below. A theme dropped from the
	/// bundle is a theme an operator's settings still names, so it is a decision
	/// someone records here, not a silent shrink.
	#[test]
	fn every_bundled_theme_resolves() {
		assert_eq!(BUNDLED.len(), 100, "the bundled set changed size");
		for name in names() {
			let palette = load(name)
				.expect("named theme exists")
				.unwrap_or_else(|error| panic!("{name} did not resolve: {error}"));
			assert_eq!(palette.name, name, "{name} states a different name in its file");
		}
	}

	/// Every role of every bundled theme comes from the theme rather than from
	/// the array's initial black. A missed role would paint one surface
	/// invisible in every theme at once.
	#[test]
	fn every_role_of_every_bundled_theme_is_set() {
		for name in names() {
			let palette = load(name).expect("exists").expect("resolves");
			for role in Role::ALL {
				let rgba = gpui::Rgba::from(palette[*role]);
				assert!(rgba.a > 0.0, "{name} left {} fully transparent", role.key());
			}
		}
	}

	/// The default theme is one of the bundled ones, and so is its light
	/// counterpart. A default that names a theme that was renamed is a window
	/// with no colours.
	#[test]
	fn the_named_defaults_are_bundled() {
		for name in [DEFAULT, "light"] {
			assert!(load(name).is_some(), "{name} is not bundled");
		}
	}

	/// `source` binary-searches, which requires the table to be sorted and free
	/// of duplicates. The build script produces both properties; this is the
	/// assertion that it still does. A duplicate name would make one of the two
	/// files unreachable, and which one would depend on where the search landed.
	#[test]
	fn the_bundled_table_is_sorted_and_lookups_hit() {
		let names: Vec<&str> = names().collect();
		let mut sorted = names.clone();
		sorted.sort_unstable();
		assert_eq!(names, sorted, "the bundled table is not sorted");

		let mut unique = sorted.clone();
		unique.dedup();
		assert_eq!(unique.len(), names.len(), "the bundled table has duplicate names");

		for name in &names {
			assert!(source(name).is_some(), "{name} is in the table but does not look up");
		}
		assert_eq!(source("no-such-theme"), None);
		assert_eq!(source(""), None);
	}

	/// Themes are split between light and dark, and both branches of the
	/// derivation are exercised by the bundled set. A set that turned out to be
	/// all dark would leave the light derivation covered only by hand-written
	/// fixtures.
	#[test]
	fn the_bundled_set_covers_both_appearances() {
		use crate::palette::Appearance;
		let mut light = 0;
		let mut dark = 0;
		for name in names() {
			match load(name).expect("exists").expect("resolves").appearance {
				Appearance::Light => light += 1,
				Appearance::Dark => dark += 1,
			}
		}
		assert!(light > 0, "no bundled theme is light");
		assert!(dark > 0, "no bundled theme is dark");
	}

	/// No bundled theme uses the `gui` override block. They are shared with the
	/// terminal, and a GUI-only key in a shared file is a colour the terminal
	/// ignores — which is how the two front ends drift apart. If this fails,
	/// either the override was intended and this assertion should name it, or it
	/// belongs in the derivation instead.
	#[test]
	fn no_bundled_theme_needs_a_gui_override() {
		use crate::file::ThemeFile;
		let mut with_overrides: Vec<&str> = Vec::new();
		for name in names() {
			let file = ThemeFile::parse(name, source(name).expect("exists")).expect("parses");
			if !file.gui.is_empty() {
				with_overrides.push(name);
			}
		}
		assert_eq!(with_overrides, Vec::<&str>::new());
	}
}
