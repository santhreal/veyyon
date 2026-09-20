//! Motion driver for the queue rail (§5.2, §7.1, §7.3).

use std::{
	collections::{HashMap, HashSet},
	time::Instant,
};

use veyyon_desktop_motion::{
	AnimatorKey, AnimatorRegistry, MotionModel, MotionRole, MotionTokens, SurfaceId,
};
use veyyon_gpui::{ListAlignment, ListState, px};

use crate::model::{Row, Section};

pub mod resolve;
pub mod shift;

pub use self::{resolve::*, shift::*};

/// Motion driver owning persistent queue animation states.
pub struct RailMotion {
	registry: AnimatorRegistry,
	shift: ShiftChoreography,
	collapsed: HashSet<Section>,
	parked_page: usize,
	selected_id: Option<u64>,
	last_ensured_id: Option<u64>,
	pending_scroll_to_selected: bool,
	list_state: ListState,
	item_count: usize,
	reduced_motion: bool,
	tokens: MotionTokens,
}

impl Default for RailMotion {
	fn default() -> Self {
		Self::new()
	}
}

impl RailMotion {
	/// Creates a new rail motion driver with reference motion tokens.
	#[must_use]
	pub fn new() -> Self {
		Self::with_tokens_and_reduced(MotionTokens::reference(), false)
	}

	/// Creates a rail motion driver with explicit motion tokens.
	pub fn with_tokens(tokens: MotionTokens) -> Self {
		Self::with_tokens_and_reduced(tokens, false)
	}

	/// Creates a rail motion driver with explicit motion tokens and
	/// reduced-motion policy.
	#[must_use]
	pub fn with_tokens_and_reduced(tokens: MotionTokens, reduced_motion: bool) -> Self {
		Self {
			registry: AnimatorRegistry::new(),
			shift: ShiftChoreography::new(),
			collapsed: HashSet::new(),
			parked_page: 1,
			selected_id: None,
			last_ensured_id: None,
			pending_scroll_to_selected: false,
			list_state: ListState::new(0, ListAlignment::Top, px(crate::list_overdraw::QUEUE_PX)),
			item_count: 0,
			reduced_motion,
			tokens,
		}
	}

	/// Synchronizes motion tokens and reduced-motion policy from active
	/// settings.
	pub const fn sync_tokens(&mut self, tokens: MotionTokens, reduced_motion: bool) {
		self.tokens = tokens;
		self.reduced_motion = reduced_motion;
	}

	/// Sets whether reduced motion is active.
	pub const fn set_reduced_motion(&mut self, reduced: bool) {
		self.reduced_motion = reduced;
	}

	/// Returns whether reduced motion is active.
	#[must_use]
	pub const fn is_reduced_motion(&self) -> bool {
		self.reduced_motion
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
		if new_count != old_count {
			if new_count > old_count {
				self
					.list_state
					.splice(old_count..old_count, new_count - old_count);
			} else {
				self.list_state.splice(new_count..old_count, 0);
			}
			self.item_count = new_count;
		}
	}

	/// Scrolls the virtualized list to reveal the item at `item_index`.
	pub fn scroll_to_reveal_item(&mut self, item_index: usize) {
		self.list_state.scroll_to_reveal_item(item_index);
		self.pending_scroll_to_selected = false;
	}

	/// Returns a reference to the motion tokens.
	#[must_use]
	pub const fn tokens(&self) -> &MotionTokens {
		&self.tokens
	}

	const fn reveal_model(&self) -> MotionModel {
		reveal_model(&self.tokens, self.reduced_motion)
	}

	/// Expands a section if currently collapsed, starting a reveal animation.
	pub fn expand_section(&mut self, section: Section, now: Instant) {
		if self.collapsed.remove(&section) {
			let key = AnimatorKey::new(SurfaceId::Queue, MotionRole::Reveal, section as u64);
			let model = self.reveal_model();
			self
				.registry
				.get_or_create_with_initial(key, 0.0, 1.0, model, now);
		}
	}

	/// Ensures the selected row is visible across collapsed sections and parked
	/// pagination bounds.
	pub fn ensure_visible(
		&mut self,
		selected_id: u64,
		sections: &[(Section, Vec<Row>)],
		initial_page_size: usize,
		now: Instant,
	) {
		if self.last_ensured_id == Some(selected_id) {
			return;
		}
		self.last_ensured_id = Some(selected_id);
		self.selected_id = Some(selected_id);

		for (section, rows) in sections {
			if let Some(pos) = rows.iter().position(|r| r.id == selected_id) {
				if self.collapsed.contains(section) {
					self.expand_section(*section, now);
				}
				if *section == Section::Parked {
					let needed_page = (pos / initial_page_size.max(1)) + 1;
					if needed_page > self.parked_page {
						self.parked_page = needed_page;
					}
				}
				break;
			}
		}
	}

