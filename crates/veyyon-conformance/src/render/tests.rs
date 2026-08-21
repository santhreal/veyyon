//! WHY: the defect this module exists for shipped. An explicit dark background
//! fill was invisible against the black ground the review was done on, looked
//! deliberate in the source, and reached an operator's grey terminal as a slab.
//! Both halves of that are invisible to a single-ground check: on black the
//! fill cannot be seen at all, and on grey it is perfectly visible and
//! therefore fine. Only the pair says anything.
//!
//! So every case below either resolves against both grounds or asserts the
//! difference between them, and the grounds are swept from `Ground::all()` so a
//! third one cannot be added with no case behind it.
//!
//! The class it closes: a colour relationship judged against one terminal's
//! default, a fill that paints nothing a reader can see, and text that stops
//! being readable once an attribute is applied to it.
//!
//! WHAT IT DOES NOT CATCH: what the terminal actually draws. Dim is modelled as
//! a blend because terminals disagree about it, some ignore it, and one renders
//! it as a different palette entry entirely; a cell that passes here can still
//! look wrong in a terminal that reinterprets the attribute. That is what the
//! capture configuration is for.

use std::collections::BTreeSet;

use super::{DIM_WEIGHT, DualGround, Finding, Ground, contrast, inspect, resolve};
use crate::vpty::cell::{Attributes, Cell, ColorRgb};

/// Near-black, the colour a "subtle" panel background is usually written as.
const PANEL: ColorRgb = ColorRgb::new(0x14, 0x16, 0x1a);
const BRIGHT: ColorRgb = ColorRgb::new(0xe6, 0xe9, 0xef);

fn styled(content: &str, fg: Option<ColorRgb>, bg: Option<ColorRgb>, attrs: Attributes) -> Cell {
	Cell::with_content(content, fg, bg, attrs)
}

fn dim() -> Attributes {
	Attributes { dim: true, ..Attributes::default() }
}

fn inverse() -> Attributes {
	Attributes { inverse: true, ..Attributes::default() }
}

#[test]
fn a_cell_with_no_colours_takes_them_from_the_ground() {
	// The reason resolution is parameterized at all: `None` is not a colour, and
	// resolving it against one terminal's default answers for one machine.
	for ground in Ground::all() {
		let resolved = resolve(&Cell::blank(), ground);
		assert_eq!(resolved.bg, ground.rgb(), "{ground}");
		assert_eq!(resolved.fg, ground.default_fg(), "{ground}");
		// A cell that inherited the ground painted nothing, so it is not a fill
		// and cannot be an invisible one.
		assert!(!resolved.explicit_bg, "{ground}");
	}
}

#[test]
fn inverse_swaps_the_colours_the_cell_declared() {
	let cell = styled("x", Some(BRIGHT), Some(PANEL), inverse());
	let resolved = resolve(&cell, Ground::Grey);
	assert_eq!((resolved.fg, resolved.bg), (PANEL, BRIGHT));
	// An inverse cell paints a surface whether or not it named a background,
	// which is why it counts as an explicit fill.
	assert!(resolve(&styled("x", Some(BRIGHT), None, inverse()), Ground::Grey).explicit_bg);
}

#[test]
fn dim_applies_to_the_foreground_that_survived_the_swap() {
	// Order matters and is the part a hand-rolled version gets wrong: dimming
	// before the swap dims the colour that ends up as the BACKGROUND, which
	// makes an unreadable cell look readable.
	let cell = styled("x", Some(BRIGHT), Some(PANEL), Attributes {
		dim: true,
		inverse: true,
		..Attributes::default()
	});
	let resolved = resolve(&cell, Ground::Grey);
	assert_eq!(resolved.bg, BRIGHT, "the swapped background must not be dimmed");
	assert_eq!(resolved.fg, contrast::blend(PANEL, BRIGHT, DIM_WEIGHT));
}

#[test]
fn dim_can_take_text_below_the_ratio_that_bright_text_meets() {
	// A theme's own concern: the colour passes, and then an attribute is applied
	// to it somewhere else and it stops passing.
	let mid = ColorRgb::new(0x8a, 0x90, 0x99);
	let bright = resolve(&styled("x", Some(mid), None, Attributes::default()), Ground::Grey);
	assert!(bright.glyph_ratio() >= contrast::TEXT_RATIO, "{}", bright.glyph_ratio());
	let dimmed = resolve(&styled("x", Some(mid), None, dim()), Ground::Grey);
	assert!(dimmed.glyph_ratio() < contrast::TEXT_RATIO, "{}", dimmed.glyph_ratio());
}

