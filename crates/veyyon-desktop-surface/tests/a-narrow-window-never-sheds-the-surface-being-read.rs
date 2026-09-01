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
//! WHAT IT DOES NOT CATCH: whether a region that has width draws anything in
//! it, and whether the declared measures are the right ones — a judgement made
//! by looking at the rendered sheet. It says nothing about the drawer, whose
//! measure is vertical and has its own suite.

use std::collections::BTreeSet;

use veyyon_desktop_kit::{SpacingStep, TokenSet, load_bundled_tokens};
use veyyon_desktop_surface::layout::{LabelState, RightPanelPlacement, ShedInput, shell_widths};
use veyyon_desktop_tokens::{RightPanelMode, SurfaceTokens};

/// Every width the sweep visits: from well below the declared window floor to
/// well past the widest breakpoint, at a step fine enough to land on both sides
/// of every threshold.
fn swept_widths() -> Vec<f32> {
	(320..=2400).step_by(8).map(|w| w as f32).collect()
}

fn surface() -> SurfaceTokens {
	load_bundled_tokens()
		.expect("the bundled tokens load")
		.surface
}

/// The window height the width sweep holds constant: tall enough that no
/// vertical rule binds, so a width assertion is about width.
const SWEPT_HEIGHT: f32 = 900.0;

/// What the titlebar takes off the top of that height. No attention strip is
/// shown in a width sweep, so the titlebar is the whole of the chrome.
fn swept_chrome() -> f32 {
	surface().shell.titlebar_height_px
}

/// The shed's input for a width. The gutter is the session column's own inset,
/// read from the tokens rather than restated, and the previous state is the
/// default, so a sweep reads as the state a freshly opened window settles on.
fn shed(viewport_px: f32, panel_open: bool) -> ShedInput {
	let gutter_px = f32::from(TokenSet::default().spacing(SpacingStep::S4));
	ShedInput {
		viewport_px,
		viewport_height_px: SWEPT_HEIGHT,
		chrome_height_px: swept_chrome(),
		gutter_px,
		panel_open,
		labels: LabelState::default(),
	}
}

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
					widths.queue_px,
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
			widths.queue_px.unwrap_or(0.0) + widths.right_panel.inline_width() + widths.session_px;

		assert!(
			(total - width).abs() < 0.5,
			"at {width}px the columns account for {total}px: queue {:?}, inline panel {}px, session \
			 {}px",
			widths.queue_px,
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
			(widths.session_px + widths.queue_px.unwrap_or(0.0) - width).abs() < 0.5,
			"at {width}px an absent panel still cost width: session {}px, queue {:?}",
			widths.session_px,
			widths.queue_px
		);
	}
}

#[test]
fn the_queue_takes_exactly_what_the_resolved_breakpoint_declares() {
	let surface = surface();

	for width in swept_widths() {
		let declared = surface.breakpoints.resolve(width).queue_width_px;
		let resolved = shell_widths(shed(width, true), &surface).queue_px;

		if declared > 0.0 {
			assert_eq!(
				resolved,
				Some(declared),
				"at {width}px the queue took {resolved:?} against a declared {declared}px"
			);
		} else {
			// A collapsed rail is absent rather than zero-width: a zero-width
			// column still draws its edge stroke against the window frame.
			assert_eq!(resolved, None, "at {width}px a collapsed queue was still placed");
		}
	}
}

#[test]
fn a_label_survives_only_where_the_window_and_the_composer_both_allow_it() {
	let surface = surface();
	let composer = &surface.composer;

	for width in swept_widths() {
		for open in [false, true] {
			let declared = surface.breakpoints.resolve(width);
			let widths = shell_widths(shed(width, open), &surface);

			// §5.7 keys labels to the window and §5.4 keys them to the
			// composer's own measure. Neither overrides the other: a label
			// appears only where both permit it, so a docked panel sheds the
			// labels in a window whose own row would have kept them.
			assert_eq!(
				widths.labels.footer,
				declared.composer_footer_labels
					&& widths.composer_px >= composer.footer_compact_threshold_px,
				"at {width}px with panel open = {open} the footer labels disagree with the window row \
				 ({}) and the {}px composer against its {}px threshold",
				declared.composer_footer_labels,
				widths.composer_px,
				composer.footer_compact_threshold_px
			);
			assert_eq!(
				widths.labels.run_bar,
				declared.run_bar_labels && widths.composer_px >= composer.run_bar_compact_threshold_px,
				"at {width}px with panel open = {open} the run bar labels disagree with the window \
				 row ({}) and the {}px composer against its {}px threshold",
				declared.run_bar_labels,
				widths.composer_px,
				composer.run_bar_compact_threshold_px
			);
		}
	}
}

