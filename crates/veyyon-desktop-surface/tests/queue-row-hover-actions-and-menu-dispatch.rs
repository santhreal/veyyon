//! WHY: Active queue sessions draw as 78px cards and archival sessions (Parked
//! and Deferred) draw as 36px lines (§5.1, §5.2).
//! Active cards must provide only Park and Defer hover actions (no permanent
//! branch or delete controls). Archival lines must provide only their
//! applicable single restore action (Unpark for Parked, Recall for Deferred).
//! Context menus must offer only the actions valid for each row's actual
//! partition, and selecting a menu item must dispatch its mapped intent and
//! close the menu.
//!
//! CLASS CLOSED:
//! 1. Cards rendering permanent branch or delete controls in the queue rail.
//! 2. Parked lines rendering recall buttons or opening menus with recall
//!    choices.
//! 3. Deferred lines rendering unpark buttons or opening menus with unpark
//!    choices.
//! 4. Right-click context menus dispatching mismatched restore or management
//!    intents.
//! 5. Selecting menu items failing to execute real intent dispatch and menu
//!    dismissal.
//! 6. Pointer and keyboard navigation failing across card/line partition
//!    boundaries.
//! 7. Hover-action button clicks triggering row selection side-effects.
//! 8. A held-back action that answers a click before it is painted. A row
//!    reserves the slot its actions occupy, and a pointer arriving from outside
//!    the row lands in that slot while the frame answering the click has
//!    painted nothing there. That click opens the session. An action held back
//!    by opacity or a zero-alpha colour is painted, listeners and all, so it
//!    parks or defers a session nobody asked to park or defer.
//! 9. A refused answer that states it is pressable. The row is drawn and
//!    registers no rect, so a press where its label sits sends nothing, leaves
//!    the session in the queue and leaves the menu up rather than falling
//!    through the panel to the scrim.

#[path = "support/large_queue.rs"]
mod large_queue;
#[path = "support/queue-actions/mod.rs"]
mod queue_actions;
#[path = "support/queue-scroll/mod.rs"]
mod queue_scroll;

use large_queue::make_large_queue_state;
use queue_actions::{
	QueueMetrics, SectionContract, center_of, extract_action_buttons, find_menu_items,
	find_queue_rows, make_per_section_state, move_mouse,
};
use queue_scroll::open_session;
use veyyon_desktop_scene::headless::headless_context;
use veyyon_desktop_surface::{Intent, controls::Availability, fixture, model::Section};
use veyyon_gpui::{Point, px};

#[test]
fn every_section_variant_exposes_only_valid_hover_actions_and_isolates_dispatch() {
	let metrics = QueueMetrics::load();
	let state = make_per_section_state();
	let mut cx = headless_context().expect("headless renderer is required");
	let mut session = open_session(&mut cx, state, 1440, 900);

	let frame = session.frame().expect("initial frame renders");
	let row_bounds = find_queue_rows(&frame, &metrics);
	let all_sections = Section::all();
	assert_eq!(
		row_bounds.len(),
		all_sections.len(),
		"each section in Section::all() renders exactly one row in the per-section fixture"
	);

	for (idx, section) in all_sections.into_iter().enumerate() {
		let row_id = (idx as u64) + 101;
		let contract = SectionContract::for_section(section, row_id);
		let bounds = row_bounds[idx];

		// Verify geometric shape matches section card vs line rules
		let expected_height = if section.draws_cards() {
			metrics.card_height
		} else {
			metrics.line_height
		};
		assert_eq!(
			bounds.size.height, expected_height,
			"{section:?} row height must match token metrics"
		);

		// Send real mouse movement to hover over the row and reveal hover actions
		move_mouse(&mut session, center_of(bounds));
		let hovered_frame = session.frame().expect("hovered frame renders");

		let buttons = extract_action_buttons(&hovered_frame, bounds);
		assert_eq!(
			buttons.len(),
			contract.hover_intents.len(),
			"{section:?} row must expose exactly the expected hover action buttons"
		);

		// Click each hover action button and verify isolated intent dispatch
		for (btn_idx, expected_intent) in contract.hover_intents.into_iter().enumerate() {
			session
				.update(|view, _window, _cx| {
					let _ = view.drain_intents();
				})
				.expect("drain intents");

			session
				.click(center_of(buttons[btn_idx]))
				.expect("click hover action button");

			session
				.update(|view, _window, _cx| {
					assert_eq!(
						view.drain_intents(),
						vec![expected_intent.clone()],
						"{section:?} hover button click must dispatch exactly {expected_intent:?}"
					);
					assert_eq!(
						view.state().current_id,
						999,
						"hover action click on {section:?} row must not trigger row selection \
						 side-effects"
					);
				})
				.expect("hover dispatch verified");
		}
	}
}

