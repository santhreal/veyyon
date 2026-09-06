//! WHY: Layout transitions in the queue rail must animate smoothly with FLIP
//! shifts rather than jumping abruptly, while maintaining visual continuity
//! during mid-flight interruptions and obeying reduced motion settings.
//!
//! The defect classes closed here are:
//! 1. A row changing positions jumping instantly without a FLIP shift
//!    transition.
//! 2. An animation failing to settle to zero offset within the declared
//!    duration.
//! 3. An interrupted animation restarting from zero rather than continuing
//!    smoothly from its current position and velocity.
//! 4. Reduced motion settings failing to resolve to zero duration.
//! 5. The rail footer settings gear missing or failing to dispatch settings
//!    overlay intent.
//! 6. Height budgeting failing to subtract the footer height upfront.

use std::{
	collections::HashMap,
	path::Path,
	time::{Duration, Instant},
};

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	Overlay, Row, Section, SettingsState, ShellView, fixture, install_tokens,
	queue::{RailMotion, rail_fill},
};
use veyyon_gpui::{App, AppContext, Point};
fn options() -> RenderOptions {
	RenderOptions { width: 1440, height: 900, scale_factor: 1.0, ..RenderOptions::default() }
}

#[test]
fn a_row_that_changes_position_yields_a_nonzero_shift_offset_on_first_frame_and_settles_monotonically()
 {
	let mut motion = RailMotion::new();
	let t0 = Instant::now();

	let mut pos_initial = HashMap::new();
	pos_initial.insert(1, 0.0);
	pos_initial.insert(2, 78.0);
	motion.record_positions(&pos_initial, t0);

	// Initial render: no prior movement, offset is zero.
	assert_eq!(motion.shift_offset(1, t0), 0.0);

	// At t1, row 1 moves to y = 78.0 (position changed by 78px).
	let t1 = t0 + Duration::from_secs(1);
	let mut pos_moved = HashMap::new();
	pos_moved.insert(1, 78.0);
	pos_moved.insert(2, 156.0);
	motion.record_positions(&pos_moved, t1);

	// (a) First frame yields non-zero shift offset.
	let first_frame_offset = motion.shift_offset(1, t1);
	assert_eq!(
		first_frame_offset, -78.0,
		"first frame after position change must yield delta offset"
	);

	// Monotonicity assertion over the 200ms FLIP transition.
	let sample_steps = [20, 50, 80, 120, 160, 200];
	let mut prev_magnitude = first_frame_offset.abs();

	for &step_ms in &sample_steps {
		let sample_time = t1 + Duration::from_millis(step_ms);
		let offset = motion.shift_offset(1, sample_time);
		let magnitude = offset.abs();

		assert!(
			magnitude <= prev_magnitude + 0.001,
			"FLIP shift magnitude must decrease monotonically, at {step_ms}ms got {magnitude} > \
			 {prev_magnitude}"
		);
		prev_magnitude = magnitude;
	}

	// (a) Settles to exactly 0.0 once FLIP duration (200ms) has elapsed.
	let t_complete = t1 + Duration::from_millis(200);
	assert_eq!(
		motion.shift_offset(1, t_complete),
		0.0,
		"shift offset must reach exactly 0.0 at duration boundary"
	);

	let t_after = t1 + Duration::from_millis(300);
	assert_eq!(
		motion.shift_offset(1, t_after),
		0.0,
		"shift offset must remain 0.0 past duration boundary"
	);
	assert!(
		!motion.has_active_animations(t_complete),
		"animation must terminate within 200ms bound"
	);
}

#[test]
fn an_interruption_at_forty_percent_continues_from_the_current_value_and_settles_within_bound() {
	let mut motion = RailMotion::new();
	let t0 = Instant::now();

	let mut pos_initial = HashMap::new();
	pos_initial.insert(10, 0.0);
	motion.record_positions(&pos_initial, t0);

	// Start moving to y = 100.0 at t1 (total duration 200ms).
	let t1 = t0 + Duration::from_secs(1);
	let mut pos_move1 = HashMap::new();
	pos_move1.insert(10, 100.0);
	motion.record_positions(&pos_move1, t1);

	// Interrupt at t = 40% of 200ms = 80ms.
	let t_interrupt = t1 + Duration::from_millis(80);
	let pre_interrupt_offset = motion.shift_offset(10, t_interrupt);
	let pre_interrupt_visual_y = 100.0 + pre_interrupt_offset;

	// New position at interruption instant: row moves to y = 200.0.
	let mut pos_move2 = HashMap::new();
	pos_move2.insert(10, 200.0);
	motion.record_positions(&pos_move2, t_interrupt);

	// (b) Assert visual position immediately after interruption equals
	// pre-interruption value.
	let post_interrupt_offset = motion.shift_offset(10, t_interrupt);
	let post_interrupt_visual_y = 200.0 + post_interrupt_offset;

	assert!(
		(post_interrupt_visual_y - pre_interrupt_visual_y).abs() < 0.001,
		"interrupted animation must continue from current visual position ({pre_interrupt_visual_y} \
		 vs {post_interrupt_visual_y})"
	);

	// (b) Assert the animation still settles within the 200ms bound from
	// interruption.
	let t_final_complete = t_interrupt + Duration::from_millis(200);
	assert_eq!(
		motion.shift_offset(10, t_final_complete),
		0.0,
		"interrupted animation must settle to zero offset within duration bound"
	);
	assert!(
		!motion.has_active_animations(t_final_complete),
		"interrupted animation must terminate by bound"
	);
}

