//! WHY THIS SUITE EXISTS.
//!
//! A text-size preference that multiplies only the type sizes produces a window
//! that is worse at every size but the default: 20px glyphs in a 28px row clip
//! against the row above, a 16px icon beside 26px text reads as a bullet, and a
//! 32px composer holds one line of text with its descenders cut off. So the
//! scale applies to the type, to the rows and controls the type sits in, to the
//! icons beside it, and to the measures derived from a line of text; a metric
//! that holds a glyph is a function of the scale, and a metric that does not is
//! a constant.
//!
//! THE CLASS IT CLOSES. A token that holds a glyph and does not move with the
//! text, a row that stops being tall enough to hold its own text at some size a
//! reader can choose, and an accessor added to the token modules and never
//! exercised at any size but the one it was designed at. [`SCALING`] is the
//! table every accessor is driven through, and
//! `scripts/the-gui-crates-only-depend-downward.test.ts` compares it against
//! the accessors declared in `tokens.rs` and `geometry.rs`, so an accessor
//! added there and not added here turns that suite red rather than going
//! untested.
//!
//! WHAT IT DOES NOT CATCH. Whether the fixed geometry is right to be fixed: a
//! 256px sidebar at 24px text holds four words, and no assertion here says it
//! should widen. Whether the shell installs the preference, which is the gate
//! test's fourth arm. And whether the result reads well, which is a capture.

use super::{control, diff, geometry, icon, layout, row, scale, size, tokens};

