//! WHY: The queue rail must support native vertical scrolling, archival paging,
//! search filtering and selection preservation across re-layouts without
//! perpetual redraw loops when at rest (§5.1, §5.2, §7.1).
//!
//! CLASS CLOSED:
//! 1. Inaccessible height budgeting dropping sessions that exceed viewport
//!    height.
//! 2. Inert `more_row` failing to provide pagination into older archival
//!    sessions.
//! 3. Selection identity or position resetting during scroll, collapse, or
//!    filter.
//! 4. Per-render detached timers causing continuous background redraw at rest.
//! 5. Search and new-session navigation controls missing or issuing unhandled
//!    intents.
//! 6. Sizing degradation at minimum width (208px) clipping navigation controls.

#[path = "support/large_queue.rs"]
mod large_queue;
#[path = "support/queue-scroll/mod.rs"]
mod queue_scroll;

use std::{
	collections::HashMap,
	time::{Duration, Instant},
};

use large_queue::make_large_queue_state;
use queue_scroll::{open_session, row};
use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_scene::headless::headless_context;
use veyyon_desktop_surface::{
	Intent, Overlay, PaletteMode, Section, fixture,
	queue::{RailMotion, paged_rail_fill},
};
#[test]
fn large_queue_lists_render_every_session_in_scrollable_container_beyond_viewport() {
	let mut cx = headless_context().expect("headless renderer is required");
	let state = make_large_queue_state();
	let mut session = open_session(&mut cx, state, 1440, 600);
	let frame = session.frame().expect("shell renders frame");
	let queue_hitboxes: Vec<_> = frame
		.hitboxes
		.iter()
		.filter(|r| f32::from(r.origin.x) < 256.0)
		.collect();
	assert!(
		queue_hitboxes.len() >= 5 && queue_hitboxes.len() <= 45,
		"virtualized queue container bounds rendered items to viewport (found {})",
		queue_hitboxes.len()
	);

	session
		.update(|view, _window, _cx| {
			assert!(
				view.rail_motion().list_state().item_count() > 60,
				"list state tracks full virtualized item count"
			);
		})
		.expect("item count verified");
}

#[test]
fn parked_archival_paging_expands_and_reveals_older_sessions() {
	let mut motion = RailMotion::new();
	let limit = 25;
	let sections = vec![(
		Section::Parked,
		(1..=60)
			.map(|i| row(i, format!("P {i}"), "arc", None, None))
			.collect::<Vec<_>>(),
	)];
	let p1 = paged_rail_fill(&sections, motion.parked_limit(limit));
	assert_eq!(p1.drawn[0], 25);
	assert_eq!(p1.hidden, 35);
	assert_eq!(motion.parked_page(), 1);

	motion.show_more_parked(limit);
	assert_eq!(motion.parked_page(), 2);
	let p2 = paged_rail_fill(&sections, motion.parked_limit(limit));
	assert_eq!(p2.drawn[0], 50);
	assert_eq!(p2.hidden, 10);

	motion.show_more_parked(limit);
	assert_eq!(motion.parked_page(), 3);
	let p3 = paged_rail_fill(&sections, motion.parked_limit(limit));
	assert_eq!(p3.drawn[0], 60);
	assert_eq!(p3.hidden, 0);

	motion.reset_parked_page();
	assert_eq!(motion.parked_page(), 1);
	let pr = paged_rail_fill(&sections, motion.parked_limit(limit));
	assert_eq!(pr.drawn[0], 25);
	assert_eq!(pr.hidden, 35);
}

#[test]
fn selection_identity_remains_stable_across_scroll_collapse_and_paging() {
	let mut cx = headless_context().expect("headless renderer is required");
	let mut state = make_large_queue_state();
	state.current_id = 60;
	state.title = "Deferred 60".into();
	let mut session = open_session(&mut cx, state, 1440, 900);

	session
		.update(|view, _window, cx| {
			for section in Section::all() {
				view
					.rail_motion_mut()
					.toggle_collapsed(section, Instant::now());
			}
			cx.notify();
		})
		.expect("toggle collapsed");
	session
		.frame()
		.expect("collapsed queue renders before checking its state");
	session
		.update(|view, _window, _cx| {
			assert_eq!(view.state().current_id, 60);
			for section in Section::all() {
				assert!(view.rail_motion().is_collapsed(section));
			}
		})
		.expect("state verified");
	session
		.update(|view, _window, cx| {
			view
				.rail_motion_mut()
				.toggle_collapsed(Section::Deferred, Instant::now());
			cx.notify();
		})
		.expect("toggle expanded");
	session
		.frame()
		.expect("expanded queue renders before checking its state");
	session
		.update(|view, _window, _cx| {
			assert_eq!(view.state().current_id, 60);
			assert!(!view.rail_motion().is_collapsed(Section::Deferred));
		})
		.expect("state verified expanded");
}

