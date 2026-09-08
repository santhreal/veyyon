//! WHY: Every queue partition (`Unsent`, `Pinned`, `Live`, `Deferred`,
//! `Parked`) must be independently collapsible via rendered section header
//! pointer clicks (both on the nested chevron button and on the section label
//! text) without collapsing sibling sections or triggering double-toggles,
//! while maintaining selection identity, virtualized list item bounds, and
//! section headers (§5.1, §5.2).
//!
//! DEFECT CLASSES CLOSED:
//! 1. Active sections (`Unsent`, `Pinned`, `Live`) rendering inert section
//!    headers that fail to respond to click events.
//! 2. Duplicate click handlers on nested chevron button and header container
//!    causing double-toggle transitions due to event bubbling.
//! 3. Section collapse state leaking across partition boundaries (collapsing
//!    one partition incorrectly toggling others).
//! 4. Empty sections improperly rendering in the queue rail.
//! 5. Non-empty collapsed sections failing to retain their header and chevron
//!    toggle.
//! 6. Selecting an already-current or newly selected row in any collapsed
//!    section failing to expand that section when explicit selection is
//!    requested.
//!
//! GAPS:
//! Exact visual rasterization and rendered glyphs of badge/count text digits
//! require UI capture verification on live frame rasters.

#[path = "support/queue-scroll/mod.rs"]
mod queue_scroll;

use std::time::{Duration, Instant};

use queue_scroll::{open_session, row};
use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_scene::{HeadlessSession, headless::headless_context};
use veyyon_desktop_surface::{Badge, Intent, Row, Section, ShellState, ShellView, fixture};
use veyyon_gpui::{Bounds, Pixels, Point, px};

fn section_header_px() -> f32 {
	let tokens = load_bundled_tokens().expect("bundled tokens load");
	tokens.surface.queue.section_header_px
}

fn make_compact_all_sections_state() -> ShellState {
	let mut state = fixture::populated();
	state.sections = Section::all()
		.into_iter()
		.enumerate()
		.map(|(ix, sec)| {
			let id = (ix as u64) + 1;
			let title = format!("{} session {id}", sec.label());
			let badge = match sec {
				Section::Live => Some(Badge::Working),
				Section::Pinned => Some(Badge::Approval),
				_ => None,
			};
			let placement = if sec == Section::Unsent {
				Section::Live
			} else {
				sec
			};
			let r =
				Row { id, title, subtitle: "repo".into(), badge, meta: Some("2m".into()), placement };
			(sec, vec![r])
		})
		.collect();
	state.current_id = 3;
	state
}

fn settle(session: &mut HeadlessSession<'_, ShellView>) {
	session.frame().expect("layout before advancing motion");
	session
		.update(|view, _, cx| {
			// Rail motion takes std::time::Instant; advancing the GPUI timer
			// executor does not advance this clock.
			let start = Instant::now();
			for tick in 1..=240 {
				if !view
					.rail_motion_mut()
					.has_active_animations(start + Duration::from_millis(tick * 16))
				{
					cx.notify();
					return;
				}
			}
			panic!("queue animations must settle within 240 frames");
		})
		.expect("advance rail animation clock");
	session.frame().expect("settled queue frame");
}

fn find_section_headers(session: &mut HeadlessSession<'_, ShellView>) -> Vec<Bounds<Pixels>> {
	let target_h = section_header_px();
	let frame = session.frame().expect("render frame");
	let mut headers: Vec<_> = frame
		.hitboxes
		.iter()
		.filter(|hb| {
			let (w, h, x, y) = (
				f32::from(hb.size.width),
				f32::from(hb.size.height),
				f32::from(hb.origin.x),
				f32::from(hb.origin.y),
			);
			x < 256.0 && y >= 32.0 && (h - target_h).abs() < 1.0 && w > 100.0
		})
		.copied()
		.collect();
	headers.sort_by_key(|hb| hb.origin.y);
	headers
}

fn click_chevron(session: &mut HeadlessSession<'_, ShellView>, header: Bounds<Pixels>) {
	let point =
		Point { x: header.origin.x + px(20.0), y: header.origin.y + header.size.height / 2.0 };
	session.click(point).expect("click chevron");
	settle(session);
}

fn click_label(session: &mut HeadlessSession<'_, ShellView>, header: Bounds<Pixels>) {
	let point =
		Point { x: header.origin.x + px(70.0), y: header.origin.y + header.size.height / 2.0 };
	session.click(point).expect("click label");
	settle(session);
}

#[test]
fn clicking_chevron_button_collapses_and_expands_each_section_without_double_toggle() {
	let mut cx = headless_context().expect("headless renderer is required");
	let state = make_compact_all_sections_state();
	let section_count = Section::all().len();
	let total_items = section_count * 2;
	let mut session = open_session(&mut cx, state, 1440, 900);
	settle(&mut session);

	for (ix, section) in Section::all().into_iter().enumerate() {
		session
			.update(|view, _window, _cx| {
				assert_eq!(view.rail_motion().list_state().item_count(), total_items);
				assert!(!view.rail_motion().is_collapsed(section));
			})
			.expect("pre-collapse item count verified");

		let headers = find_section_headers(&mut session);
		assert_eq!(headers.len(), section_count);
		click_chevron(&mut session, headers[ix]);

		session
			.update(|view, _window, _cx| {
				assert!(
					view.rail_motion().is_collapsed(section),
					"chevron click must collapse section {section:?} without double-toggle"
				);
				assert_eq!(
					view.rail_motion().list_state().item_count(),
					total_items - 1,
					"collapsing 1-row section drops list count by 1 while keeping header"
				);
			})
			.expect("chevron collapse verified");

		let headers = find_section_headers(&mut session);
		click_chevron(&mut session, headers[ix]);

		session
			.update(|view, _window, _cx| {
				assert!(
					!view.rail_motion().is_collapsed(section),
					"chevron second click must expand section {section:?} without double-toggle"
				);
				assert_eq!(
					view.rail_motion().list_state().item_count(),
					total_items,
					"expanding section restores full item count"
				);
			})
			.expect("chevron expand verified");
	}
}

