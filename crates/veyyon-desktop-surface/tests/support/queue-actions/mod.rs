//! Helper functions for queue hover-action and context-menu interaction tests.
//! Each suite pulls in only what it uses, so a helper unused by one binary is
//! expected.
#![allow(dead_code, reason = "each test binary uses a subset of these helpers")]

use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_scene::{Captured, HeadlessSession};
use veyyon_desktop_surface::{
	Intent, Row, ShellState, ShellView, attach::ConnectionPhase, model::Section, queue::RowMenuKind,
};
use veyyon_gpui::{Bounds, Pixels, Point, px};

/// Token metrics for queue rail row heights and action controls.
pub struct QueueMetrics {
	pub card_height: Pixels,
	pub line_height: Pixels,
}

impl QueueMetrics {
	pub fn load() -> Self {
		let tokens = load_bundled_tokens().expect("tokens load");
		Self {
			card_height: px(tokens.surface.queue.card_px),
			line_height: px(tokens.surface.queue.line_px),
		}
	}
}

/// Builds a compact shell state with one session row per `Section::all()`
/// variant.
pub fn make_per_section_state() -> ShellState {
	let mut sections = Vec::new();
	for (idx, section) in Section::all().into_iter().enumerate() {
		let id = (idx as u64) + 101;
		let row = Row {
			id,
			title: format!("{} task", section.label()),
			subtitle: "veyyon-desktop-surface".to_owned(),
			badge: None,
			meta: None,
		};
		sections.push((section, vec![row]));
	}
	ShellState {
		title: "veyyon-desktop-surface".to_owned(),
		sections,
		current_id: 999,
		connection: ConnectionPhase::Attached,
		..ShellState::default()
	}
}

/// Computes the center click point for a bounding box.
pub fn center_of(rect: Bounds<Pixels>) -> Point<Pixels> {
	Point { x: rect.origin.x + rect.size.width / 2.0, y: rect.origin.y + rect.size.height / 2.0 }
}

/// Dispatches a mouse move event to simulate real pointer movement onto an
/// element.
pub fn move_mouse(session: &mut HeadlessSession<'_, ShellView>, at: Point<Pixels>) {
	session.hover(at).expect("mouse move dispatched");
}

/// Finds all queue row bounds in the rail sorted vertically from top to bottom.
pub fn find_queue_rows(frame: &Captured, metrics: &QueueMetrics) -> Vec<Bounds<Pixels>> {
	let mut rows: Vec<_> = frame
		.hitboxes
		.iter()
		.filter(|r| {
			r.origin.x >= px(6.0)
				&& r.origin.x <= px(10.0)
				&& r.size.width >= px(200.0)
				&& (r.size.height == metrics.card_height || r.size.height == metrics.line_height)
		})
		.copied()
		.collect();
	rows.sort_by_key(|r| r.origin.y);
	rows
}

/// Extracts leaf hitboxes without excluding controls of a different size.
pub fn extract_action_buttons(frame: &Captured, row_bounds: Bounds<Pixels>) -> Vec<Bounds<Pixels>> {
	let contains = |outer: Bounds<Pixels>, inner: Bounds<Pixels>| {
		inner.origin.x >= outer.origin.x
			&& inner.origin.x + inner.size.width <= outer.origin.x + outer.size.width
			&& inner.origin.y >= outer.origin.y
			&& inner.origin.y + inner.size.height <= outer.origin.y + outer.size.height
	};
	let candidates: Vec<_> = frame
		.hitboxes
		.iter()
		.copied()
		.filter(|bounds| *bounds != row_bounds && contains(row_bounds, *bounds))
		.collect();
	let mut buttons: Vec<_> = candidates
		.iter()
		.copied()
		.filter(|bounds| {
			!candidates
				.iter()
				.any(|child| child != bounds && contains(*bounds, *child))
		})
		.collect();
	buttons.sort_by_key(|bounds| {
		(bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height)
	});
	buttons.dedup();
	buttons
}

/// Finds all context menu item hitboxes rendered within an open popover menu.
pub fn find_menu_items(frame: &Captured, origin: Point<Pixels>) -> Vec<Bounds<Pixels>> {
	let mut items: Vec<_> = frame
		.hitboxes
		.iter()
		.filter(|r| {
			r.origin.x >= origin.x
				&& r.origin.x <= origin.x + px(12.0)
				&& r.origin.y >= origin.y
				&& r.origin.y < origin.y + px(350.0)
				&& r.size.width >= px(50.0)
				&& r.size.height >= px(20.0)
				&& r.size.height <= px(45.0)
		})
		.copied()
		.collect();
	items.sort_by_key(|r| r.origin.y);
	items.dedup_by(|a, b| (a.origin.y - b.origin.y).abs() < px(1.0));
	items
}

/// Expected interaction contract for a single section variant.
pub struct SectionContract {
	pub hover_intents: Vec<Intent>,
	pub menu_kind:     RowMenuKind,
	pub menu_intents:  Vec<Intent>,
}

impl SectionContract {
	pub fn for_section(section: Section, row_id: u64) -> Self {
		match section {
			Section::Unsent | Section::Live => Self {
				hover_intents: vec![Intent::ParkSession(row_id), Intent::DeferSession(row_id)],
				menu_kind:     RowMenuKind::Card,
				menu_intents:  vec![
					Intent::SelectSession(row_id),
					Intent::ParkSession(row_id),
					Intent::DeferSession(row_id),
					Intent::BranchSession(row_id),
					Intent::ExportSession(Some(row_id)),
					Intent::CompactSession(Some(row_id)),
					Intent::HandoffSession(Some(row_id)),
					Intent::DeleteSession(row_id),
				],
			},
			// A card carries two hover actions at most (§5.1), so the way out
			// of `Pinned` is on the menu.
			Section::Pinned => Self {
				hover_intents: vec![Intent::ParkSession(row_id), Intent::DeferSession(row_id)],
				menu_kind:     RowMenuKind::Pinned,
				menu_intents:  vec![
					Intent::SelectSession(row_id),
					Intent::UnpinSession(row_id),
					Intent::ParkSession(row_id),
					Intent::DeferSession(row_id),
					Intent::BranchSession(row_id),
					Intent::ExportSession(Some(row_id)),
					Intent::CompactSession(Some(row_id)),
					Intent::HandoffSession(Some(row_id)),
					Intent::DeleteSession(row_id),
				],
			},
			Section::Deferred => Self {
				hover_intents: vec![Intent::RecallSession(row_id)],
				menu_kind:     RowMenuKind::Deferred,
				menu_intents:  vec![Intent::SelectSession(row_id), Intent::RecallSession(row_id)],
			},
			Section::Parked => Self {
				hover_intents: vec![Intent::UnparkSession(row_id)],
				menu_kind:     RowMenuKind::Parked,
				menu_intents:  vec![Intent::SelectSession(row_id), Intent::UnparkSession(row_id)],
			},
		}
	}
}
