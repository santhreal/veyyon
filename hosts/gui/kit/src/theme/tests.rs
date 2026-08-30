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
//! WHAT IT DOES NOT CATCH. Whether the colours are pleasant, whether two
//! syntax hues are far enough apart to tell apart at eleven pixels, and whether
//! a surface draws the hairline at all: this says the line reads once drawn,
//! not that the fence, the patch and the tool's output ask for one. That is
//! `ui::card::well`, which is the one place they ask.

use veyyon_gui_core::store::model::Appearance;

use super::*;

fn lum(color: Hsla) -> f32 {
	color.l
}

/// 3/255 is the floor at which a boundary between two large fills is visible on
/// an ordinary panel.
const FLOOR: f32 = 3.0 / 255.0;

/// A hairline says where a surface ends. Its fill says which layer it is, and a
/// fill that says almost nothing leaves a window of outlines drawn on one flat
/// ground however crisp the outlines are. The light palette read that way: a
/// bubble stood six parts in 255 off its canvas where the dark one stood
/// fifteen, and a segmented control's selected segment needed a ground of its
/// own to be seen at all.
///
/// Both arms bite. The mark catches a stack that never separated, and the ratio
/// catches one that separates so much less in one appearance than the other
/// that only one palette was ever looked at.
#[test]
fn a_stacked_ground_says_which_layer_it_is_and_not_only_where_it_ends() {
	/// The pairs a reader tells apart by fill: a bubble on the canvas, a well
	/// cut into a surface, a sheet over what it covers. Named here so the two
	/// arms below sweep the same list.
	fn stack(theme: &Theme) -> [(&'static str, f32); 3] {
		[
			("a surface and its canvas", (theme.raised.l - theme.canvas.l).abs()),
			("a well and the surface it is cut into", (theme.sunken.l - theme.raised.l).abs()),
			("a sheet and what is behind it", (theme.overlay.l - theme.canvas.l).abs()),
		]
	}

	let dark = Theme::of(Appearance::Dark);
	let light = Theme::of(Appearance::Light);
	for (appearance, theme) in [(Appearance::Dark, &dark), (Appearance::Light, &light)] {
		for (what, apart) in stack(theme) {
			assert!(
				apart >= MARK,
				"{appearance:?}: {what} stand {:.1}/255 apart, under the {:.0}/255 a fill needs to be \
				 read at a glance",
				apart * 255.0,
				MARK * 255.0
			);
		}
		// The sidebar is the one boundary the window draws a hairline along, so
		// its fill is the second cue there rather than the only one.
		let framing = (theme.chrome.l - theme.canvas.l).abs();
		assert!(
			framing >= FLOOR,
			"{appearance:?}: the sidebar and the conversation are the same colour"
		);
	}

	for ((what, one), (_, other)) in stack(&dark).into_iter().zip(stack(&light)) {
		let (weaker, stronger) = if one < other {
			(one, other)
		} else {
			(other, one)
		};
		assert!(
			weaker >= stronger / 2.0,
			"{what} stand {:.1}/255 apart in one appearance and {:.1}/255 in the other, so the stack \
			 was built against one palette only",
			weaker * 255.0,
			stronger * 255.0
		);
	}
}

/// The one hairline in the window is what says where a well ends, because a
/// well is three parts in a hundred under the canvas in the dark palette and
/// the fill alone is a boundary a reader has to look for. A stroke thinned to
/// nothing takes the edge off a fence, a patch and a tool's output at once.
#[test]
fn the_hairline_reads_against_every_ground_it_is_drawn_on() {
	for appearance in [Appearance::Dark, Appearance::Light] {
		let theme = Theme::of(appearance);
		for (name, ground) in theme.grounds() {
			let line = over(theme.stroke, ground);
			assert!(
				(lum(line) - lum(ground)).abs() >= FLOOR,
				"{appearance:?}: a hairline on {name} at {:.3} vanishes into it at {:.3}",
				lum(line),
				lum(ground)
			);
		}
	}
}

/// A colour with alpha, over an opaque ground, as the compositor lands it.
fn over(top: Hsla, ground: Hsla) -> Hsla {
	Hsla { l: ground.l + top.a * (top.l - ground.l), a: 1.0, ..ground }
}

/// 13/255 is the floor at which a fill is seen at a glance rather than found.
/// Every ground the window stacks carries something at that weight: which layer
/// a surface is, and, for the well a segmented control is cut into, which value
/// is set.
const MARK: f32 = 13.0 / 255.0;

#[test]
fn the_depth_order_is_the_same_shape_in_both_appearances() {
	// A well is behind the surface it is cut into, a surface and a sheet are in
	// front of the canvas, and both palettes lift toward white. The chrome is
	// the one field that turns: it frames the content from above in the dark
	// and from below in the light, which is the same recession read the other
	// way. So the comparison is against the canvas rather than an absolute.
	for appearance in [Appearance::Dark, Appearance::Light] {
		let theme = Theme::of(appearance);
		assert!(lum(theme.sunken) < lum(theme.canvas), "{appearance:?}: a well is not cut in");
		assert!(lum(theme.raised) > lum(theme.canvas), "{appearance:?}: a surface does not lift");
		assert!(
			lum(theme.overlay) >= lum(theme.raised),
			"{appearance:?}: a sheet is behind a surface"
		);
	}

	let dark = Theme::of(Appearance::Dark);
	let light = Theme::of(Appearance::Light);
	assert!(lum(dark.chrome) > lum(dark.canvas), "dark: the chrome does not frame from above");
	assert!(lum(light.chrome) < lum(light.canvas), "light: the chrome does not frame from below");
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
