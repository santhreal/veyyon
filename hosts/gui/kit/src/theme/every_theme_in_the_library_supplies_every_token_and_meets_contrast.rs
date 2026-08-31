//! WHY THIS SUITE EXISTS.
//!
//! A theme library can fail in two silent ways: a new theme omitting a token
//! and inheriting an invisible or jarring default, or a
//! foreground-on-background color pair failing WCAG AA contrast on one ground
//! while passing on others. Furthermore, interface scale and theme palette must
//! remain completely orthogonal: changing a theme must never alter geometry or
//! text sizes, and scaling interface text must never mutate any theme color.
//!
//! THE CLASS. Incomplete palettes, contrast regressions across grounds, and
//! coupling between theme selection and geometric layout.
//!
//! WHAT IT DOES NOT CATCH. Subjective aesthetic harmony or whether a platform
//! font renders specific glyphs clearly.

use super::{
	Appearance, contrast_pairs, contrast_ratio, entries, layout, radius, resolve_theme, scale, size,
	space,
};

#[test]
fn every_theme_in_the_library_supplies_every_token_with_valid_values() {
	let library_entries = entries();
	assert!(!library_entries.is_empty(), "theme library must contain at least one theme");

	for entry in library_entries {
		let theme = &entry.theme;

		// Assert all grounds are fully opaque.
		for (name, ground) in theme.grounds() {
			assert_eq!(ground.a, 1.0, "theme `{}` ground `{name}` must be opaque", entry.name);
		}

		// Assert text and accent tokens have valid alpha.
		assert_eq!(theme.text.a, 1.0, "theme `{}` text must be opaque", entry.name);
		assert_eq!(
			theme.text_on_accent.a, 1.0,
			"theme `{}` text_on_accent must be opaque",
			entry.name
		);
		assert_eq!(theme.accent.a, 1.0, "theme `{}` accent must be opaque", entry.name);

		// Assert status tokens are distinct and valid.
		for (role, color) in
			[("info", theme.info), ("danger", theme.danger), ("ok", theme.ok), ("warn", theme.warn)]
		{
			assert_eq!(color.a, 1.0, "theme `{}` status `{role}` must be opaque", entry.name);
		}

		// Assert all syntax tokens are present and opaque.
		for (token, color) in theme.syntax.all() {
			assert_eq!(color.a, 1.0, "theme `{}` syntax token `{token:?}` must be opaque", entry.name);
		}
	}
}

#[test]
fn every_foreground_background_pair_meets_stated_contrast_ratio() {
	for entry in entries() {
		let pairs = contrast_pairs(&entry.theme);
		assert!(!pairs.is_empty(), "theme `{}` must provide contrast pairs", entry.name);

		for pair in pairs {
			let ratio = contrast_ratio(pair.foreground, pair.background);
			assert!(
				ratio >= pair.minimum_ratio,
				"theme `{}` pair `{}` ratio {:.2}:1 failed minimum {:.2}:1 (fg: {:?}, bg: {:?})",
				entry.name,
				pair.role,
				ratio,
				pair.minimum_ratio,
				pair.foreground,
				pair.background,
			);
		}
	}
}

#[test]
fn theme_changes_do_not_alter_measurements() {
	// Sample measurements across layout, typography, space, and radius.
	scale::set_base_font(scale::DEFAULT_MILLI_PX);

	let baseline_space_base = space::BASE;
	let baseline_space_loose = space::LOOSE;
	let baseline_radius_card = radius::CARD;
	let baseline_layout_titlebar = layout::titlebar();
	let baseline_size_body = size::body();
	let baseline_control_height = layout::control_height();

	for entry in entries() {
		// Even if a theme is applied, geometric tokens are invariant.
		assert_eq!(space::BASE, baseline_space_base, "theme `{}` altered space::BASE", entry.name);
		assert_eq!(space::LOOSE, baseline_space_loose, "theme `{}` altered space::LOOSE", entry.name);
		assert_eq!(radius::CARD, baseline_radius_card, "theme `{}` altered radius::CARD", entry.name);
		assert_eq!(
			layout::titlebar(),
			baseline_layout_titlebar,
			"theme `{}` altered layout::titlebar",
			entry.name
		);
		assert_eq!(size::body(), baseline_size_body, "theme `{}` altered size::body", entry.name);
		assert_eq!(
			layout::control_height(),
			baseline_control_height,
			"theme `{}` altered layout::control_height",
			entry.name
		);
	}
}

#[test]
fn interface_scale_changes_do_not_alter_theme_colors() {
	for entry in entries() {
		let initial_ground = entry.theme.ground;
		let initial_accent = entry.theme.accent;
		let initial_text = entry.theme.text;

		for scale_milli in [scale::MIN_MILLI_PX, scale::DEFAULT_MILLI_PX, scale::MAX_MILLI_PX] {
			scale::set_base_font(scale_milli);

			assert_eq!(
				entry.theme.ground, initial_ground,
				"scale {scale_milli} mutated ground color in `{}`",
				entry.name
			);
			assert_eq!(
				entry.theme.accent, initial_accent,
				"scale {scale_milli} mutated accent color in `{}`",
				entry.name
			);
			assert_eq!(
				entry.theme.text, initial_text,
				"scale {scale_milli} mutated text color in `{}`",
				entry.name
			);
		}
	}
	// Restore default scale.
	scale::set_base_font(scale::DEFAULT_MILLI_PX);
}

#[test]
fn theme_resolution_honors_known_and_reports_refused_unknown() {
	// Known themes resolve without refusal, whatever the window's appearance.
	for entry in entries() {
		for appearance in [Appearance::Dark, Appearance::Light] {
			let report = resolve_theme(Some(entry.id), appearance);
			assert_eq!(report.entry.id, entry.id, "theme `{}` did not resolve", entry.id);
			assert_eq!(report.refused, None, "known theme `{}` was refused", entry.id);
		}
	}

	// No name, and a name of nothing but spaces, resolve to the default of the
	// appearance the window is on, and refuse nothing: the reader named no
	// theme, so there is nothing to report as unavailable.
	for (appearance, expected) in [(Appearance::Dark, "dark"), (Appearance::Light, "light")] {
		for requested in [None, Some("   ")] {
			let report = resolve_theme(requested, appearance);
			assert_eq!(
				report.entry.id, expected,
				"a window with no theme chosen drew neither default for {appearance:?}"
			);
			assert_eq!(report.refused, None);
		}

		// A name this build does not ship falls back to that same default and
		// states the name, which is what the settings page reports. A light
		// window falling back to the dark palette is the drift this pins: the
		// frame installs what this resolves, so the two cannot disagree.
		let unknown = resolve_theme(Some("nonexistent-theme-xyz"), appearance);
		assert_eq!(unknown.entry.id, expected, "the refused fallback ignored the appearance");
		assert_eq!(
			unknown.refused,
			Some("nonexistent-theme-xyz".to_string()),
			"unknown theme was not reported in refusal"
		);
	}
}
