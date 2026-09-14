//! WHY THIS SUITE EXISTS:
//! A bash invocation is prefixed with its environment, so the command a tool
//! view leads with is routinely three hundred characters of one unbreakable
//! run. `desktop-tool-view` photographed it drawn straight through the card's
//! right border and cut mid-glyph, with no ellipsis: the lead row of a code
//! section was a text child of a `flex_row` that neither shrank it (`min_w_0`)
//! nor clipped it, so the run measured its own intrinsic width and painted
//! outside every ancestor that was supposed to hold it.
//!
//! THE CLASS THIS CLOSES:
//! Any text a tool view draws outside the block that holds it, and any line a
//! view holds to one row that is masked at the block's edge rather than
//! truncated — the two halves of what the capture showed. Both are read off
//! the frame, not off one renderer's styles, so text that escapes through a
//! row nobody thought about fails here too. `ToolView` is swept by exhaustive
//! match, so a variant added to the union fails to compile until it is seeded;
//! `SectionShape` is swept from `iter()` and pinned by exact equality; and the
//! set of views that hold a line to one row is pinned the same way, so
//! relaxing one is a decision somebody records rather than a sweep that
//! quietly shrinks. Every case renders through `render_invoke_block`, the
//! production path the transcript draws.
//!
//! WHAT IT MEASURES, AND WHY THREE CHANNELS:
//! Containment is read off the raster: no pixel differs from the window's
//! ground to the right of the block. Recorded run geometry cannot answer that,
//! because a run's bounds carry the width of its UNWRAPPED shaped line
//! (`paint_line` records `layout.width` from `unwrapped_layout`), so a
//! paragraph that wrapped correctly inside the block and a run painted
//! straight through its edge report the same number.
//!
//! Ink alone is not enough either. `overflow_hidden` keeps the pixels inside
//! while the run is still shaped at full width, which is a glyph cut in half
//! at the border with nothing to say anything was dropped. So for the views
//! that hold a line to one row — where the text is `nowrap` and a recorded run
//! is one shaped line — the shaped width is read too: a run that fits was
//! truncated by the text system, which appends the ellipsis.
//!
//! Neither channel can see the third failure, because the text system
//! truncates against the space a parent hands down rather than the width a
//! child resolved to: a detail that took the entire line is clipped at the
//! row's edge and reports a contained run, while the text it was set beside
//! has been squeezed to an ellipsis. So the share each role is entitled to is
//! read as well, from a row seeded with exactly one detail.
//!
//! WHAT IT DOES NOT CATCH:
//! It bounds the horizontal direction only; a block taller than the transcript
//! is the viewport suite's subject. It says nothing about a run held inside the
//! window but outside a narrower ancestor than the block declared here. Ink
//! that matches the ground exactly — canvas-coloured text on canvas — is
//! invisible to it, and that is a contrast defect the theme suites own.
//!
//! It renders one block width, so a bound that only matters on a narrower card
//! is unproven here. That is why the fixtures seed host text rather than a
//! label a renderer authors: host text outgrows any width, while a count in a
//! sentence this codebase wrote fits every width a card is drawn at, and a
//! bound on it could neither be proven nor be needed.

use strum::IntoEnumIterator;

use crate::tool_view_containment::{
	BLOCK_W, SectionShape, ink_of,
	shares::{Detail, every_detail_beside_a_primary, runs_left_to_right},
	variants_holding, widest_shaped_run,
};

mod tool_view_containment;

#[test]
fn every_section_shape_is_swept_here() {
	let swept: Vec<&str> = SectionShape::iter().map(SectionShape::label).collect();
	assert_eq!(
		swept,
		vec!["diff", "code", "markdown", "tree", "list", "prose"],
		"the shapes render_section dispatches between are swept by this suite, and a shape removed \
		 from the sweep is a shape nothing here holds inside its block"
	);
}

#[test]
fn the_set_of_views_that_hold_a_line_to_one_row_is_pinned() {
	let declared: Vec<(&str, bool, bool)> = [false, true]
		.into_iter()
		.flat_map(|clip| {
			variants_holding(SectionShape::Prose, clip)
				.into_iter()
				.map(move |case| (case.kind, clip, case.one_line))
		})
		.collect();
	assert_eq!(
		declared,
		vec![
			("statusRow", false, true),
			("textBlock", false, true),
			("headedBlock", false, true),
			("framedBlock", false, false),
			("notice", false, false),
			("statusRow", true, true),
			("textBlock", true, true),
			("headedBlock", true, true),
			("framedBlock", true, true),
			("notice", true, false),
		],
		"the set of views that hold a line to one row changed; decide what the new set is before \
		 relaxing what is measured"
	);
}

