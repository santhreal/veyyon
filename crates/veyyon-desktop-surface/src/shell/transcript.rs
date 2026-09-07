//! Transcript keyboard actions and viewport synchronization (§5.2, §5.3,
//! §5.14).
//!
//! Consumes pending keymap intents (`ScrollTranscript`, `StepTurn`,
//! `ToggleBlock`) and synchronizes them directly into the retained
//! `TranscriptViewportState` so keyboard actions execute real viewport scroll
//! jumps, turn focusing, and block expansions.

use std::time::Instant;

use veyyon_gpui::{ListOffset, px};

use crate::{
	ShellView, composer::TurnPhase, intent::Intent, keymap::actions::ScrollBy, model::Block,
};

impl ShellView {
	/// Synchronizes the retained transcript viewport with the current session
	/// state, consuming any pending keyboard scroll, one-shot turn step, or
	/// block expansion requests.
	pub(super) fn sync_transcript_viewport(&mut self, viewport_height_px: f32, now: Instant) {
		// 1. Sync session switch if current_id changed
		self
			.transcript_viewport
			.switch_session(self.state.current_id, self.state.transcript.len());

		// 2. Sync turns and streaming status
		let is_streaming = matches!(self.state.turn, TurnPhase::Running { .. });
		self
			.transcript_viewport
			.sync_turns(&self.state.transcript, is_streaming);

		let reduced = self.rail_motion.is_reduced_motion();
		let motion = &self.installed.motion;

		// 3. Consume pending keyboard scroll request (§5.3 PageUp, PageDown, Home, End)
		if let Some(scroll_by) = self.state.keymap.transcript_scroll {
			let list_height = f32::from(
				self
					.transcript_viewport
					.list_state()
					.viewport_bounds()
					.size
					.height,
			);
			let page_height = if list_height > 0.0 {
				list_height
			} else {
				viewport_height_px
			};
			if page_height <= 0.0 && matches!(scroll_by, ScrollBy::PageUp | ScrollBy::PageDown) {
				return;
			}
			self.state.keymap.transcript_scroll = None;
			let page_delta = px(page_height);
			match scroll_by {
				ScrollBy::Top => {
					self.transcript_viewport.scroll_to_animated(
						ListOffset { item_ix: 0, offset_in_item: px(0.0) },
						motion,
						reduced,
						now,
					);
				},
				ScrollBy::Bottom => {
					self
						.transcript_viewport
						.scroll_to_end_animated(motion, reduced, now);
				},
				ScrollBy::PageUp => {
					self
						.transcript_viewport
						.scroll_by_animated(-page_delta, motion, reduced, now);
				},
				ScrollBy::PageDown => {
					self
						.transcript_viewport
						.scroll_by_animated(page_delta, motion, reduced, now);
				},
			}
		}

		// 4. One-shot turn focus jump: execute scroll only when pending_turn_focus is
		//    set
		if self.state.keymap.pending_turn_focus {
			self.state.keymap.pending_turn_focus = false;
			if let Some(turn_ix) = self.state.keymap.focused_turn
				&& turn_ix < self.state.transcript.len()
			{
				self
					.transcript_viewport
					.scroll_to_turn_animated(turn_ix, motion, reduced, now);
			}
		}

		// 5. Consume toggle focused block request (Space / ToggleBlock)
		if self.state.keymap.focused_block_collapsed {
			self.state.keymap.focused_block_collapsed = false;
			let focused_ix = self
				.state
				.keymap
				.focused_turn
				.unwrap_or_else(|| self.state.transcript.len().saturating_sub(1));

			let block_ix = match self.state.transcript.get(focused_ix) {
				Some(crate::model::Turn::Agent(blocks)) => blocks.iter().position(|block| {
					matches!(
						block,
						Block::Invoke { .. }
							| Block::Reason(_)
							| Block::Pane { .. }
							| Block::Unknown { .. }
							| Block::Artifact(_)
					)
				}),
				Some(crate::model::Turn::OperatorArtifacts { artifacts, .. })
					if !artifacts.is_empty() =>
				{
					Some(0)
				},
				_ => None,
			};
			if let Some(block_ix) = block_ix {
				self.transcript_viewport.toggle_block_expanded(
					focused_ix,
					block_ix,
					&self.installed.motion,
					self.rail_motion.is_reduced_motion(),
					now,
				);
				// The host owns a tool card's disclosure: it regenerates the view with
				// the hidden lines in it, and the pointer path tells it so on every
				// click. Expanding the same card from the keyboard and staying silent
				// opened the body over the collapsed view, so Space and a click on one
				// card produced two different cards.
				if let Some(crate::model::Turn::Agent(blocks)) = self.state.transcript.get(focused_ix)
					&& let Some(Block::Invoke { call_id, views, .. }) = blocks.get(block_ix)
					&& (views.result.is_some() || views.call.is_some())
				{
					let expanded = self
						.transcript_viewport
						.is_block_expanded(focused_ix, block_ix);
					let intent = Intent::SetToolViewExpanded { call_id: call_id.clone(), expanded };
					self.intents.dispatch(intent, &mut self.state);
				}
			}
		}

		// 6. Sync in-transcript search hits if query is active
		if self.find_state.has_query() {
			self.find_state.sync_turns(&self.state.transcript);
		}
	}
}