	/// Returns the recorded vertical layout position of a row if measured.
	#[must_use]
	pub fn row_position(&self, id: u64) -> Option<f32> {
		self.shift.row_position(id)
	}

	/// Increments the parked page limit to page in older archival sessions.
	pub const fn show_more_parked(&mut self, _step: usize) {
		self.parked_page = self.parked_page.saturating_add(1);
	}

	/// Resets the parked page count to the initial page.
	pub const fn reset_parked_page(&mut self) {
		self.parked_page = 1;
	}

	/// Toggles collapse state for a section.
	pub fn toggle_collapsed(&mut self, section: Section, now: Instant) {
		let is_now_collapsed = if self.collapsed.contains(&section) {
			self.collapsed.remove(&section);
			false
		} else {
			self.collapsed.insert(section);
			true
		};
		let (initial, target) = if is_now_collapsed {
			(1.0, 0.0)
		} else {
			(0.0, 1.0)
		};
		let key = AnimatorKey::new(SurfaceId::Queue, MotionRole::Reveal, section as u64);
		let model = self.reveal_model();
		self
			.registry
			.get_or_create_with_initial(key, initial, target, model, now);
	}

	/// Records layout positions for the current frame.
	pub fn record_positions(&mut self, positions: &HashMap<u64, f32>, now: Instant) {
		self.shift.record_positions(
			&mut self.registry,
			&self.tokens,
			self.reduced_motion,
			positions,
			now,
		);
	}

	/// Returns the FLIP translation Y offset for `row_id` at timestamp `now`.
	#[must_use]
	pub fn shift_offset(&self, row_id: u64, now: Instant) -> f32 {
		self.shift.shift_offset(&self.registry, row_id, now)
	}

	/// Returns a reference to the underlying [`ShiftChoreography`].
	#[must_use]
	pub const fn shift(&self) -> &ShiftChoreography {
		&self.shift
	}

	/// Returns a mutable reference to the underlying [`ShiftChoreography`].
	pub const fn shift_mut(&mut self) -> &mut ShiftChoreography {
		&mut self.shift
	}

	/// Returns reveal animation progress (0.0 = collapsed, 1.0 = expanded).
	#[must_use]
	pub fn reveal_progress(&self, section: Section, now: Instant) -> f32 {
		let key = AnimatorKey::new(SurfaceId::Queue, MotionRole::Reveal, section as u64);
		if let Some(pos) = self.registry.sample(&key, now) {
			pos
		} else if self.collapsed.contains(&section) {
			0.0
		} else {
			1.0
		}
	}

	/// Returns tint transition progress (0.0 to 1.0) for `slot` at `now`.
	#[must_use]
	pub fn tint_progress(&self, slot: u64, now: Instant) -> f32 {
		let key = AnimatorKey::new(SurfaceId::Queue, MotionRole::Tint, slot);
		self.registry.sample(&key, now).unwrap_or(1.0)
	}

	/// Updates tint animation target value for `slot`.
	pub fn set_tint(&mut self, slot: u64, target: f32, now: Instant) {
		let key = AnimatorKey::new(SurfaceId::Queue, MotionRole::Tint, slot);
		let model = tint_model(&self.tokens, self.reduced_motion);
		self.registry.update_target(key, target, model, now);
	}

	/// Advances the animation registry and returns whether any active animations
	/// remain.
	pub fn has_active_animations(&mut self, now: Instant) -> bool {
		!self.registry.step_frame(now).is_empty()
	}

	/// Returns true if any animator in the registry is currently running at
	/// `now`.
	#[must_use]
	pub fn is_animating(&self, now: Instant) -> bool {
		self.registry.has_active_animations(now)
	}

	/// Returns a reference to the underlying [`AnimatorRegistry`].
	pub const fn registry(&self) -> &AnimatorRegistry {
		&self.registry
	}

	/// Returns a mutable reference to the underlying [`AnimatorRegistry`].
	pub const fn registry_mut(&mut self) -> &mut AnimatorRegistry {
		&mut self.registry
	}
}
