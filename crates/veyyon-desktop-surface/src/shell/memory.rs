//! What one window remembers between launches (§8.10).
//!
//! The window owns a shape no host frame reports: which systems are open, how
//! large the operator dragged them, which tenant each shows, which sections of
//! the queue are collapsed, which tool cards are disclosed, and the draft that
//! was never sent. This module is the only seam that shape crosses, in both
//! directions: `host_shape` and `session_shape` state what the window holds,
//! and the `restore_*` calls put a previous window's shape back.
//!
//! Nothing here reads or writes a file. The document, the versioning and the
//! debounce belong to `veyyon_desktop_model::persistence` and to the binary
//! crate, so this crate persists nothing and is still measurable headlessly.
//!
//! Two of the fields cannot be applied when they arrive. A drawer tab names a
//! tenant the host has not reported yet, and a disclosed card names an
//! invocation whose transcript has not arrived, so both are held and resolved
//! against each frame until the thing they name is drawn.

use std::{collections::BTreeSet, path::PathBuf, time::Instant};

use veyyon_desktop_model::{DiffMode, QueueMode};
use veyyon_gpui::Context;

use super::ShellView;
use crate::{
	composer::AttachmentSource,
	drawer::DrawerTab,
	intent::Intent,
	model::{Block, Section, Turn},
	right_panel::PanelTab,
};

/// The shape one window holds for every session at once (§8.10).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HostShape {
	/// Whether the queue rail is collapsed to its icon width.
	pub queue_collapsed:    bool,
	/// The sections the operator collapsed, by name.
	pub collapsed_sections: BTreeSet<String>,
	/// How many pages of the parked section the operator paged in, counted
	/// from one.
	pub parked_page:        usize,
}

/// The shape one window holds for one session (§8.10).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SessionShape {
	/// Whether the right panel is docked open.
	pub panel_visible:     bool,
	/// The width the operator dragged the panel to, if they dragged it.
	pub panel_width_px:    Option<f32>,
	/// Whether the terminal drawer is open.
	pub drawer_visible:    bool,
	/// The height the operator dragged the drawer to, if they dragged it.
	pub drawer_height_px:  Option<f32>,
	/// The panel tenant the operator last looked at.
	pub active_panel_tab:  PanelTab,
	/// The drawer tenant the operator last looked at, by name.
	pub active_drawer_tab: Option<String>,
	/// Whether a diff draws unified or split.
	pub diff_mode:         DiffMode,
	/// The prompt that was typed and not sent.
	pub draft_text:        String,
	/// The attachments the draft carries that a relaunch can read again.
	pub attachment_paths:  Vec<String>,
	/// Whether a prompt sent during a turn steers it or queues behind it.
	pub queue_mode:        QueueMode,
	/// The tool cards the operator disclosed, by invocation id.
	pub expanded_call_ids: BTreeSet<String>,
	/// Where the operator was reading, or nothing when they were at the live
	/// edge.
	pub scroll_anchor:     Option<ScrollAnchor>,
}

/// Where a transcript was left, by the entry the top turn was opened by
/// (§8.10).
///
/// An index would name a different turn the moment the session pages in
/// earlier ones, which is what a relaunch does before it has the whole
/// transcript.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ScrollAnchor {
	/// The entry the turn at the top of the view was opened by.
	pub entry_id:  String,
	/// How far into that turn the view starts.
	pub offset_px: f32,
}

impl ShellView {
	/// The shape this window holds for every session at once.
	#[must_use]
	pub fn host_shape(&self) -> HostShape {
		HostShape {
			queue_collapsed:    self.state.keymap.queue_collapsed,
			collapsed_sections: Section::all()
				.into_iter()
				.filter(|section| self.rail_motion.is_collapsed(*section))
				.map(|section| section.slug().to_string())
				.collect(),
			parked_page:        self.rail_motion.parked_page(),
		}
	}

	/// The shape this window holds for the session it is drawing.
	#[must_use]
	pub fn session_shape(&self) -> SessionShape {
		SessionShape {
			panel_visible:     !self.state.keymap.panel_collapsed,
			panel_width_px:    self.panel_width,
			drawer_visible:    self.state.drawer_open,
			drawer_height_px:  self.split_motion.drawer_height(),
			active_panel_tab:  self.state.panel.active_tab,
			active_drawer_tab: self
				.state
				.drawer
				.tabs
				.get(self.state.drawer.active_tab)
				.map(DrawerTab::slug)
				.or_else(|| self.pending_drawer_tab.clone()),
			diff_mode:         self.state.panel.diff_mode,
			draft_text:        self.composer_cache.clone(),
			// A pasted image has no path, so a relaunch cannot read it back;
			// it is left out rather than written as a chip whose bytes are
			// gone.
			attachment_paths:  self
				.state
				.composer
				.attachments
				.iter()
				.filter_map(|attachment| match &attachment.source {
					AttachmentSource::Path(path) => Some(path.display().to_string()),
					AttachmentSource::Clipboard(_) => None,
				})
				.collect(),
			queue_mode:        self.state.composer.queue_mode,
			expanded_call_ids: self.expanded_call_ids(),
			scroll_anchor:     self.scroll_anchor(),
		}
	}