#[test]
fn reduced_motion_yields_zero_offset_on_the_first_frame() {
	let mut motion = RailMotion::new();
	motion.set_reduced_motion(true);

	let t0 = Instant::now();
	let mut pos_initial = HashMap::new();
	pos_initial.insert(42, 0.0);
	motion.record_positions(&pos_initial, t0);

	let t1 = t0 + Duration::from_secs(1);
	let mut pos_moved = HashMap::new();
	pos_moved.insert(42, 100.0);
	motion.record_positions(&pos_moved, t1);

	// (c) Reduced motion resolves to 0ms instant transition, zero offset on first
	// frame.
	assert_eq!(
		motion.shift_offset(42, t1),
		0.0,
		"reduced motion must yield zero offset on first frame without animating"
	);
	assert!(!motion.has_active_animations(t1), "reduced motion must leave no active animations");
}

#[test]
fn the_gear_is_present_in_the_rail_and_dispatches_the_settings_overlay_intent() {
	let mut cx = headless_context().expect("headless renderer is required");
	let tokens = load_bundled_tokens().expect("bundled tokens load");
	let theme = load_bundled_theme("dark").expect("bundled dark theme loads");

	let state = fixture::populated();

	let mut session = HeadlessSession::open(&mut cx, &options(), move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		let view = ShellView::new(installed, state);
		app.new(|_| view)
	})
	.expect("session opens offscreen");

	let frame = session.frame().expect("shell renders frame");

	let gear_hitbox = frame
		.hitboxes
		.iter()
		.find(|rect| {
			let x = f32::from(rect.origin.x);
			let y = f32::from(rect.origin.y);
			let w = f32::from(rect.size.width);
			let h = f32::from(rect.size.height);
			x < 60.0 && y > 840.0 && w <= 40.0 && h <= 40.0 && w > 10.0 && h > 10.0
		})
		.copied()
		.expect("settings gear hitbox must exist in the rail footer");

	let click_point = Point {
		x: gear_hitbox.origin.x + gear_hitbox.size.width / 2.0,
		y: gear_hitbox.origin.y + gear_hitbox.size.height / 2.0,
	};

	session
		.click(click_point)
		.expect("click dispatches to settings gear");

	// (d) Assert that clicking the gear opened the settings overlay.
	session
		.update(|view, _window, _cx| {
			assert!(
				matches!(
					&view.state().overlay,
					Some(Overlay::Settings(boxed)) if **boxed == SettingsState::default()
				),
				"clicking settings gear must open the Settings overlay, got: {:?}",
				view.state().overlay
			);
		})
		.expect("overlay state verified");
}

#[test]
fn rail_fill_subtracts_the_footer_height_so_higher_footer_fits_fewer_rows() {
	let tokens = load_bundled_tokens().expect("bundled tokens load");
	let mut queue_geom = tokens.surface.queue;

	let sections = vec![(
		Section::Live,
		(0..10)
			.map(|i| Row {
				id:       i,
				title:    format!("session {i}"),
				subtitle: "sub".to_string(),
				badge:    None,
				meta:     None,
			})
			.collect::<Vec<_>>(),
	)];

	let rail_height = 400.0;

	// (e) Measure drawn rows with footer height = 0.
	queue_geom.footer_height_px = 0.0;
	let fill_without_footer = rail_fill(&sections, rail_height, &queue_geom);
	let rows_without_footer: usize = fill_without_footer.drawn.iter().sum();

	// (e) Measure drawn rows with standard 36px footer.
	queue_geom.footer_height_px = 36.0;
	let fill_with_standard_footer = rail_fill(&sections, rail_height, &queue_geom);
	let rows_with_standard_footer: usize = fill_with_standard_footer.drawn.iter().sum();

	// (e) Measure drawn rows with expanded 120px footer.
	queue_geom.footer_height_px = 120.0;
	let fill_with_large_footer = rail_fill(&sections, rail_height, &queue_geom);
	let rows_with_large_footer: usize = fill_with_large_footer.drawn.iter().sum();

	assert!(
		rows_with_standard_footer <= rows_without_footer,
		"rail with footer must fit fewer or equal rows ({rows_with_standard_footer} vs \
		 {rows_without_footer})"
	);
	assert!(
		rows_with_large_footer < rows_without_footer,
		"rail with large footer must fit strictly fewer rows ({rows_with_large_footer} vs \
		 {rows_without_footer})"
	);
	assert!(
		fill_with_standard_footer.hidden > fill_without_footer.hidden,
		"hidden rows must increase when footer takes vertical budget"
	);
}