#[test]
fn nothing_a_tool_view_draws_lands_outside_the_block_that_holds_it() {
	let mut escapes: Vec<String> = Vec::new();
	for clip in [false, true] {
		for shape in SectionShape::iter() {
			for case in variants_holding(shape, clip) {
				let label = format!("{}/{} clip={clip}", case.kind, shape.label());
				let ink = ink_of(case.view);
				assert!(ink.runs > 0, "{label}: the block drew no text at all");
				// A blank raster would make the margin check pass for the
				// wrong reason, so the block's own ink is the control: what it
				// drew has to be visible against the ground on the very frame
				// the margin is read from.
				assert!(
					ink.inside > 0,
					"{label}: the frame carries no ink inside the block, so a clean margin proves \
					 nothing"
				);
				if ink.outside > 0 {
					escapes.push(format!("{label}: {} px, out to {:.0}px", ink.outside, ink.rightmost));
				}
			}
		}
	}
	assert!(
		escapes.is_empty(),
		"a tool view painted outside the {BLOCK_W}px block that holds it, so it is drawn over \
		 whatever sits beyond the block's edge:\n  {}",
		escapes.join("\n  ")
	);
}

#[test]
fn a_line_held_to_one_row_is_shaped_to_the_block_and_marked_where_it_was_cut() {
	let mut unshaped: Vec<String> = Vec::new();
	let mut checked = 0_usize;
	for clip in [false, true] {
		for shape in SectionShape::iter() {
			for case in variants_holding(shape, clip) {
				if !case.one_line {
					continue;
				}
				checked += 1;
				let widest = widest_shaped_run(case.view);
				if widest > BLOCK_W {
					unshaped.push(format!(
						"{}/{} clip={clip}: shaped to {widest:.0}px",
						case.kind,
						shape.label()
					));
				}
			}
		}
	}
	// Every case the pinned table above declares, over both clip states and
	// all six shapes. A view that quietly stops declaring the property would
	// otherwise shrink this sweep in silence.
	assert_eq!(checked, 41, "the sweep no longer covers every one-row case the table declares");
	assert!(
		unshaped.is_empty(),
		"a line held to one row was shaped wider than the {BLOCK_W}px block, so it was masked at \
		 the block's edge instead of truncated, and it is cut mid-glyph with nothing to say it was \
		 cut:\n  {}",
		unshaped.join("\n  ")
	);
}

#[test]
fn every_place_a_detail_is_set_beside_a_primary_is_swept_here() {
	let swept: Vec<&str> = every_detail_beside_a_primary()
		.iter()
		.map(|share| share.kind)
		.collect();
	// Pinned by exact equality: a renderer that sets a new detail beside a
	// row's primary text turns this red until somebody records the share it is
	// entitled to, rather than joining a sweep that never looks at it.
	assert_eq!(
		swept,
		[
			"status row description",
			"status row badge",
			"status row language",
			"status row meta",
			"text line trailing",
		],
		"a detail was added beside a row's primary text, or one stopped being swept"
	);
}

#[test]
fn a_long_detail_does_not_take_the_line_from_the_text_it_is_set_beside() {
	let mut starved: Vec<String> = Vec::new();
	let mut greedy: Vec<String> = Vec::new();
	for Detail { kind, view, share } in every_detail_beside_a_primary() {
		// Both widths are read against the block rather than the row's content
		// box, so each is loose by the card's own padding and by the gap
		// between the two boxes. A role that lost its ceiling takes the whole
		// line and leaves the primary an ellipsis, which is several times
		// either bound, so the slack cannot hide one.
		let ceiling = share * BLOCK_W;
		// The primary is entitled to what the detail does not take. Half of
		// that is the floor, because the card's padding, the gap and the
		// shaper all come out of the primary's box and none of them is the
		// subject here.
		let floor = (1.0 - share) * BLOCK_W / 2.0;
		let runs = runs_left_to_right(view);
		let Some((primary, detail)) = runs.split_first() else {
			starved.push(format!("{kind}: the row drew no text at all"));
			continue;
		};
		if detail.is_empty() {
			starved.push(format!(
				"{kind}: the row drew one run, so only one of the two boxes was given room"
			));
			continue;
		}
		// Laid out left to right, so the leftmost run is the primary and
		// everything right of it is the detail beside it.
		if primary.width < floor {
			starved.push(format!(
				"{kind}: the primary text was shaped to {:.0}px of the {floor:.0}px it is owed",
				primary.width
			));
		}
		let held: f32 = detail.iter().map(|run| run.width).sum();
		if held > ceiling {
			greedy.push(format!("{kind}: {held:.0}px of a {ceiling:.0}px share"));
		}
	}
	assert!(
		starved.is_empty(),
		"a row's primary text was left no room by the one detail beside it, and neither the raster \
		 nor the shaped width can see it: the detail is clipped at the row's edge and looks \
		 contained:\n  {}",
		starved.join("\n  ")
	);
	assert!(
		greedy.is_empty(),
		"a detail held more of the line than §6.7 allows it:\n  {}",
		greedy.join("\n  ")
	);
}
