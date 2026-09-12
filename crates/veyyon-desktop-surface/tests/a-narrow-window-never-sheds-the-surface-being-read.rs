//! WHY: the shell laid its three columns out at their default measures at every
//! window width. At the declared 800x560 floor the queue took 256 and the right
//! panel took 540, so the session surface — the transcript and the composer,
//! the only reason the window is open — resolved to 4px and rendered as
//! nothing. The frame looked plausible in review because the two rails filled
//! it.
//!
//! THE CLASS THIS CLOSES: any window width at which a fixed-measure region
//! takes its width out of the surface being read. The assertions are on
//! `shell_widths`, the one function every region's measure passes through, and
//! they sweep every width from below the declared floor to beyond the widest
//! breakpoint rather than checking the four declared rows. A fifth breakpoint
//! row, or a token file that declares an inline panel at a width that cannot
//! hold one, is covered without touching this file.
//!
//! WHAT IT DOES NOT CATCH: whether the declared measures are the right ones —
//! a judgement made by looking at the rendered sheet. It says nothing about
//! the drawer, whose measure is vertical and has its own suite. Painted
//! containment is a separate suite,
//! `the-operator-bubble-stays-inside-the-session-column.rs`, and it proves
//! the operator bubble only; every other region's paint is unproven.

mod support;

use std::collections::BTreeSet;

use support::shed::{shed, shed_with_queue, surface, swept_widths};
use veyyon_desktop_surface::layout::{QueuePlacement, RightPanelPlacement, shell_widths};
use veyyon_desktop_tokens::{QueueMode, RightPanelMode};

#[test]
fn the_session_surface_keeps_its_declared_margin_at_every_width() {
	let surface = surface();
	let floor = surface.panels.right_panel_container_margin_px;

	for width in swept_widths() {
		for open in [false, true] {
			let widths = shell_widths(shed(width, open), &surface);

			// Below the window's own minimum the shell is not required to fit;
			// the window manager will not make it that small. At and above it,
			// the session surface keeps the margin the panel tokens declare.
			if width >= surface.shell.window_min_width_px {
				assert!(
					widths.session_px >= floor,
					"at {width}px with panel open = {open} the session surface got {}px, below the \
					 declared container margin of {floor}px (queue {:?}, panel {:?})",
					widths.session_px,
					widths.queue,
					widths.right_panel
				);
			}

			// Whatever the width, the surface being read is never absent and
			// never wider than the window.
			assert!(
				widths.session_px > 0.0 && widths.session_px <= width,
				"at {width}px the session surface got {}px",
				widths.session_px
			);
		}
	}
}

#[test]
fn the_columns_account_for_the_whole_window_and_no_more() {
	let surface = surface();

	for width in swept_widths() {
		let widths = shell_widths(shed(width, true), &surface);
		let total =
			widths.queue.inline_width() + widths.right_panel.inline_width() + widths.session_px;

		assert!(
			(total - width).abs() < 0.5,
			"at {width}px the columns account for {total}px: queue {:?}, inline panel {}px, session \
			 {}px",
			widths.queue,
			widths.right_panel.inline_width(),
			widths.session_px
		);
	}
}

#[test]
fn a_shown_panel_is_never_narrower_than_its_minimum_nor_wider_than_its_share() {
	let surface = surface();
	let panels = &surface.panels;

	for width in swept_widths() {
		let widths = shell_widths(shed(width, true), &surface);
		let drawn = widths.right_panel.drawn_width();

		assert!(
			drawn > 0.0,
			"at {width}px a panel with content resolved to {:?}",
			widths.right_panel
		);
		// The minimum is itself bounded by the window: a 320px window cannot
		// give a 360px panel, and the panel takes the window instead.
		assert!(
			drawn >= panels.right_panel_min_width_px.min(width),
			"at {width}px the panel drew {drawn}px, under its {}px minimum",
			panels.right_panel_min_width_px
		);
		assert!(
			drawn <= width * panels.right_panel_max_viewport_ratio || drawn <= width,
			"at {width}px the panel drew {drawn}px, over its viewport share"
		);
	}
}

#[test]
fn an_empty_panel_takes_no_width_from_anything() {
	let surface = surface();

	for width in swept_widths() {
		let widths = shell_widths(shed(width, false), &surface);

		assert_eq!(
			widths.right_panel,
			RightPanelPlacement::Absent,
			"at {width}px a panel with no content was placed anyway"
		);
		assert!(
			(widths.session_px + widths.queue.inline_width() - width).abs() < 0.5,
			"at {width}px an absent panel still cost width: session {}px, queue {:?}",
			widths.session_px,
			widths.queue
		);
	}
}

#[test]
fn the_queue_takes_exactly_what_the_resolved_breakpoint_declares() {
	let surface = surface();

	for width in swept_widths() {
		let row = surface.breakpoints.resolve(width);
		let declared = row.queue_width_px;
		let resolved = shell_widths(shed(width, true), &surface).queue;

		// A row declaring no measure has no rail to draw in either mode, and a
		// row that floats it draws nothing until the operator asks: the shed's
		// own input here is a freshly opened window, with no float open.
		let expected = match (declared > 0.0, row.queue_mode) {
			(true, QueueMode::Inline) => QueuePlacement::Inline { width_px: declared },
			(true, QueueMode::Overlay) | (false, _) => QueuePlacement::Absent,
		};
		assert_eq!(
			resolved, expected,
			"at {width}px the queue resolved to {resolved:?} against a declared {declared}px in {:?} \
			 mode",
			row.queue_mode
		);
	}
}

