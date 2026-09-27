//! Motion driver for the queue rail (§5.2, §7.1, §7.3).
//!
//! A section's reveal and a row's move run on one `AnimatorRegistry` keyed by
//! what moves. A row that moved is drawn at its old position and translated
//! to its new one: its offset starts at the distance moved and animates to
//! zero, so the list lays out at once and no sibling reflows.

use std::collections::{HashMap, HashSet};

use veyyon_gpui::{
	ListAlignment, ListState,
	motion::{
		Advance, AnimatorRegistry, FrameInstant, MotionFrame, MotionPolicy, MotionRole, MotionTokens,
		ResolvedMotion, resolve_motion,
	},
	px,
};

use crate::model::{Row, Section};

/// Moves closer than this, in pixels, are not moves.
const MOVE_TOLERANCE_PX: f32 = 0.001;

/// What one rail animator moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum RailKey {
	/// A section's reveal progress: 0.0 collapsed, 1.0 expanded.
	Reveal(Section),
	/// A row's translation from where it was drawn to where it is laid out.
	Shift(u64),
}

/// The queue rail's retained state: collapse, paging, selection, the list,
/// and the motion of its sections and rows.
pub struct RailMotion {
	motion:                     AnimatorRegistry<RailKey, FrameInstant>,
	positions:                  HashMap<u64, f32>,
	collapsed:                  HashSet<Section>,
	parked_page:                usize,
	selected_id:                Option<u64>,
	last_ensured_id:            Option<u64>,
	pending_scroll_to_selected: bool,
	list_state:                 ListState,
	item_count:                 usize,
}

impl Default for RailMotion {
	fn default() -> Self {
		Self::new()
	}
}

impl RailMotion {
	/// A rail with every section expanded and nothing moving.
	#[must_use]
	pub fn new() -> Self {
		Self {
			motion:                     AnimatorRegistry::new(),
			positions:                  HashMap::new(),
			collapsed:                  HashSet::new(),
			parked_page:                1,
			selected_id:                None,
			last_ensured_id:            None,
			pending_scroll_to_selected: false,
			list_state:                 ListState::new(
				0,
				ListAlignment::Top,
				px(crate::list_overdraw::QUEUE_PX),
			),
			item_count:                 0,
		}
	}

	/// Returns whether the given section is currently collapsed.
	#[must_use]
	pub fn is_collapsed(&self, section: Section) -> bool {
		self.collapsed.contains(&section)
	}

	/// Collapses exactly the sections a previous window left collapsed (§8.10).
	pub fn restore_collapsed(&mut self, sections: impl IntoIterator<Item = Section>) {
		self.collapsed = sections.into_iter().collect();
	}

	/// Returns the current page number for archival parked sessions.
	#[must_use]
	pub const fn parked_page(&self) -> usize {
		self.parked_page
	}

	/// Sets the current page number for archival parked sessions.
	pub fn set_parked_page(&mut self, page: usize) {
		self.parked_page = page.max(1);
	}

	/// Returns the active row display limit for parked sessions.
	#[must_use]
	pub fn parked_limit(&self, initial_page_size: usize) -> usize {
		self.parked_page.saturating_mul(initial_page_size.max(1))
	}

	/// Records the currently selected row ID for keyboard navigation tracking.
	pub fn record_selected_id(&mut self, id: u64) {
		if self.selected_id != Some(id) {
			self.selected_id = Some(id);
			self.pending_scroll_to_selected = true;
		}
	}

	/// Returns a reference to the retained [`ListState`].
	#[must_use]
	pub const fn list_state(&self) -> &ListState {
		&self.list_state
	}

	/// Returns whether a scroll request to the selected item is pending.
	#[must_use]
	pub const fn should_scroll_to_selected(&self) -> bool {
		self.pending_scroll_to_selected
	}

	/// Clears any pending scroll request to the selected item.
	pub const fn clear_pending_scroll(&mut self) {
		self.pending_scroll_to_selected = false;
	}

	/// Requests the queue rail to scroll to the selected row on next layout.
	pub const fn request_scroll_to_selected(&mut self) {
		self.pending_scroll_to_selected = true;
		self.last_ensured_id = None;
	}

	/// Synchronizes list item count.
	pub fn sync_item_count(&mut self, new_count: usize) {
		let old_count = self.item_count;
		if new_count > old_count {
			self
				.list_state
				.splice(old_count..old_count, new_count - old_count);
		} else if new_count < old_count {
			self.list_state.splice(new_count..old_count, 0);
		}
		self.item_count = new_count;
	}

	/// Scrolls the virtualized list to reveal the item at `item_index`.
	pub fn scroll_to_reveal_item(&mut self, item_index: usize) {
		self.list_state.scroll_to_reveal_item(item_index);
		self.pending_scroll_to_selected = false;
	}