	/// Where the operator is reading, by the entry the top turn was opened by.
	///
	/// A view following the live edge holds no anchor: it comes back at the
	/// edge however many turns have run since. An anchor a previous window
	/// left that this one has not been able to place yet is held rather than
	/// dropped, so a relaunch that syncs before the transcript arrives does
	/// not forget where it was told to open.
	fn scroll_anchor(&self) -> Option<ScrollAnchor> {
		if let Some(pending) = &self.pending_anchor {
			return Some(pending.clone());
		}
		if self.transcript_viewport.is_following_tail() {
			return None;
		}
		let offset = self.transcript_viewport.logical_scroll_top();
		let entry_id = self.state.turn_anchors.get(offset.item_ix)?.clone();
		Some(ScrollAnchor { entry_id, offset_px: f32::from(offset.offset_in_item) })
	}

	/// The invocations whose cards are disclosed, by the id the host reports.
	///
	/// A card is held open by its position in the drawn transcript, which a
	/// session that pages in earlier turns moves. The id is what survives that,
	/// and an id whose turn has not arrived yet is still held, so a relaunch
	/// that has not fetched the transcript does not forget the disclosure it
	/// just read off the disk.
	fn expanded_call_ids(&self) -> BTreeSet<String> {
		let mut ids = self.pending_expanded.clone();
		for (turn_ix, turn) in self.state.transcript.iter().enumerate() {
			let Turn::Agent { blocks, .. } = turn else {
				continue;
			};
			for (block_ix, block) in blocks.iter().enumerate() {
				if let Block::Invoke { call_id, .. } = block
					&& self
						.transcript_viewport
						.is_block_expanded(turn_ix, block_ix)
				{
					ids.insert(call_id.clone());
				}
			}
		}
		ids
	}

	/// Puts back the shape a previous window held for every session at once.
	pub fn restore_host_shape(&mut self, shape: &HostShape) {
		self.state.keymap.queue_collapsed = shape.queue_collapsed;
		let sections = shape
			.collapsed_sections
			.iter()
			.filter_map(|slug| Section::from_slug(slug));
		self.rail_motion.restore_collapsed(sections);
		self.rail_motion.set_parked_page(shape.parked_page);
	}

	/// Puts back the shape a previous window held for the session now drawn.
	///
	/// The panel width and the drawer height are seeded rather than dragged:
	/// the shed bounds both on the next frame, so a height from a larger
	/// window is cut to what this one can hold instead of being refused here.
	pub fn restore_session_shape(&mut self, shape: &SessionShape, cx: &mut Context<Self>) {
		self.state.keymap.panel_collapsed = !shape.panel_visible;
		if let Some(width) = shape.panel_width_px {
			self.set_panel_width(width);
		}
		self.state.drawer_open = shape.drawer_visible && self.state.drawer.offered;
		if let Some(height) = shape.drawer_height_px {
			self.restore_drawer_height(height);
		}
		self.state.panel.active_tab = shape.active_panel_tab;
		self.state.panel.diff_mode = shape.diff_mode;
		self.pending_drawer_tab.clone_from(&shape.active_drawer_tab);
		self.pending_expanded.clone_from(&shape.expanded_call_ids);
		self.pending_anchor.clone_from(&shape.scroll_anchor);
		self.set_composed(shape.draft_text.clone(), cx);
		self.state.composer.queue_mode = shape.queue_mode;
		self.state.composer.attachments.clear();
		let paths: Vec<PathBuf> = shape.attachment_paths.iter().map(PathBuf::from).collect();
		// Read through the same path a drop takes, so a file that has since
		// been deleted or grown past the ceiling states its refusal rather
		// than coming back as a chip carrying nothing.
		self.attach_paths(paths, cx);
	}

	/// Applies the remembered shape that names something the host had not
	/// reported when it was read.
	///
	/// Called once per frame from the transcript sync. A card is disclosed to
	/// the host as well as to the viewport, because the host owns the view a
	/// disclosed card draws: opening one silently would draw the body over the
	/// collapsed view the host generated.
	pub(super) fn apply_remembered(&mut self, now: Instant) {
		if let Some(slug) = self.pending_drawer_tab.clone()
			&& let Some(index) = self
				.state
				.drawer
				.tabs
				.iter()
				.position(|tab| tab.slug() == slug)
		{
			self.state.drawer.active_tab = index;
			self.pending_drawer_tab = None;
		}
		if let Some(anchor) = self.pending_anchor.clone()
			&& let Some(item_ix) = self
				.state
				.turn_anchors
				.iter()
				.position(|entry_id| *entry_id == anchor.entry_id)
		{
			self
				.transcript_viewport
				.scroll_to_offset(item_ix, anchor.offset_px);
			self.pending_anchor = None;
		}
		if self.pending_expanded.is_empty() {
			return;
		}
		let reduced = self.rail_motion.is_reduced_motion();
		let mut disclosed = Vec::new();
		for (turn_ix, turn) in self.state.transcript.iter().enumerate() {
			let Turn::Agent { blocks, .. } = turn else {
				continue;
			};
			for (block_ix, block) in blocks.iter().enumerate() {
				if let Block::Invoke { call_id, views, .. } = block
					&& self.pending_expanded.remove(call_id)
				{
					disclosed.push((
						turn_ix,
						block_ix,
						call_id.clone(),
						views.result.is_some() || views.call.is_some(),
					));
				}
			}
		}
		for (turn_ix, block_ix, call_id, has_views) in disclosed {
			self.transcript_viewport.set_block_expanded(
				turn_ix,
				block_ix,
				true,
				&self.installed.motion,
				reduced,
				now,
			);
			if has_views {
				let intent = Intent::SetToolViewExpanded { call_id, expanded: true };
				self.intents.dispatch(intent, &mut self.state);
			}
		}
	}
}