#[test]
fn every_section_variant_context_menu_dispatches_mapped_intents_and_dismisses() {
	let metrics = QueueMetrics::load();
	let state = make_per_section_state();
	let mut cx = headless_context().expect("headless renderer is required");
	let mut session = open_session(&mut cx, state, 1440, 900);

	let frame = session.frame().expect("initial frame renders");
	let row_bounds = find_queue_rows(&frame, &metrics);

	for (idx, section) in Section::all().into_iter().enumerate() {
		let row_id = (idx as u64) + 101;
		let contract = SectionContract::for_section(section, row_id);
		let bounds = row_bounds[idx];
		let menu_origin = Point { x: px(60.0), y: bounds.origin.y + px(6.0) };

		// Test each context menu choice dispatches mapped intent and dismisses
		for (choice_idx, expected_intent) in contract.menu_intents.iter().enumerate() {
			session
				.right_click(menu_origin)
				.expect("right click opens context menu");
			session
				.update(|view, _window, _cx| {
					let menu = view.row_menu().expect("context menu is open");
					assert_eq!(menu.id, row_id);
					assert_eq!(menu.kind, contract.menu_kind);
					let _ = view.drain_intents();
				})
				.expect("menu verified");

			let menu_frame = session.frame().expect("menu frame renders");
			let items = find_menu_items(&menu_frame, menu_origin);
			assert_eq!(
				items.len(),
				contract.menu_intents.len(),
				"{section:?} menu items count must match expected partition choices"
			);

			session
				.click(center_of(items[choice_idx]))
				.expect("click context menu item");

			session
				.update(|view, _window, _cx| {
					assert!(view.row_menu().is_none(), "menu must dismiss after selection");
					assert_eq!(
						view.drain_intents(),
						vec![expected_intent.clone()],
						"menu item click must dispatch mapped intent"
					);
				})
				.expect("menu action verified");
		}

		// Test scrim dismissal
		session
			.right_click(menu_origin)
			.expect("right click opens context menu for scrim dismissal");
		session
			.click(Point { x: px(500.0), y: px(500.0) })
			.expect("click outside menu on scrim");
		session
			.update(|view, _window, _cx| {
				assert!(view.row_menu().is_none(), "scrim click must dismiss menu");
				assert!(view.drain_intents().is_empty(), "scrim click must not dispatch intents");
			})
			.expect("scrim dismissal verified");
	}
}

#[test]
fn disabled_card_menu_items_suppress_dispatch_on_click() {
	let mut cx = headless_context().expect("headless renderer is required");
	let mut state = fixture::populated();
	let delete_surface = veyyon_desktop_model::SurfaceId::QueueDeleteButton(
		veyyon_desktop_model::SessionId::from("3"),
	);
	state
		.controls
		.set_availability(delete_surface, Availability::Unavailable {
			reason: "cannot delete active session".to_string(),
		});
	let mut session = open_session(&mut cx, state, 1440, 900);
	let metrics = QueueMetrics::load();

	let frame = session.frame().expect("initial frame renders");
	let row_bounds = find_queue_rows(&frame, &metrics);
	// Row 3 is index 2 (Live card)
	let card3_bounds = row_bounds[2];
	let menu_origin = Point { x: px(60.0), y: card3_bounds.origin.y + px(10.0) };

	session
		.right_click(menu_origin)
		.expect("right click card 3");

	let menu_frame = session.frame().expect("menu renders in frame");
	let menu_items = find_menu_items(&menu_frame, menu_origin);
	assert_eq!(
		menu_items.len(),
		7,
		"a refused answer answers no press, so the card menu hit-tests only its other seven rows"
	);

	// The refused row is drawn and registers nothing, so where it is comes off
	// the label the frame set rather than off a rect a press could land on.
	let refused = menu_frame
		.text_runs
		.iter()
		.find(|run| run.text.as_ref() == "Delete" && run.bounds.origin.y >= menu_origin.y)
		.expect("the menu draws the refused answer")
		.bounds;
	let target = center_of(refused);
	assert!(
		!menu_items.iter().any(|item| {
			target.x >= item.origin.x
				&& target.x <= item.origin.x + item.size.width
				&& target.y >= item.origin.y
				&& target.y <= item.origin.y + item.size.height
		}),
		"the refused answer registers a rect under its label, so the menu states that a press it \
		 will not answer is pressable"
	);

	session
		.update(|view, _window, _cx| {
			let _ = view.drain_intents();
		})
		.expect("drain intents");

	session
		.click(target)
		.expect("press where the refused answer is drawn");
	session
		.update(|view, _window, _cx| {
			assert!(
				view.drain_intents().is_empty(),
				"clicking disabled menu item must not dispatch delete intent"
			);
			assert!(
				view.row_menu().is_some(),
				"a press on a refused row fell through the panel to the scrim and took the menu down \
				 with it"
			);
			let sections = &view.state().sections;
			let exists = sections
				.iter()
				.any(|(_, rows)| rows.iter().any(|r| r.id == 3));
			assert!(exists, "session 3 must not be deleted when clicking disabled menu item");
		})
		.expect("session 3 intact");
}