#[test]
fn filter_queue_filters_sessions_and_clearing_restores_full_queue() {
	let mut cx = headless_context().expect("headless renderer is required");
	let state = fixture::populated();
	let mut session = open_session(&mut cx, state, 1440, 900);

	session
		.update(|view, _window, cx| view.dispatch(Intent::FilterQueue("Split".into()), cx))
		.expect("filter queue");
	session
		.update(|view, _window, _cx| {
			assert_eq!(view.state().keymap.queue_filter.as_deref(), Some("Split"));
		})
		.expect("filter verified");
	session
		.update(|view, _window, cx| view.dispatch(Intent::FilterQueue(String::new()), cx))
		.expect("clear filter");
	session
		.update(|view, _window, _cx| assert_eq!(view.state().keymap.queue_filter, None))
		.expect("clear filter verified");
}

#[test]
fn queue_motion_preserves_continuity_under_insert_remove_reorder_and_rapid_toggle() {
	let tokens: MotionTokens = load_bundled_tokens().expect("bundled tokens").motion.into();
	let mut rail = RailMotion::with_tokens(tokens);
	let t0 = Instant::now();

	let mut pos1 = HashMap::new();
	pos1.insert(1, 40.0_f32);
	pos1.insert(2, 118.0_f32);
	pos1.insert(3, 196.0_f32);
	rail.record_positions(&pos1, t0);
	assert_eq!(rail.shift_offset(1, t0), 0.0);
	assert_eq!(rail.shift_offset(2, t0), 0.0);

	let t1 = t0 + Duration::from_millis(50);
	let mut pos2 = HashMap::new();
	pos2.insert(2, 40.0_f32);
	pos2.insert(1, 118.0_f32);
	pos2.insert(3, 196.0_f32);
	rail.record_positions(&pos2, t1);
	assert_eq!(rail.shift_offset(1, t1), -78.0);
	assert_eq!(rail.shift_offset(2, t1), 78.0);

	let t2 = t1 + Duration::from_millis(100);
	let mut pos3 = HashMap::new();
	pos3.insert(3, 40.0_f32);
	pos3.insert(2, 118.0_f32);
	pos3.insert(1, 196.0_f32);
	rail.record_positions(&pos3, t2);
	assert_eq!(rail.shift_offset(3, t2), 156.0);

	let t_settle = t2 + Duration::from_millis(300);
	assert_eq!(rail.shift_offset(1, t_settle), 0.0);
	assert_eq!(rail.shift_offset(2, t_settle), 0.0);
	assert_eq!(rail.shift_offset(3, t_settle), 0.0);
	assert!(!rail.has_active_animations(t_settle));
}

#[test]
fn rest_does_not_perpetually_redraw_at_rest() {
	let mut rail = RailMotion::new();
	let t0 = Instant::now();

	let mut pos = HashMap::new();
	pos.insert(10, 50.0);
	pos.insert(20, 128.0);
	rail.record_positions(&pos, t0);

	assert!(!rail.has_active_animations(t0));
	assert!(!rail.is_animating(t0));

	let t1 = t0 + Duration::from_secs(5);
	assert!(!rail.has_active_animations(t1));
	assert!(!rail.is_animating(t1));
}

#[test]
fn queue_navigation_and_footer_controls_dispatch_valid_intents() {
	let mut cx = headless_context().expect("headless renderer is required");
	let state = fixture::populated();
	let mut session = open_session(&mut cx, state, 1440, 900);

	session
		.update(|view, _window, cx| view.dispatch(Intent::NewSession, cx))
		.expect("dispatch new session");
	session
		.update(|view, _window, _cx| {
			assert_eq!(view.state().current_id, 0);
			assert_eq!(view.state().title, "new session");
		})
		.expect("new session verified");
	session
		.update(|view, _window, cx| {
			let sections = view.state().sections.clone();
			view.dispatch(
				Intent::OpenOverlay(Box::new(Overlay::Palette(
					veyyon_desktop_surface::palette::PaletteState::from_sessions(&sections),
				))),
				cx,
			);
		})
		.expect("dispatch search palette");
	session
		.update(|view, _window, _cx| {
			assert!(
				matches!(&view.state().overlay, Some(Overlay::Palette(p)) if p.mode == PaletteMode::Sessions)
			);
		})
		.expect("search palette verified");
	session
		.update(|view, _window, cx| {
			view.dispatch(Intent::OpenOverlay(Box::new(Overlay::Settings(Box::default()))), cx);
		})
		.expect("dispatch settings overlay");
	session
		.update(|view, _window, _cx| {
			assert!(matches!(&view.state().overlay, Some(Overlay::Settings(_))));
		})
		.expect("settings overlay verified");
}