	/// Starts `section`'s reveal from `initial` toward `target` at `now`, or
	/// retargets the reveal already running.
	fn reveal(
		&mut self,
		section: Section,
		initial: f32,
		target: f32,
		tokens: &MotionTokens,
		policy: MotionPolicy,
		now: FrameInstant,
	) {
		let model = resolve_motion(MotionRole::Reveal, tokens, policy.reduced()).model();
		self
			.motion
			.animate(RailKey::Reveal(section), initial, target, model, policy, now);
	}

	/// Expands a section if currently collapsed, starting a reveal animation.
	pub fn expand_section(
		&mut self,
		section: Section,
		tokens: &MotionTokens,
		policy: MotionPolicy,
		now: FrameInstant,
	) {
		if self.collapsed.remove(&section) {
			self.reveal(section, 0.0, 1.0, tokens, policy, now);
		}
	}

	/// Ensures the selected row is visible across collapsed sections and parked
	/// pagination bounds.
	pub fn ensure_visible(
		&mut self,
		selected_id: u64,
		sections: &[(Section, Vec<Row>)],
		initial_page_size: usize,
		tokens: &MotionTokens,
		policy: MotionPolicy,
		now: FrameInstant,
	) {
		if self.last_ensured_id == Some(selected_id) {
			return;
		}
		self.last_ensured_id = Some(selected_id);
		self.selected_id = Some(selected_id);

		for (section, rows) in sections {
			if let Some(pos) = rows.iter().position(|r| r.id == selected_id) {
				self.expand_section(*section, tokens, policy, now);
				if *section == Section::Parked {
					let needed_page = (pos / initial_page_size.max(1)) + 1;
					self.parked_page = self.parked_page.max(needed_page);
				}
				break;
			}
		}
	}

	/// Increments the parked page limit to page in older archival sessions.
	pub const fn show_more_parked(&mut self, _step: usize) {
		self.parked_page = self.parked_page.saturating_add(1);
	}

	/// Resets the parked page count to the initial page.
	pub const fn reset_parked_page(&mut self) {
		self.parked_page = 1;
	}

	/// Toggles collapse state for a section and starts its reveal toward the
	/// new state.
	pub fn toggle_collapsed(
		&mut self,
		section: Section,
		tokens: &MotionTokens,
		policy: MotionPolicy,
		now: FrameInstant,
	) {
		let collapsing = self.collapsed.insert(section);
		if !collapsing {
			self.collapsed.remove(&section);
		}
		let (initial, target) = if collapsing { (1.0, 0.0) } else { (0.0, 1.0) };
		self.reveal(section, initial, target, tokens, policy, now);
	}

	/// Records where each row is laid out this frame. A row that moved since
	/// the last frame starts its translation from the distance moved, added
	/// to the offset still showing at `now`. Reduced motion places the row.
	pub fn record_positions(
		&mut self,
		positions: &HashMap<u64, f32>,
		tokens: &MotionTokens,
		policy: MotionPolicy,
		now: FrameInstant,
	) {
		let motion = resolve_motion(MotionRole::Shift, tokens, policy.reduced());
		for (row_id, current) in positions {
			let Some(previous) = self.positions.get(row_id) else {
				continue;
			};
			let delta = previous - current;
			if delta.abs() <= MOVE_TOLERANCE_PX {
				continue;
			}
			let key = RailKey::Shift(*row_id);
			match motion {
				ResolvedMotion::Duration { .. } => {
					let model = motion.model();
					let offset = self.motion.animate(key, 0.0, 0.0, model, policy, now);
					let showing = offset.value();
					offset.start(delta + showing, 0.0, 0.0, model, policy, now);
				},
				_ => {
					self.motion.remove(&key);
				},
			}
		}
		self.positions.clone_from(positions);
		self.motion.retain_active();
	}

	/// Returns the recorded vertical layout position of a row if measured.
	#[must_use]
	pub fn row_position(&self, id: u64) -> Option<f32> {
		self.positions.get(&id).copied()
	}

	/// The translation of `row_id` at the last advance, zero at rest.
	#[must_use]
	pub fn shift_offset(&self, row_id: u64) -> f32 {
		self
			.motion
			.get(&RailKey::Shift(row_id))
			.map_or(0.0, |offset| offset.value())
	}

	/// The reveal progress of `section` at the last advance: 0.0 collapsed,
	/// 1.0 expanded.
	#[must_use]
	pub fn reveal_progress(&self, section: Section) -> f32 {
		self.motion.get(&RailKey::Reveal(section)).map_or_else(
			|| if self.is_collapsed(section) { 0.0 } else { 1.0 },
			|reveal| reveal.value(),
		)
	}

	/// Brings every reveal and shift to `now` and returns whether one is still
	/// moving.
	pub fn advance_to(&mut self, now: FrameInstant) -> bool {
		self.motion.update_all(now) > 0
	}
}

impl Advance for RailMotion {
	fn advance(&mut self, frame: &MotionFrame) -> bool {
		self.advance_to(frame.now())
	}
}