#[test]
fn a_fill_that_matches_the_ground_is_reported_on_that_ground_only() {
	// THE defect, with the colour it actually shipped as. A fill painted pure
	// black is 1.00 against a black ground — nothing is there to see — and 1.30
	// against the grey one, where it reads as a dark slab. A review done on
	// either ground alone concludes the opposite of a review done on the other.
	//
	// The near-black `PANEL` below is the case this does NOT catch: it measures
	// 1.12 on grey and 1.16 on black, so it is equally faint on both and there
	// is no ground-dependence to report.
	let grid = vec![vec![styled(" ", None, Some(ColorRgb::BLACK), Attributes::default())]];
	let dual = DualGround::inspect(&grid);

	let on_black = dual.findings(Ground::Black);
	assert_eq!(on_black.len(), 1, "{on_black:?}");
	assert_eq!(on_black[0].kind(), "invisible-fill");
	assert_eq!(on_black[0].position(), (0, 0));
	assert!(dual.findings(Ground::Grey).is_empty(), "{:?}", dual.findings(Ground::Grey));
	assert!(
		inspect(&[vec![styled(" ", None, Some(PANEL), Attributes::default())]], Ground::Black)
			.is_empty(),
		"a fill that is equally faint on both grounds is not ground-dependent"
	);

	// And it is reported as ground-dependent, which is the output that says "no
	// single terminal can show you this".
	let dependent = dual.ground_dependent();
	assert_eq!(dependent.len(), 1, "{dependent:?}");
	assert_eq!(dependent[0].0, Ground::Black);
	assert_eq!(dependent[0].1.kind(), "invisible-fill");
	assert!(!dual.is_clean());
}

#[test]
fn a_blank_cell_that_paints_a_background_is_still_a_fill() {
	// WHY: a fill IS a blank cell with a background — a rail, a bar segment, a
	// selected row. Skipping cells with no glyph would skip exactly the thing
	// this check exists to see.
	let grid =
		vec![vec![Cell::with_content("", None, Some(ColorRgb::BLACK), Attributes::default())]];
	assert_eq!(inspect(&grid, Ground::Black).len(), 1);
	// The same blank cell with no background of its own paints nothing.
	let inherited = vec![vec![Cell::blank()]];
	assert!(inspect(&inherited, Ground::Black).is_empty());
}

#[test]
fn a_visible_fill_on_both_grounds_is_reported_on_neither() {
	let grid = vec![vec![styled(" ", Some(ColorRgb::BLACK), Some(BRIGHT), Attributes::default())]];
	let dual = DualGround::inspect(&grid);
	assert!(dual.is_clean(), "{dual:?}");
	assert!(dual.ground_dependent().is_empty());
}

#[test]
fn illegible_text_is_reported_on_every_ground_that_shows_it() {
	// Grey-on-grey does not depend on the terminal: the cell named both colours,
	// so it is broken everywhere, and reporting it as ground-dependent would
	// send the reader looking for a terminal difference that is not there.
	let grid = vec![vec![styled(
		"veyyon",
		Some(ColorRgb::new(0x2a, 0x2d, 0x33)),
		Some(Ground::GREY_RGB),
		Attributes::default(),
	)]];
	let dual = DualGround::inspect(&grid);
	for ground in Ground::all() {
		let illegible: Vec<&Finding> = dual
			.findings(ground)
			.iter()
			.filter(|finding| finding.kind() == "illegible")
			.collect();
		assert_eq!(illegible.len(), 1, "{ground}: {illegible:?}");
	}
	assert!(
		dual
			.ground_dependent()
			.iter()
			.all(|(_, finding)| finding.kind() != "illegible"),
		"{:?}",
		dual.ground_dependent()
	);
}

#[test]
fn a_continuation_cell_is_not_judged_for_a_glyph_it_does_not_own() {
	// The trailing half of a wide character has no glyph; judging it would
	// report the same defect twice and blame a column that draws nothing.
	let grid = vec![vec![Cell::continuation(
		Some(ColorRgb::new(0x22, 0x24, 0x28)),
		Some(Ground::GREY_RGB),
		Attributes::default(),
	)]];
	assert!(
		inspect(&grid, Ground::Grey)
			.iter()
			.all(|finding| finding.kind() != "illegible"),
		"{:?}",
		inspect(&grid, Ground::Grey)
	);
}

