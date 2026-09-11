//! The window's own retained state, read and written between frames.
//!
//! Every member here is a reader or a writer of a field the shell keeps across
//! frames: the installed tokens, the state to draw, the focus handles, the
//! label hysteresis, the motion drivers and the two overlays the window owns
//! rather than the host. The layout the frame resolves is elsewhere; this is
//! what a frame reads before it resolves anything.

use veyyon_desktop_kit::{SpanGesture, TextSelection, input::Editor};
use veyyon_gpui::{ClipboardItem, Context, Entity, FocusHandle};

use super::ShellView;
use crate::{
	damage::LaidOut,
	drawer::SignalMenu,
	intent::Intent,
	keymap::Keymap,
	layout::LabelState,
	model::ShellState,
	queue::{RailMotion, RowMenu},
	right_panel::PaneScrolls,
	settings::GeneralSettingsListState,
	tokens::InstalledTokens,
	transcript::{
		TranscriptViewportState, TurnMenu, after_gesture, select_whole_turn, selected_text,
	},
};

impl ShellView {
	/// Returns a clone of the destination focus handle.
	pub fn destination_focus_handle(&mut self, cx: &mut Context<Self>) -> FocusHandle {
		self
			.destination_focus
			.get_or_insert_with(|| cx.focus_handle())
			.clone()
	}

	/// Records whether the pointer is over the collapsed overflow row.
	///
	/// Returns whether that changed, which is what decides a repaint: the
	/// callback also fires when layout moves under a stationary pointer.
	pub const fn set_cards_hovered(&mut self, hovered: bool) -> bool {
		let changed = self.cards_hovered != hovered;
		self.cards_hovered = hovered;
		changed
	}

	/// Records whether the width the frame resolved floats the queue.
	pub const fn set_queue_floats(&mut self, floats: bool) {
		self.queue_floats = floats;
	}

	/// Answers the rail control, at whichever width the window is.
	///
	/// A width with room for a column toggles the standing collapsed state,
	/// which the host records and the next window restores. A width without
	/// room floats the rail over the transcript instead, and that is this
	/// window's own: the control moved nothing at all at those widths before,
	/// which left every session but the open one unreachable (§5.14).
	pub fn toggle_queue(&mut self, cx: &mut Context<Self>) {
		if self.queue_floats {
			self.queue_float_open = !self.queue_float_open;
			cx.notify();
		} else {
			self.dispatch(Intent::ToggleQueue, cx);
		}
	}

	/// Closes an open queue float, reporting whether one was open.
	///
	/// The Escape ladder and a press on the scrim both land here, so a float
	/// dismisses the way every other overlay over the transcript does.
	pub const fn close_queue_float(&mut self) -> bool {
		let was_open = self.queue_float_open;
		self.queue_float_open = false;
		was_open
	}

	/// The handles the right panel's mono panes report their scroll offsets
	/// through, so a pane builds the rows and columns its own box shows
	/// (§5.11).
	#[must_use]
	pub const fn pane_scrolls(&self) -> &PaneScrolls {
		&self.pane_scrolls
	}

	/// Returns a reference to the installed tokens.
	#[must_use]
	pub const fn installed(&self) -> &InstalledTokens {
		&self.installed
	}

	/// Returns the label hysteresis state.
	#[must_use]
	pub const fn labels(&self) -> LabelState {
		self.labels
	}

	/// Sets the label hysteresis state.
	pub const fn set_labels(&mut self, labels: LabelState) {
		self.labels = labels;
	}

	/// Returns a reference to the rail motion driver.
	#[must_use]
	pub const fn rail_motion(&self) -> &RailMotion {
		&self.rail_motion
	}

	/// Returns a mutable reference to the rail motion driver.
	pub const fn rail_motion_mut(&mut self) -> &mut RailMotion {
		&mut self.rail_motion
	}

	/// Returns a reference to the root focus handle if initialized.
	#[must_use]
	pub const fn focus_handle(&self) -> Option<&FocusHandle> {
		self.focus_handle.as_ref()
	}

	/// Returns a reference to the retained transcript viewport state.
	#[must_use]
	pub const fn transcript_viewport(&self) -> &TranscriptViewportState {
		&self.transcript_viewport
	}

	/// Sets the clock time in milliseconds for relative time computations.
	pub const fn set_clock_ms(&mut self, now_ms: u64) {
		self.now_ms = now_ms;
	}

	/// Returns the current clock time in milliseconds.
	#[must_use]
	pub const fn clock_ms(&self) -> u64 {
		self.now_ms
	}

	/// The queue row menu that is open, if one is.
	#[must_use]
	pub const fn row_menu(&self) -> Option<RowMenu> {
		self.row_menu
	}

	/// Opens the menu for a queue row at the pointer.
	pub const fn open_row_menu(&mut self, menu: RowMenu) {
		self.row_menu = Some(menu);
	}

	/// Closes the queue row menu, if one is open.
	pub const fn close_row_menu(&mut self) {
		self.row_menu = None;
	}

	/// The transcript turn menu that is open, if one is.
	#[must_use]
	pub const fn turn_menu(&self) -> Option<&TurnMenu> {
		self.turn_menu.as_ref()
	}

