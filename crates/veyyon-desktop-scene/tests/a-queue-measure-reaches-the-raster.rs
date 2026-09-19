//! WHY: queue tokens author the rail's widths, insets, row heights, card
//! layout, footer metrics and pagination limits, and the loader validates their
//! syntax. Nothing verified that each measure affects the rendered frame: a
//! renderer could ignore a token or paint with a compiled-in literal, leaving
//! an authored dimension inert on the screen.
//!
//! THE CLASS THIS CLOSES: a queue token that is authored, loaded and never
//! alters the rendered rail. Every numeric measure under the surface.queue
//! group is enumerated from the loaded token value at run time through serde,
//! doubled and offset one at a time against a probe rendering the shell across
//! the rail's layout states. A measure that leaves every seeded frame identical
//! fails by name, and a measure added to queue.toml arrives in the sweep with
//! no edits here.
//!
//! WHAT IT DOES NOT CATCH: whether the queue rail is pleasant to read, whether
//! the colours contrast adequately, or whether the interactive transitions
//! feel smooth. The sweep proves that every authored dimension reaches the
//! raster, not that the design choices satisfy an aesthetic goal.

mod dead_token_probe;
mod queue_probe;

use dead_token_probe::assert_every_measure_is_drawn;
use veyyon_desktop_surface::layout::{LabelState, QueuePlacement, ShedInput, shell_widths};
use veyyon_desktop_tokens::load_bundled_tokens;

#[test]
fn every_queue_measure_reaches_the_raster() {
	assert_every_measure_is_drawn("surface.queue", queue_probe::observations);
}

#[test]
fn card_geometry_composition_equals_card_px() {
	let tokens = load_bundled_tokens().expect("bundled tokens must load");
	let q = &tokens.surface.queue;
	let composed = q.card_padding_top
		+ q.card_badge_height
		+ q.card_header_gap
		+ q.card_title_height
		+ q.card_body_gap
		+ q.card_subtitle_height
		+ q.card_padding_bottom;
	assert_eq!(
		composed, q.card_px,
		"composed card height ({composed}) must equal card_px ({})",
		q.card_px
	);
}

#[test]
fn queue_rail_width_clamped_at_each_end() {
	let tokens = load_bundled_tokens().expect("bundled tokens must load");
	let surface = &tokens.surface;
	let q = &surface.queue;

	// Low end: dragged width 100px clamped to width_min_px (208px).
	let low_end = shell_widths(
		ShedInput {
			viewport_px:        1600.0,
			viewport_height_px: 1000.0,
			chrome_height_px:   surface.shell.titlebar_height_px,
			gutter_px:          8.0,
			queue_collapsed:    false,
			queue_float_open:   false,
			queue_width:        Some(100.0),
			panel_open:         false,
			panel_width:        None,
			labels:             LabelState::default(),
		},
		surface,
	);
	assert_eq!(low_end.queue.drawn_width(), q.width_min_px);

	// High end on wide window (1600px): clamped to viewport -
	// width_max_viewport_delta_px (1600 - 640 = 960px).
	let high_wide = shell_widths(
		ShedInput {
			viewport_px:        1600.0,
			viewport_height_px: 1000.0,
			chrome_height_px:   surface.shell.titlebar_height_px,
			gutter_px:          8.0,
			queue_collapsed:    false,
			queue_float_open:   false,
			queue_width:        Some(2000.0),
			panel_open:         false,
			panel_width:        None,
			labels:             LabelState::default(),
		},
		surface,
	);
	assert_eq!(high_wide.queue.drawn_width(), 1600.0 - q.width_max_viewport_delta_px);

	// High end on narrow window (800px): 800 - 640 = 160 < 208, clamped to
	// width_floor_max_px (208px).
	let high_narrow = shell_widths(
		ShedInput {
			viewport_px:        800.0,
			viewport_height_px: 1000.0,
			chrome_height_px:   surface.shell.titlebar_height_px,
			gutter_px:          8.0,
			queue_collapsed:    false,
			queue_float_open:   true,
			queue_width:        Some(2000.0),
			panel_open:         false,
			panel_width:        None,
			labels:             LabelState::default(),
		},
		surface,
	);
	assert_eq!(high_narrow.queue.drawn_width(), q.width_floor_max_px);
}

#[test]
fn queue_collapsed_takes_no_column() {
	let tokens = load_bundled_tokens().expect("bundled tokens must load");
	let surface = &tokens.surface;

	let collapsed = shell_widths(
		ShedInput {
			viewport_px:        1600.0,
			viewport_height_px: 1000.0,
			chrome_height_px:   surface.shell.titlebar_height_px,
			gutter_px:          8.0,
			queue_collapsed:    true,
			queue_float_open:   false,
			queue_width:        Some(2000.0),
			panel_open:         false,
			panel_width:        None,
			labels:             LabelState::default(),
		},
		surface,
	);
	// A width the operator dragged the rail to does not bring a collapsed
	// rail back: a column of its own is what collapsing took away.
	assert_eq!(collapsed.queue, QueuePlacement::Absent);
	assert_eq!(collapsed.queue.drawn_width(), 0.0);
	assert_eq!(collapsed.queue.inline_width(), 0.0);
}

#[test]
fn untouched_queue_rail_draws_breakpoint_width() {
	let tokens = load_bundled_tokens().expect("bundled tokens must load");
	let surface = &tokens.surface;

	// Untouched wide window draws wide breakpoint width (256px).
	let wide_untouched = shell_widths(
		ShedInput {
			viewport_px:        1600.0,
			viewport_height_px: 1000.0,
			chrome_height_px:   surface.shell.titlebar_height_px,
			gutter_px:          8.0,
			queue_collapsed:    false,
			queue_float_open:   false,
			queue_width:        None,
			panel_open:         false,
			panel_width:        None,
			labels:             LabelState::default(),
		},
		surface,
	);
	assert_eq!(wide_untouched.queue.drawn_width(), surface.breakpoints.wide.queue_width_px as f32);

	// Untouched compact window draws compact breakpoint width (208px).
	let compact_untouched = shell_widths(
		ShedInput {
			viewport_px:        980.0,
			viewport_height_px: 1000.0,
			chrome_height_px:   surface.shell.titlebar_height_px,
			gutter_px:          8.0,
			queue_collapsed:    false,
			queue_float_open:   false,
			queue_width:        None,
			panel_open:         false,
			panel_width:        None,
			labels:             LabelState::default(),
		},
		surface,
	);
	assert_eq!(
		compact_untouched.queue.drawn_width(),
		surface.breakpoints.compact.queue_width_px as f32
	);
}
