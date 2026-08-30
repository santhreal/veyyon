//! WHY THIS SUITE EXISTS.
//!
//! Two palettes, one field set, and the failure is silent: a field left at the
//! other appearance's value paints one region invisible in one mode only, which
//! nobody sees until they flip. With one hairline left in the window, every
//! other boundary is carried by the difference between two fills, so two fills
//! that converge erase a boundary outright. The syntax set has the same failure
//! at nine more fields, on a well nobody looks at in both modes.
//!
//! The sweeps run over the appearance list and over `Syntax::all`, so a colour
//! added to either set is covered without anyone remembering to add a case.
//!
//! WHAT IT DOES NOT CATCH. Whether the colours are pleasant, and whether two
//! syntax hues are far enough apart to tell apart at eleven pixels.

use veyyon_gui_core::store::model::Appearance;

use super::*;

fn lum(color: Hsla) -> f32 {
	color.l
}

/// 3/255 is the floor at which a boundary between two large fills is visible on
/// an ordinary panel.
const FLOOR: f32 = 3.0 / 255.0;

#[test]
fn every_boundary_the_window_draws_without_a_line_is_visible_as_a_fill() {
	for appearance in [Appearance::Dark, Appearance::Light] {
		let theme = Theme::of(appearance);
		for (left, right, what) in [
			(theme.chrome, theme.canvas, "the sidebar and the conversation"),
			(theme.raised, theme.canvas, "a surface and its canvas"),
			(theme.sunken, theme.raised, "a well and the surface it is cut into"),
			(theme.overlay, theme.canvas, "a sheet and what is behind it"),
		] {
			assert!(
				(lum(left) - lum(right)).abs() >= FLOOR,
				"{appearance:?}: {what} are the same colour"
			);
		}
	}
}

#[test]
fn the_depth_order_is_the_same_shape_in_both_appearances() {
	// A well is always behind the surface it is cut into, and a sheet is always
	// in front of the canvas. Dark lifts toward white and light lifts toward
	// black, so the comparison is against the canvas rather than an absolute.
	let dark = Theme::of(Appearance::Dark);
	assert!(lum(dark.sunken) < lum(dark.canvas));
	assert!(lum(dark.overlay) > lum(dark.canvas));
	assert!(lum(dark.chrome) > lum(dark.canvas));

	let light = Theme::of(Appearance::Light);
	assert!(lum(light.sunken) < lum(light.canvas));
	assert!(lum(light.overlay) >= lum(light.canvas));
	assert!(lum(light.chrome) < lum(light.canvas));
}

#[test]
fn text_reads_against_the_ground_it_sits_on_in_both_appearances() {
	for appearance in [Appearance::Dark, Appearance::Light] {
		let theme = Theme::of(appearance);
		let gap = (lum(theme.text) - lum(theme.canvas)).abs();
		assert!(gap > 0.5, "{appearance:?}: body text has no contrast against the canvas");
		let faint = (lum(theme.text_faint) - lum(theme.canvas)).abs();
		assert!(faint > 0.15, "{appearance:?}: the faintest text is invisible");
		let on_accent = (lum(theme.text_on_accent) - lum(theme.accent)).abs();
		assert!(on_accent > 0.25, "{appearance:?}: text on an accent fill is invisible");
	}
}

#[test]
fn every_syntax_colour_reads_against_the_well_a_fence_is_drawn_in() {
	for appearance in [Appearance::Dark, Appearance::Light] {
		let theme = Theme::of(appearance);
		for (token, color) in theme.syntax.all() {
			let gap = (lum(color) - lum(theme.sunken)).abs();
			assert!(
				gap > 0.18,
				"{appearance:?}: {token:?} at {:.3} is invisible on a well at {:.3}",
				lum(color),
				lum(theme.sunken)
			);
			assert_eq!(color.a, 1.0, "{appearance:?}: {token:?} is not opaque");
		}
	}
}

#[test]
fn a_diff_line_is_tinted_rather_than_filled_and_the_two_sides_differ() {
	for appearance in [Appearance::Dark, Appearance::Light] {
		let theme = Theme::of(appearance);
		for (name, ground) in [("added", theme.added), ("removed", theme.removed)] {
			assert!(ground.a > 0.05, "{appearance:?}: the {name} ground is invisible");
			assert!(ground.a < 0.5, "{appearance:?}: the {name} ground drowns its text");
		}
		assert!(
			(theme.added.h - theme.removed.h).abs() > 0.1,
			"{appearance:?}: added and removed are the same hue"
		);
	}
}

#[test]
fn a_status_colour_is_distinct_from_the_other_three_in_both_appearances() {
	for appearance in [Appearance::Dark, Appearance::Light] {
		let theme = Theme::of(appearance);
		let states = [
			("accent", theme.accent),
			("ok", theme.ok),
			("warn", theme.warn),
			("danger", theme.danger),
		];
		for (index, (left_name, left)) in states.iter().enumerate() {
			for (right_name, right) in states.iter().skip(index + 1) {
				let hue = (left.h - right.h).abs();
				assert!(
					hue.min(1.0 - hue) > 0.05,
					"{appearance:?}: {left_name} and {right_name} are the same hue"
				);
			}
		}
	}
}

#[test]
fn a_shadow_is_denser_in_the_dark_where_the_ground_under_it_is_already_dark() {
	let dark = Theme::of(Appearance::Dark).shadow_sheet();
	let light = Theme::of(Appearance::Light).shadow_sheet();
	assert_eq!(dark.len(), light.len(), "the two appearances stack shadows differently");
	assert!(
		dark[0].color.a > light[0].color.a,
		"a sheet's shadow is not denser in the dark palette"
	);
}

#[test]
fn flipping_the_appearance_selects_the_other_palette() {
	assert_eq!(Theme::of(Appearance::Dark).appearance, Appearance::Dark);
	assert_eq!(Theme::of(Appearance::Dark.flipped()).appearance, Appearance::Light);
}