	/// Opens the menu for a transcript turn at the pointer.
	pub fn open_turn_menu(&mut self, menu: TurnMenu) {
		self.turn_menu = Some(menu);
	}

	/// Closes the transcript turn menu, if one is open.
	pub fn close_turn_menu(&mut self) {
		self.turn_menu = None;
	}

	/// What the pointer has selected in the transcript, if anything.
	///
	/// Window-local like the turn menu: a snapshot from the host never brings
	/// back a selection the reader dropped.
	#[must_use]
	pub const fn text_selection(&self) -> Option<TextSelection> {
		self.text_selection
	}

	/// Takes what the pointer did over one drawn span: a press starts a
	/// selection, a press with Shift held and every move with the button down
	/// extend the one that is held.
	pub fn report_span_gesture(&mut self, gesture: SpanGesture) {
		self.text_selection = Some(after_gesture(self.text_selection, gesture));
	}

	/// Selects the whole of one turn, which is what the entry chord takes.
	/// Leaves the selection alone when the turn drew nothing selectable.
	pub fn select_whole_entry(&mut self, turn_ix: usize) {
		if let Some(turn) = self.state.transcript.get(turn_ix)
			&& let Some(selection) = select_whole_turn(turn_ix, turn)
		{
			self.text_selection = Some(selection);
		}
	}

	/// The plain text of what is selected, which is empty when nothing is.
	#[must_use]
	pub fn selected_text(&self) -> String {
		self
			.text_selection
			.map(|selection| selected_text(&self.state.transcript, selection))
			.unwrap_or_default()
	}

	/// Drops the selection, which is what a dismissal over the transcript
	/// does.
	pub const fn clear_text_selection(&mut self) {
		self.text_selection = None;
	}

	/// The process signal menu that is open, if one is.
	#[must_use]
	pub const fn signal_menu(&self) -> Option<&SignalMenu> {
		self.signal_menu.as_ref()
	}

	/// Opens the signal menu for a supervised process at the press.
	pub fn open_signal_menu(&mut self, menu: SignalMenu) {
		self.signal_menu = Some(menu);
	}

	/// Closes the process signal menu, if one is open.
	pub fn close_signal_menu(&mut self) {
		self.signal_menu = None;
	}

	/// The width the operator dragged the docked right panel to, if they have.
	#[must_use]
	pub const fn panel_width(&self) -> Option<f32> {
		self.panel_width
	}

	/// Records the width a drag of the split handle asked for. The shed bounds
	/// it on the next frame, so a value past the panel's share is not an error
	/// here.
	pub const fn set_panel_width(&mut self, width_px: f32) {
		self.panel_width = Some(width_px);
	}

	/// Returns a reference to the active composer editor entity if initialized.
	#[must_use]
	pub const fn composer(&self) -> Option<&Entity<Editor>> {
		self.composer.as_ref()
	}

	/// Replaces the token set, after a reload applied a new one.
	pub fn set_tokens(&mut self, installed: InstalledTokens) {
		self.installed = installed;
	}

	/// Replaces the state to draw.
	pub fn set_state(&mut self, state: ShellState) {
		self.state = state;
	}

	/// What the shell is currently drawing.
	#[must_use]
	pub const fn state(&self) -> &ShellState {
		&self.state
	}

	/// The state to draw, for a projection that rewrites the host-owned fields
	/// in place and leaves the window-owned ones alone.
	pub const fn state_mut(&mut self) -> &mut ShellState {
		&mut self.state
	}

	/// Where the last frame laid each region out.
	#[must_use]
	pub const fn laid_out(&self) -> &LaidOut {
		&self.laid_out
	}

	/// Applies what the operator did, and records what a host must answer.
	pub fn dispatch(&mut self, intent: Intent, cx: &mut Context<Self>) {
		if !self.composer_action_allowed(&intent) {
			return;
		}
		if matches!(intent, Intent::SelectSession(_)) {
			self.rail_motion.request_scroll_to_selected();
		}
		// The clipboard belongs to the platform, so the write happens here
		// rather than in the state application, which has no window and no app.
		if let Intent::CopyText(text) = &intent
			&& !text.is_empty()
		{
			cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
		}
		self.intents.dispatch(intent, &mut self.state);
		cx.notify();
	}

	/// Takes the intents a host has not seen yet.
	pub fn drain_intents(&mut self) -> Vec<Intent> {
		self.intents.drain()
	}

	/// The intents recorded and not yet drained.
	#[must_use]
	pub fn pending(&self) -> &[Intent] {
		self.intents.pending()
	}

	/// Returns a reference to the active keymap table.
	#[must_use]
	pub const fn keymap(&self) -> &Keymap {
		&self.keymap
	}

	/// Returns a mutable reference to the active keymap table.
	pub const fn keymap_mut(&mut self) -> &mut Keymap {
		&mut self.keymap
	}

	/// Replaces the active keymap table.
	pub fn set_keymap(&mut self, keymap: Keymap) {
		self.keymap = keymap;
	}

	/// Returns a reference to the window-local General settings list state.
	#[must_use]
	pub const fn general_settings_list(&self) -> &GeneralSettingsListState {
		&self.general_settings_list
	}
}