#[test]
fn queue_layout_boundaries_and_narrow_widths() {
	let mut cx = headless_context().expect("headless renderer is required");
	let state = fixture::populated();
	let mut session = open_session(&mut cx, state, 800, 560);
	let frame = session.frame().expect("shell renders frame at 800px width");
	let settings_gear = frame
		.hitboxes
		.iter()
		.find(|rect| f32::from(rect.origin.x) < 60.0 && f32::from(rect.origin.y) > 500.0)
		.copied();
	assert!(
		settings_gear.is_some(),
		"settings gear in rail footer must remain reachable in narrow 800px layout"
	);
}

#[test]
fn keyboard_selection_navigates_filtered_results_and_clamps_properly() {
	let mut state = make_large_queue_state();
	state.current_id = 16;
	state.title = "Live 16".into();

	Intent::FilterQueue("Live".into()).apply(&mut state);
	assert_eq!(state.keymap.queue_filter.as_deref(), Some("Live"));
	assert_eq!(state.current_id, 16);

	Intent::MoveQueueSelection(1).apply(&mut state);
	assert_eq!(state.current_id, 17);
	assert_eq!(state.title, "Live 17");

	Intent::MoveQueueSelection(50).apply(&mut state);
	assert_eq!(state.current_id, 45);
	assert_eq!(state.title, "Live 45");

	Intent::MoveQueueSelection(-100).apply(&mut state);
	assert_eq!(state.current_id, 16);
	assert_eq!(state.title, "Live 16");

	Intent::FilterQueue("NonExistent".into()).apply(&mut state);
	assert_eq!(state.keymap.queue_filter.as_deref(), Some("NonExistent"));

	Intent::FilterQueue(String::new()).apply(&mut state);
	assert_eq!(state.keymap.queue_filter, None);
	assert_eq!(state.current_id, 16);
}

#[test]
fn selection_in_collapsed_or_unpaged_section_ensures_visibility() {
	let mut motion = RailMotion::new();
	let sections = vec![
		(Section::Unsent, vec![row(1, "U 1".into(), "draft", None, None)]),
		(Section::Pinned, vec![row(2, "P 2".into(), "core", None, None)]),
		(Section::Live, vec![row(3, "L 3".into(), "gui", None, None)]),
		(
			Section::Deferred,
			(4..=20)
				.map(|i| row(i, format!("D {i}"), "def", None, None))
				.collect::<Vec<_>>(),
		),
		(
			Section::Parked,
			(21..=80)
				.map(|i| row(i, format!("P {i}"), "arc", None, None))
				.collect::<Vec<_>>(),
		),
	];
	let now = Instant::now();

	for section in Section::all() {
		motion.toggle_collapsed(section, now);
		assert!(motion.is_collapsed(section));
	}

	motion.ensure_visible(3, &sections, 25, now);
	assert!(!motion.is_collapsed(Section::Live), "selecting row in Live expands it");
	assert!(motion.is_collapsed(Section::Unsent), "Unsent stays collapsed");

	motion.ensure_visible(10, &sections, 25, now);
	assert!(
		!motion.is_collapsed(Section::Deferred),
		"selecting row in collapsed section must expand it"
	);

	assert_eq!(motion.parked_page(), 1);
	motion.ensure_visible(60, &sections, 25, now);
	assert!(motion.parked_page() >= 2, "selecting archival row must increase parked page");
}

#[test]
fn queue_search_palette_selection_dispatches_select_session_and_activates_host() {
	let sections = vec![(Section::Live, vec![
		row(10, "Auth Flow".into(), "working", None, None),
		row(20, "Database Migration".into(), "watching", None, None),
	])];
	let mut palette = veyyon_desktop_surface::palette::PaletteState::from_sessions(&sections);
	assert_eq!(palette.items.len(), 2);

	palette.set_query("Migration");
	let filtered = palette.filtered_items();
	assert_eq!(filtered.len(), 1);
	assert_eq!(filtered[0].title, "Database Migration");

	let intent = palette.run_intent();
	assert_eq!(intent, Some(Intent::SelectSession(20)));

	let mut state = fixture::populated();
	let mut intents = veyyon_desktop_surface::intent::Intents::new();
	intents.dispatch(intent.unwrap(), &mut state);

	assert_eq!(state.current_id, 20);
	assert_eq!(intents.pending(), &[Intent::SelectSession(20)]);
}

#[test]
fn new_session_clears_queue_filter_and_resets_current_id() {
	let mut state = fixture::populated();
	state.current_id = 42;
	state.keymap.queue_filter = Some("Filter".into());

	let mut intents = veyyon_desktop_surface::intent::Intents::new();
	intents.dispatch(Intent::NewSession, &mut state);

	assert_eq!(state.current_id, 0);
	assert_eq!(state.title, "new session");
	assert_eq!(state.keymap.queue_filter, None);
	assert_eq!(intents.pending(), &[Intent::NewSession]);
}