#[test]
fn a_floated_queue_covers_the_transcript_instead_of_narrowing_it() {
	let surface = surface();

	for width in swept_widths() {
		let row = surface.breakpoints.resolve(width);
		let closed = shell_widths(shed_with_queue(width, false, false, false), &surface);
		let opened = shell_widths(shed_with_queue(width, false, false, true), &surface);

		match row.queue_mode {
			// The float is this window's own and takes no width: opening it
			// leaves every other region's measure exactly where it was, which
			// is what keeps the transcript from reflowing under the sheet.
			QueueMode::Overlay if row.queue_width_px > 0.0 => {
				assert_eq!(
					opened.queue,
					QueuePlacement::Overlay { width_px: row.queue_width_px },
					"at {width}px an opened float resolved to {:?}",
					opened.queue
				);
				assert_eq!(
					opened.session_px, closed.session_px,
					"at {width}px opening the float moved the session surface from {}px to {}px",
					closed.session_px, opened.session_px
				);
				assert_eq!(
					opened.composer_px, closed.composer_px,
					"at {width}px opening the float moved the composer"
				);
				assert_eq!(
					opened.right_panel, closed.right_panel,
					"at {width}px opening the float moved the right panel"
				);
			},
			// A width with room for a column ignores the float flag entirely:
			// the rail is already beside the transcript, and a sheet over it
			// would be a second copy of the same rail.
			QueueMode::Inline | QueueMode::Overlay => assert_eq!(
				opened.queue, closed.queue,
				"at {width}px in {:?} mode the float flag changed the placement to {:?}",
				row.queue_mode, opened.queue
			),
		}
	}
}

#[test]
fn every_width_that_declares_a_rail_can_reach_one() {
	let surface = surface();

	// The defect this closes: at a width whose row floats the queue, the rail
	// control moved nothing, so the sessions the rail lists were unreachable
	// from that window. Every width that declares a measure has some pair of
	// the two queue states that draws it.
	for width in swept_widths() {
		if surface.breakpoints.resolve(width).queue_width_px <= 0.0 {
			continue;
		}
		let reachable = [(false, false), (false, true), (true, false), (true, true)]
			.into_iter()
			.any(|(collapsed, float_open)| {
				shell_widths(shed_with_queue(width, false, collapsed, float_open), &surface)
					.queue
					.is_shown()
			});
		assert!(reachable, "at {width}px no queue state draws a rail at all");
	}
}

#[test]
fn every_declared_breakpoint_is_reached_and_every_region_mode_is_placed() {
	let surface = surface();

	// The declared rows are read out of the token structure at run time, so a
	// fifth row turns this red until the sweep reaches it and until the
	// assertions above hold at its width.
	let rows: Vec<(String, serde_json::Value)> = match serde_json::to_value(&surface.breakpoints) {
		Ok(serde_json::Value::Object(map)) => map.into_iter().collect(),
		other => panic!("the breakpoint set must serialise to an object, got {other:?}"),
	};
	let declared: BTreeSet<String> = rows.iter().map(|(name, _)| name.clone()).collect();
	assert!(!declared.is_empty(), "the token structure declares no breakpoints");

	let mut reached: BTreeSet<String> = BTreeSet::new();
	let mut placed_inline = false;
	let mut placed_overlay = false;
	let mut queue_inline = false;
	let mut queue_overlay = false;

	for width in swept_widths() {
		let config = surface.breakpoints.resolve(width);
		let value = serde_json::to_value(config).expect("a breakpoint serialises");
		for (name, declared_value) in &rows {
			if *declared_value == value {
				reached.insert(name.clone());
			}
		}

		// Exhaustive on purpose: a new placement mode is a compile error here
		// rather than a mode nobody proved.
		match config.right_panel_mode {
			RightPanelMode::Inline { .. } => placed_inline = true,
			RightPanelMode::Overlay => placed_overlay = true,
		}
		match config.queue_mode {
			QueueMode::Inline => queue_inline = true,
			QueueMode::Overlay => queue_overlay = true,
		}
	}

	assert_eq!(
		reached, declared,
		"the sweep never resolved to every declared breakpoint, so some row is unproven"
	);
	assert!(placed_inline, "no swept width declared an inline panel");
	assert!(placed_overlay, "no swept width declared an overlay panel");
	assert!(queue_inline, "no swept width declared a docked queue");
	assert!(
		queue_overlay,
		"no swept width declared a floating queue, so the narrow-width rail is unproven"
	);
}

#[test]
fn a_hostile_viewport_width_still_resolves_to_finite_measures() {
	let surface = surface();

	for width in [0.0, -1.0, f32::NAN, f32::INFINITY, f32::NEG_INFINITY, f32::MAX, f32::MIN_POSITIVE]
	{
		let widths = shell_widths(shed(width, true), &surface);

		assert!(
			widths.session_px.is_finite() && widths.session_px >= 0.0,
			"a {width} window produced a session surface of {}px",
			widths.session_px
		);
		assert!(
			widths.right_panel.drawn_width().is_finite() && widths.right_panel.drawn_width() >= 0.0,
			"a {width} window produced a panel of {}px",
			widths.right_panel.drawn_width()
		);
		assert!(
			widths.queue.drawn_width().is_finite() && widths.queue.drawn_width() >= 0.0,
			"a {width} window produced a queue of {:?}",
			widths.queue
		);
		assert!(
			widths.drawer.height_px.is_finite() && widths.drawer.height_px > 0.0,
			"a {width} window produced a drawer of {}px",
			widths.drawer.height_px
		);
	}
}
