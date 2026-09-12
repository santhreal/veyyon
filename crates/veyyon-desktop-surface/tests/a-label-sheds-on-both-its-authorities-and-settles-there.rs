//! WHY: the footer and the run bar shed their labels on two authorities at
//! once. §5.7 keys them to the window row and §5.4 keys them to the composer's
//! own measure, and a reading that took either alone labelled a control the
//! other had already shortened. A bare threshold with no hysteresis then let a
//! drag-resize sitting on the crossing alternate between the two states for
//! every pixel of travel.
//!
//! THE CLASS THIS CLOSES: any label whose state disagrees with the conjunction
//! of its window row and its composer measure, and any threshold a resize can
//! oscillate across. The assertions sweep every width from below the declared
//! floor to past the widest breakpoint, and the crossing is found from the
//! tokens rather than named here, so a retuned threshold or a fifth breakpoint
//! row is covered without an edit.
//!
//! WHAT IT DOES NOT CATCH: whether the authored thresholds are the right ones,
//! which is a judgement about a rendered row, and what a shed label draws
//! instead, which the control's own suite asserts.

mod support;

use support::shed::{SWEPT_HEIGHT, shed, surface, swept_widths};
use veyyon_desktop_kit::{SpacingStep, TokenSet};
use veyyon_desktop_surface::layout::{LabelState, ShedInput, shell_widths};

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
				queue_collapsed: false,
				queue_float_open: false,
				panel_open: true,
				panel_width: None,
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