#[test]
fn clicking_section_label_text_collapses_and_expands_independently() {
	let mut cx = headless_context().expect("headless renderer is required");
	let state = make_compact_all_sections_state();
	let section_count = Section::all().len();
	let total_items = section_count * 2;
	let mut session = open_session(&mut cx, state, 1440, 900);
	settle(&mut session);

	for (ix, section) in Section::all().into_iter().enumerate() {
		let headers = find_section_headers(&mut session);
		assert_eq!(headers.len(), section_count);

		click_label(&mut session, headers[ix]);

		session
			.update(|view, _window, _cx| {
				assert!(
					view.rail_motion().is_collapsed(section),
					"section {section:?} must be collapsed after label click"
				);
				for sibling in Section::all() {
					if sibling != section {
						let expected = Section::all().into_iter().take(ix).any(|s| s == sibling);
						assert_eq!(
							view.rail_motion().is_collapsed(sibling),
							expected,
							"sibling {sibling:?} state corrupted when toggling {section:?}"
						);
					}
				}
				assert_eq!(
					view.state().current_id,
					3,
					"selection identity must remain stable across section collapse"
				);
			})
			.expect("independent collapse verified");
	}

	for (ix, section) in Section::all().into_iter().enumerate() {
		let headers = find_section_headers(&mut session);
		assert_eq!(headers.len(), section_count, "all collapsed headers remain visible in layout");

		click_label(&mut session, headers[ix]);

		session
			.update(|view, _window, _cx| {
				assert!(
					!view.rail_motion().is_collapsed(section),
					"section {section:?} must expand after second click"
				);
			})
			.expect("independent expand verified");
	}

	session
		.update(|view, _window, _cx| {
			assert_eq!(
				view.rail_motion().list_state().item_count(),
				total_items,
				"all sections expanded restores item count"
			);
			assert_eq!(view.state().current_id, 3);
		})
		.expect("final expanded state verified");
}

#[test]
fn empty_sections_are_hidden_while_non_empty_collapsed_sections_retain_headers() {
	let mut cx = headless_context().expect("headless renderer is required");
	let mut state = fixture::populated();
	let populated_sections = vec![
		(Section::Unsent, vec![]),
		(Section::Pinned, vec![]),
		(Section::Live, vec![row(1, "Live 1".into(), "gui", None, None)]),
		(Section::Deferred, vec![row(2, "Deferred 2".into(), "def", None, None)]),
		(Section::Parked, vec![row(3, "Parked 3".into(), "arc", None, None)]),
	];
	let non_empty_count = populated_sections
		.iter()
		.filter(|(_, r)| !r.is_empty())
		.count();
	state.sections = populated_sections;

	let mut session = open_session(&mut cx, state, 1440, 900);
	settle(&mut session);

	let headers = find_section_headers(&mut session);
	assert_eq!(
		headers.len(),
		non_empty_count,
		"empty sections must be hidden; only non-empty section headers rendered"
	);

	click_chevron(&mut session, headers[0]);

	session
		.update(|view, _window, _cx| {
			assert!(view.rail_motion().is_collapsed(Section::Live));
			assert_eq!(
				view.rail_motion().list_state().item_count(),
				non_empty_count + non_empty_count - 1
			);
		})
		.expect("Live collapsed");

	let headers_after = find_section_headers(&mut session);
	assert_eq!(
		headers_after.len(),
		non_empty_count,
		"collapsed non-empty section must retain its header in the rail"
	);
}

#[test]
fn selecting_row_in_any_collapsed_section_expands_only_that_section() {
	let mut cx = headless_context().expect("headless renderer is required");
	let state = make_compact_all_sections_state();
	let all_sections = Section::all();
	let section_count = all_sections.len();

	for (target_ix, target_sec) in all_sections.into_iter().enumerate() {
		let mut session = open_session(&mut cx, state.clone(), 1440, 900);
		settle(&mut session);

		session
			.update(|view, _window, cx| {
				for section in Section::all() {
					view
						.rail_motion_mut()
						.toggle_collapsed(section, Instant::now());
				}
				cx.notify();
			})
			.expect("collapse all");

		settle(&mut session);

		session
			.update(|view, _window, _cx| {
				for section in Section::all() {
					assert!(view.rail_motion().is_collapsed(section));
				}
				assert_eq!(view.rail_motion().list_state().item_count(), section_count);
			})
			.expect("all collapsed verified");

		let target_id = (target_ix as u64) + 1;
		session
			.update(|view, _window, cx| {
				view.rail_motion_mut().request_scroll_to_selected();
				view.dispatch(Intent::SelectSession(target_id), cx);
			})
			.expect("select target session");

		settle(&mut session);

		session
			.update(|view, _window, _cx| {
				assert_eq!(view.state().current_id, target_id);
				assert!(
					!view.rail_motion().is_collapsed(target_sec),
					"target section {target_sec:?} must expand when its row is selected"
				);
				for sibling in Section::all() {
					if sibling != target_sec {
						assert!(
							view.rail_motion().is_collapsed(sibling),
							"sibling section {sibling:?} must remain collapsed when selecting in \
							 {target_sec:?}"
						);
					}
				}
				assert_eq!(view.rail_motion().list_state().item_count(), section_count + 1);
			})
			.expect("target expansion and sibling preservation verified");
	}
}