#[test]
fn both_grounds_are_always_inspected() {
	// Swept from `Ground::all()`, so adding a ground without inspecting it fails
	// here rather than producing a report that silently covers less.
	let dual = DualGround::inspect(&[vec![Cell::blank()]]);
	let keys: BTreeSet<&str> = dual.per_ground.keys().copied().collect();
	let expected: BTreeSet<&str> = Ground::all().into_iter().map(Ground::as_str).collect();
	assert_eq!(keys, expected);
	assert_eq!(keys.len(), 2);
}

#[test]
fn inspecting_the_same_grid_twice_gives_equal_findings() {
	// Findings are compared and diffed between grounds, so they have to be
	// exactly equal across runs: a float ratio in the finding would produce two
	// values a reader cannot tell apart and the program can.
	let grid = vec![vec![styled(" ", None, Some(PANEL), Attributes::default())], vec![styled(
		"x",
		Some(ColorRgb::new(0x30, 0x33, 0x38)),
		None,
		Attributes::default(),
	)]];
	assert_eq!(DualGround::inspect(&grid), DualGround::inspect(&grid));
}

#[test]
fn a_finding_renders_its_ratio_to_two_places() {
	let grid = vec![vec![styled(" ", None, Some(ColorRgb::BLACK), Attributes::default())]];
	let finding = inspect(&grid, Ground::Black)[0];
	// Black on black is the degenerate case: identical colours contrast 1.00.
	assert_eq!(finding.to_string(), "invisible-fill at 0,0 (ratio 1.00)");
}

#[test]
fn the_contrast_formula_matches_its_published_anchors() {
	// The two values every WCAG implementation is checked against, plus the
	// degenerate one. An implementation that is off by a constant still orders
	// colours correctly and would pass a relative-only test.
	assert!((contrast::luminance(ColorRgb::WHITE) - 1.0).abs() < 1e-9);
	assert!(contrast::luminance(ColorRgb::BLACK).abs() < 1e-9);
	assert!((contrast::ratio(ColorRgb::BLACK, ColorRgb::WHITE) - 21.0).abs() < 1e-6);
	assert!((contrast::ratio(BRIGHT, BRIGHT) - 1.0).abs() < 1e-9);
	// Symmetric: the ratio is a property of the pair, not of which one is named
	// the foreground.
	assert!((contrast::ratio(PANEL, BRIGHT) - contrast::ratio(BRIGHT, PANEL)).abs() < 1e-12);
}

#[test]
fn a_fill_is_held_to_a_different_number_than_text() {
	// A rail at `#4a4f59` measures 1.96 against the grey ground: a surface a
	// reader plainly sees, and nowhere near readable as text. Judging fills by
	// the text ratio would report every rail, panel and bar in the theme, which
	// is a check that reports the theme instead of a defect in it.
	let rail = ColorRgb::new(0x4a, 0x4f, 0x59);
	let against_grey = contrast::ratio(rail, Ground::GREY_RGB);
	assert!((contrast::FILL_RATIO..contrast::TEXT_RATIO).contains(&against_grey));
	let grid = vec![vec![styled(" ", None, Some(rail), Attributes::default())]];
	assert!(inspect(&grid, Ground::Grey).is_empty());
	// And the same colour as a glyph on that ground is illegible, which is the
	// half a single threshold would get wrong in the other direction.
	let text = vec![vec![styled("x", Some(rail), Some(Ground::GREY_RGB), Attributes::default())]];
	assert!(
		inspect(&text, Ground::Grey)
			.iter()
			.any(|finding| finding.kind() == "illegible")
	);
}

#[test]
fn a_blend_reaches_both_ends_exactly() {
	// The endpoints are what a rounding bug breaks: a weight of 0 that shifts
	// the colour by one channel step turns every unstyled cell into a finding.
	assert_eq!(contrast::blend(BRIGHT, PANEL, 0), BRIGHT);
	assert_eq!(contrast::blend(BRIGHT, PANEL, 255), PANEL);
	let midpoint = contrast::blend(ColorRgb::BLACK, ColorRgb::WHITE, 128);
	assert_eq!(midpoint, ColorRgb::new(128, 128, 128));
}