#[test]
fn selection_requests_cross_partition_boundaries_without_switching_before_acknowledgement() {
	let state = make_large_queue_state();
	for (_, rows) in &state.sections {
		let target = rows.first().expect("large fixture includes every section");
		let mut requested = state.clone();
		let mut intents = veyyon_desktop_surface::intent::Intents::new();
		intents.dispatch(Intent::SelectSession(target.id), &mut requested);
		assert_eq!(intents.pending(), &[Intent::SelectSession(target.id)]);
		assert_eq!(requested.current_id, state.current_id);
		assert_eq!(requested.title, state.title);
	}
	let rows: Vec<_> = state
		.sections
		.iter()
		.flat_map(|(section, rows)| rows.iter().map(move |row| (*section, row)))
		.collect();
	for boundary in rows.windows(2).filter(|pair| pair[0].0 != pair[1].0) {
		for (from, to, step) in
			[(boundary[0].1, boundary[1].1, 1), (boundary[1].1, boundary[0].1, -1)]
		{
			let mut acknowledged = state.clone();
			acknowledged.current_id = from.id;
			acknowledged.title.clone_from(&from.title);
			let mut intents = veyyon_desktop_surface::intent::Intents::new();
			intents.dispatch(Intent::MoveQueueSelection(step), &mut acknowledged);
			assert_eq!(intents.pending(), &[Intent::SelectSession(to.id)]);
			assert_eq!(acknowledged.current_id, from.id);
			assert_eq!(acknowledged.title, from.title);
		}
	}
}

#[test]
fn a_click_where_a_held_back_action_reserves_space_opens_the_session() {
	let metrics = QueueMetrics::load();
	let mut cx = headless_context().expect("headless renderer is required");
	let mut session = open_session(&mut cx, make_per_section_state(), 1440, 900);

	// Away from every row, so no row's actions are painted. The transcript is
	// free to answer a hover of its own: nothing here reads outside the rail.
	let off_rail = Point { x: px(900.0), y: px(450.0) };
	move_mouse(&mut session, off_rail);
	let resting = session.frame().expect("resting frame renders");
	let rows = find_queue_rows(&resting, &metrics);
	let sections = Section::all();
	assert_eq!(rows.len(), sections.len(), "one row per section in the per-section fixture");

	for (idx, section) in sections.into_iter().enumerate() {
		let row_id = (idx as u64) + 101;
		let row = rows[idx];

		// Where the actions will be painted, read off a hovered frame and then
		// abandoned: the click below is answered by the resting frame, which is
		// the frame a pointer arriving from outside the row is answered by.
		move_mouse(&mut session, center_of(row));
		let hovered = session.frame().expect("hovered frame renders");
		let places = extract_action_buttons(&hovered, row);
		assert_eq!(
			places.len(),
			SectionContract::for_section(section, row_id)
				.hover_intents
				.len(),
			"{section:?} row paints its actions under the pointer, or there is no place to cold-click"
		);

		move_mouse(&mut session, off_rail);
		let _ = session.frame().expect("resting frame renders again");

		for place in places {
			session
				.update(|view, _window, _cx| {
					let _ = view.drain_intents();
				})
				.expect("intents drained");
			session
				.click(center_of(place))
				.expect("click where the held-back action reserves its space");
			session
				.update(|view, _window, _cx| {
					assert_eq!(
						view.drain_intents(),
						vec![Intent::SelectSession(row_id)],
						"a click on the space the held-back {section:?} actions reserve opens the \
						 session, and dispatches no action the frame had not painted"
					);
				})
				.expect("cold click verified");
			move_mouse(&mut session, off_rail);
			let _ = session.frame().expect("resting frame renders again");
		}
	}
}