/// A token accessor, and one named for reporting. The name is what a failure
/// prints, so a sweep says which token moved rather than which index did.
type Metric = fn() -> f32;
type Named = (&'static str, Metric);
/// A metric and the type size it has to hold.
type Holding = (&'static str, Metric, Metric);

/// Every metric that moves with the text, and the name it is reported under.
///
/// A table rather than a list of assertions: each property below sweeps all of
/// it, so a token is covered by every rule the moment it is named here once.
pub const SCALING: &[Named] = &[
	("size::overline", size::overline),
	("size::meta", size::meta),
	("size::mono", size::mono),
	("size::body", size::body),
	("size::lead", size::lead),
	("size::section", size::section),
	("size::display", size::display),
	("size::display_large", size::display_large),
	("row::compact", row::compact),
	("row::normal", row::normal),
	("row::roomy", row::roomy),
	("row::two_line", row::two_line),
	("icon::small", icon::small),
	("icon::normal", icon::normal),
	("icon::large", icon::large),
	("icon::optical_box", icon::optical_box),
	("control::switch_width", control::switch_width),
	("control::switch_height", control::switch_height),
	("control::switch_knob", control::switch_knob),
	("control::checkbox", control::checkbox),
	("control::checkbox_mark", control::checkbox_mark),
	("control::radio", control::radio),
	("control::radio_dot", control::radio_dot),
	("control::menu_width", control::menu_width),
	("control::action_slot", control::action_slot),
	("control::two_action_slots", control::two_action_slots),
	("control::stepper_value_width", control::stepper_value_width),
	("layout::titlebar", layout::titlebar),
	("layout::toolbar", layout::toolbar),
	("layout::activity_rail", layout::activity_rail),
	("layout::reading", layout::reading),
	("layout::measure", layout::measure),
	("layout::conversation_wide", layout::conversation_wide),
	("layout::control_height", layout::control_height),
	("layout::editor_single_line", layout::editor_single_line),
	("layout::composer_min_height", layout::composer_min_height),
	("layout::composer_max_height", layout::composer_max_height),
	("layout::fade_band", layout::fade_band),
	("layout::fade_band_tight", layout::fade_band_tight),
	("layout::row_tight", layout::row_tight),
	("layout::row", layout::row),
	("layout::row_tall", layout::row_tall),
	("diff::line_height", diff::line_height),
	("diff::hunk_header_height", diff::hunk_header_height),
	("diff::file_header_height", diff::file_header_height),
	("diff::line_number_gutter", diff::line_number_gutter),
	("diff::marker_gutter", diff::marker_gutter),
	("diff::toolbar_height", diff::toolbar_height),
];

/// The scale is installed per thread, so a test that installs one is invisible
/// to the suite running beside it. Restoring the default anyway keeps a case
/// that spans two sizes honest about which one it is asserting.
fn with_base<R>(milli_px: u32, body: impl FnOnce() -> R) -> R {
	scale::set_base_font(milli_px);
	let out = body();
	scale::set_base_font(scale::DEFAULT_MILLI_PX);
	out
}

/// The two primitives every token above goes through, at the ratio that
/// divides none of them evenly. A box is rounded and a type size is not, and
/// the difference is the whole reason there are two.
#[test]
fn the_primitives_round_a_box_and_leave_a_type_size_fractional() {
	assert_eq!(scale::scaled(32.0), 32.0);
	assert_eq!(scale::scaled_type(13.0), 13.0);
	with_base(scale::DEFAULT_MILLI_PX * 2, || {
		assert_eq!(scale::interface(), 2.0);
		assert_eq!(scale::scaled(32.0), 64.0);
		assert_eq!(scale::scaled_type(13.0), 26.0);
	});
	with_base(14_000, || {
		// 32 * 14/13 = 34.46, taken to a whole pixel.
		assert_eq!(scale::scaled(32.0), 34.0);
		// 12.5 * 14/13 = 13.46, kept fractional for the shaper.
		assert!((scale::scaled_type(12.5) - 13.461_538).abs() < 0.001);
	});
}

/// Every size the appearance page offers, plus the ends of the range the store
/// clamps to. Read from the tokens rather than written here, so a size added to
/// the page is swept without anyone remembering to add it.
fn choices() -> Vec<u32> {
	let mut sizes: Vec<u32> = tokens::size::CHOICES_PX
		.iter()
		.map(|px| (px * 1_000.0) as u32)
		.collect();
	sizes.push(scale::MIN_MILLI_PX);
	sizes.push(scale::MAX_MILLI_PX);
	sizes
}

/// The default is the size the tokens were drawn at, so the window at defaults
/// has to be identical to the window before any of this existed. A scale that
/// multiplies by 0.999 at the default would pass every other test here and move
/// every hairline in the window by a subpixel.
#[test]
fn the_default_size_moves_nothing() {
	assert_eq!(scale::interface(), 1.0);
	for (name, metric) in SCALING {
		let designed = metric();
		with_base(scale::DEFAULT_MILLI_PX, || {
			assert_eq!(metric(), designed, "{name} moved at the size it was designed at");
		});
	}
}

/// The whole claim, swept over every accessor: at twice the text size, every
/// metric that holds a glyph is twice as large. Within a pixel, because a box
/// is rounded to a whole pixel and a type size is not.
#[test]
fn every_metric_that_holds_a_glyph_doubles_with_the_text() {
	let designed: Vec<f32> = SCALING.iter().map(|(_, metric)| metric()).collect();
	with_base(scale::DEFAULT_MILLI_PX * 2, || {
		for ((name, metric), base) in SCALING.iter().zip(&designed) {
			let doubled = metric();
			assert!(
				(doubled - base * 2.0).abs() <= 1.0,
				"{name}: {base} at the default, {doubled} at twice the text size",
			);
		}
	});
}

/// The failure this exists for. A row is only a row if the text fits in it, and
/// the two are separate numbers, so a scale applied to one and not the other
/// clips every row in the window at some size a reader can pick.
///
/// The bound is the line box: the type size times the tightest line height
/// chrome uses. A row exactly that tall holds the glyphs with no padding, which
/// is the floor rather than the target.
#[test]
fn a_row_still_holds_its_own_text_at_every_size_a_reader_can_choose() {
	// Each row token, and the type it is drawn with. A row that holds body
	// text is measured against body text; the diff's rows hold mono.
	let rows: &[Holding] = &[
		("row::compact", row::compact, size::meta),
		("row::normal", row::normal, size::body),
		("row::roomy", row::roomy, size::body),
		("row::two_line", row::two_line, size::body),
		("layout::titlebar", layout::titlebar, size::body),
		("layout::toolbar", layout::toolbar, size::body),
		("layout::control_height", layout::control_height, size::body),
		("layout::editor_single_line", layout::editor_single_line, size::body),
		("layout::composer_min_height", layout::composer_min_height, size::body),
		("diff::line_height", diff::line_height, size::mono),
		("diff::hunk_header_height", diff::hunk_header_height, size::meta),
		("diff::file_header_height", diff::file_header_height, size::body),
		("control::action_slot", control::action_slot, size::body),
	];
	for milli in choices() {
		with_base(milli, || {
			for (name, height, text) in rows {
				let line = text() * tokens::size::LINE_CHROME;
				assert!(
					height() >= line,
					"{name} is {} at {milli} thousandths, and its text needs {line}",
					height(),
				);
			}
		});
	}
}

/// An icon sits beside text, and a switch, a checkbox and a radio sit in a row
/// with it. Each is bounded by the row it shares, so a scale that grows one
/// faster than the other pushes a control out of its own row.
#[test]
fn a_control_still_fits_the_row_it_shares_with_the_text() {
	let in_a_row: &[Named] = &[
		("icon::normal", icon::normal),
		("icon::large", icon::large),
		("icon::optical_box", icon::optical_box),
		("control::switch_height", control::switch_height),
		("control::switch_knob", control::switch_knob),
		("control::checkbox", control::checkbox),
		("control::radio", control::radio),
	];
	for milli in choices() {
		with_base(milli, || {
			for (name, metric) in in_a_row {
				assert!(
					metric() <= row::normal(),
					"{name} is {} at {milli} thousandths, in a {} row",
					metric(),
					row::normal(),
				);
			}
		});
	}
}

/// The order between two sizes of one thing is the design, not an accident of
/// the default: a scale that rounds two adjacent tokens onto the same pixel
/// erases the distinction the token names.
#[test]
fn the_order_within_a_family_survives_every_size() {
	for milli in choices() {
		with_base(milli, || {
			assert!(row::compact() < row::normal(), "rows collapsed at {milli}");
			assert!(row::normal() < row::roomy(), "rows collapsed at {milli}");
			assert!(row::roomy() < row::two_line(), "rows collapsed at {milli}");
			assert!(icon::small() < icon::normal(), "icons collapsed at {milli}");
			assert!(icon::normal() < icon::large(), "icons collapsed at {milli}");
			assert!(size::meta() < size::body(), "type collapsed at {milli}");
			assert!(size::body() < size::lead(), "type collapsed at {milli}");
			assert!(size::lead() < size::section(), "type collapsed at {milli}");
			assert!(size::section() < size::display(), "type collapsed at {milli}");
			assert!(size::display() < size::display_large(), "type collapsed at {milli}");
		});
	}
}

/// A box lands on a whole pixel and type does not. A row height of 30.7 puts
/// the hairline under it on a half pixel, which reads as a list whose lines
/// alternate in thickness; a type size rounded to a whole pixel lands two
/// distinct sizes on one.
#[test]
fn a_box_lands_on_a_whole_pixel_and_a_type_size_does_not() {
	// 14/13 is a ratio that divides no token evenly, so every rounding is
	// exercised rather than the one case that happens to be exact.
	with_base(14_000, || {
		for (name, metric) in SCALING {
			if name.starts_with("size::") {
				continue;
			}
			assert_eq!(metric().fract(), 0.0, "{name} is {} and not a whole pixel", metric());
		}
		assert!(size::mono().fract() > 0.0, "a type size was rounded to a pixel");
	});
}

/// The preference and the scale clamp to one range, defined once in core. Two
/// ranges that agree today diverge the first time one of them moves, and the
/// symptom is a size the settings page offers and the window refuses.
#[test]
fn a_size_outside_the_range_is_clamped_rather_than_drawn() {
	assert_eq!(scale::MIN_MILLI_PX, u32::from(veyyon_gui_core::navigation::font_size::MIN_MILLI_PX),);
	assert_eq!(scale::MAX_MILLI_PX, u32::from(veyyon_gui_core::navigation::font_size::MAX_MILLI_PX),);
	assert_eq!(
		scale::DEFAULT_MILLI_PX,
		u32::from(veyyon_gui_core::navigation::font_size::DEFAULT_MILLI_PX),
	);
	with_base(1, || assert_eq!(scale::base_font(), scale::MIN_MILLI_PX as f32 / 1_000.0));
	with_base(u32::MAX, || assert_eq!(scale::base_font(), scale::MAX_MILLI_PX as f32 / 1_000.0));
}

/// Every size the appearance page offers is a size the store will hold: a
/// choice outside the clamp is a tab that never reads as selected, because the
/// preference it writes comes back as a different number.
#[test]
fn every_size_the_page_offers_round_trips_through_the_clamp() {
	for milli in tokens::size::CHOICES_PX
		.iter()
		.map(|px| (px * 1_000.0) as u32)
	{
		assert!(
			(scale::MIN_MILLI_PX..=scale::MAX_MILLI_PX).contains(&milli),
			"the page offers {milli} thousandths, outside the store's range",
		);
		with_base(milli, || {
			assert_eq!(scale::base_font(), milli as f32 / 1_000.0, "{milli} did not round-trip")
		});
	}
}

/// Fixed geometry is fixed. A panel width, a breakpoint and the platform's
/// window controls are questions about the window rather than about the text,
/// so a scale that reached them would decide at 24px text that a 1200px window
/// has no room for a sidebar it is already showing.
#[test]
fn the_windows_own_geometry_does_not_move_with_the_text() {
	with_base(scale::MAX_MILLI_PX, || {
		assert_eq!(geometry::layout::SIDEBAR, 256.0);
		assert_eq!(geometry::layout::INSPECTOR, 340.0);
		assert_eq!(geometry::layout::MIN_WINDOW_WIDTH, 820.0);
		assert_eq!(geometry::layout::BREAKPOINT_INLINE, 1180.0);
		assert_eq!(geometry::layout::WINDOW_CONTROL_CLUSTER, 138.0);
		// A breakpoint decides what a window width can hold, and the panel it
		// hides is measured in the same fixed units, so the two stay comparable
		// at every text size: the widest window that hides the sidebar still
		// reports the layout that shows it.
		assert_eq!(
			super::responsive_layout(geometry::layout::BREAKPOINT_INLINE),
			super::ResponsiveLayout::Inline,
		);
	});
}