#[test]
fn a_resize_across_the_label_threshold_settles_instead_of_flickering() {
	let surface = surface();
	let composer = &surface.composer;
	let gutter = f32::from(TokenSet::default().spacing(SpacingStep::S4));
	let at = |viewport_px: f32, labels: LabelState| {
		shell_widths(
			ShedInput {
				viewport_px,
				viewport_height_px: SWEPT_HEIGHT,
				chrome_height_px: surface.shell.titlebar_height_px,
				gutter_px: gutter,
				panel_open: true,
				labels,
			},
			&surface,
		)
	};

	// The crossing is found rather than computed, so the probe follows the
	// tokens: the narrowest window a freshly opened shell labels. The panel is
	// docked, because that is what makes the composer narrower than the window
	// row's own allowance.
	let cross = swept_widths()
		.into_iter()
		.find(|&w| at(w, LabelState::default()).labels.footer)
		.expect("some swept width must label a freshly opened composer");
	let below = cross - 8.0;

	let shed_state = at(below, LabelState::default());
	assert!(
		!shed_state.labels.footer,
		"the crossing is not a crossing: {below}px already sheds nothing at a composer of {}px \
		 against a {}px threshold",
		shed_state.composer_px, composer.footer_compact_threshold_px
	);

	// Carrying the shed state back to the crossing must keep it shed: the
	// width that took the labels away is not the width that brings them back,
	// which is what stops a drag-resize on the threshold from alternating.
	let held = at(cross, shed_state.labels);
	assert!(
		!held.labels.footer,
		"a composer of {}px restored its labels at the bare threshold, inside the {}px hysteresis \
		 band",
		held.composer_px, composer.footer_hysteresis_px
	);

	// Past the band they come back, and the state is then a fixed point. The
	// probe reads both factors, because a wide composer is not enough: a
	// collapsed window has no queue and overlays its panel, so its composer is
	// wider than a docked standard window's while its row sheds the labels
	// anyway. A probe on the composer alone lands on such a width and asserts a
	// restore the shed is right to refuse.
	let restore_px = composer.footer_compact_threshold_px + composer.footer_hysteresis_px;
	let past = swept_widths()
		.into_iter()
		.find(|&w| {
			surface.breakpoints.resolve(w).composer_footer_labels
				&& at(w, LabelState::default()).composer_px >= restore_px
		})
		.expect("a swept width must clear the band in a row that labels");
	let restored = at(past, held.labels);
	assert!(
		restored.labels.footer,
		"a composer of {}px never restored its labels past the {}px hysteresis band",
		restored.composer_px, composer.footer_hysteresis_px
	);
	assert_eq!(
		at(past, restored.labels).labels,
		restored.labels,
		"the label state at a fixed width is not a fixed point, so a resize can flicker"
	);
}

#[test]
fn every_declared_breakpoint_is_reached_and_every_panel_mode_is_placed() {
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
	}

	assert_eq!(
		reached, declared,
		"the sweep never resolved to every declared breakpoint, so some row is unproven"
	);
	assert!(placed_inline, "no swept width declared an inline panel");
	assert!(placed_overlay, "no swept width declared an overlay panel");
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
			widths.queue_px.is_none_or(|q| q.is_finite() && q >= 0.0),
			"a {width} window produced a queue of {:?}",
			widths.queue_px
		);
		assert!(
			widths.drawer.height_px.is_finite() && widths.drawer.height_px > 0.0,
			"a {width} window produced a drawer of {}px",
			widths.drawer.height_px
		);
	}
}
