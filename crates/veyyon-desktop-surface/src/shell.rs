//! The shell: the window's titlebar and its layout regions (§4.2).
//!
//! The shell decides only where the regions go. It draws no content of its own
//! beyond the titlebar and the attention strip, so a region can be replaced
//! without touching layout, and layout can change without touching a region.
//!
//! Three columns, one row of chrome above them. The queue and the right panel
//! are fixed measures that give way to the middle, because the middle is the
//! surface being read; a window that gets narrower takes width from the panels
//! and leaves the transcript's line length alone.

use std::collections::{BTreeMap, BTreeSet};

use veyyon_desktop_kit::input::Editor;
use veyyon_gpui::{Context, Entity, FocusHandle, IntoElement, Render, Subscription, Window};

mod attach;
mod commands;
mod composer;
pub mod connection;
pub mod fields;
mod float;
pub mod keys;
mod memory;
mod notice;
pub mod overlay;
mod palette;
mod queue_search;
mod render;
mod session;
mod split;
pub mod titlebar;
mod transcript;
mod transcript_find;

pub use self::{
	attach::AttachState,
	connection::{connection_banner, error_hairline},
	memory::{HostShape, ScrollAnchor, SessionShape},
	overlay::overlay_scrim,
	titlebar::{
		TitlebarState, attention_strip, attention_strip_height, platform_inset_left_px, titlebar,
	},
};
use crate::{
	damage::LaidOut,
	intent::{Intent, Intents},
	keymap::Keymap,
	layout::LabelState,
	model::ShellState,
	queue::{RailMotion, RowMenu},
	right_panel::PaneScrolls,
	settings::GeneralSettingsListState,
	tokens::InstalledTokens,
	transcript::{TranscriptFindState, TranscriptViewportState},
};

/// The window's root view.
pub struct ShellView {
	installed:             InstalledTokens,
	state:                 ShellState,
	notice:                Option<String>,
	intents:               Intents,
	/// What the last frame settled the composer's labels on. Carried because
	/// the decision has hysteresis, so it is a function of the previous frame
	/// as well as of this width (§5.4).
	labels:                LabelState,
	/// Where the last frame laid each region out, for a repaint scoped to
	/// the regions a state change touched (P5).
	laid_out:              LaidOut,
	keymap:                Keymap,
	composer:              Option<Entity<Editor>>,
	composer_cache:        String,
	/// The editor behind every other field a surface draws: the secret a
	/// provider is waiting on, and the value of a setting whose kind is text.
	/// Retained across frames, because a field that is rebuilt each frame
	/// carries no keystroke (§8.25).
	field_editors:         BTreeMap<fields::FieldKey, fields::Field>,
	/// The refusal this window put up for a field whose value it would not
	/// send, so it is withdrawn when the same window's field commits.
	field_refusal:         Option<String>,
	/// The field a frame created that has not taken focus yet.
	field_focus:           Option<Entity<Editor>>,
	palette_input:         palette::PaletteInput,
	submitted:             Option<composer::SubmittedDraft>,
	/// What the composer draws that is the window's: the drop target and
	/// the refusal line.
	attach:                AttachState,
	rail_motion:           RailMotion,
	transcript_viewport:   TranscriptViewportState,
	find_state:            TranscriptFindState,
	split_motion:          split::SplitMotions,
	/// The queue row menu that is open, if one is (§5.1). Window-local,
	/// like a hover: a snapshot never reopens one.
	row_menu:              Option<RowMenu>,
	/// The width the operator dragged the docked right panel to. Window-local
	/// like the row menu: a snapshot never moves the handle (§5.6).
	panel_width:           Option<f32>,
	/// Where each of the right panel's mono panes is scrolled to, which is
	/// what states the rows and columns the next frame builds (§5.11).
	/// Window-local for the same reason the dragged width is.
	pane_scrolls:          PaneScrolls,
	/// Disclosed tool cards a previous window remembered whose invocations
	/// this one has not drawn yet, the drawer tenant it last looked at, which
	/// the host has not reported yet, and where it was reading, which names an
	/// entry the transcript has not arrived with (§8.10).
	pending_expanded:      BTreeSet<String>,
	pending_drawer_tab:    Option<String>,
	pending_anchor:        Option<ScrollAnchor>,
	focus_handle:          Option<FocusHandle>,
	/// The focus the queue rail takes when the pointer lands in it, which is
	/// what puts the `Queue` key context on the focus path so the scope's
	/// chords resolve (§5.14).
	queue_focus:           Option<FocusHandle>,
	/// The same for the right panel: the `Panel` scope's chords — the tab
	/// walk and the diff-mode toggle — resolve against the `Panel` key
	/// context, which reaches the focus path only while the panel holds the
	/// focus (§5.14).
	panel_focus:           Option<FocusHandle>,
	/// And for the transcript column, whose scope carries the scroll chords,
	/// the find bar and the block toggle (§5.14).
	transcript_focus:      Option<FocusHandle>,
	/// And for the collapsed row the overflowing decision cards fold into,
	/// which expands to state which decisions are waiting while it holds the
	/// focus, so the count is readable without a pointer (§5.5).
	cards_focus:           Option<FocusHandle>,
	/// Whether the pointer is over that row. A hover style resolves at paint
	/// and cannot change a box, so an expansion the pointer drives is state
	/// the next frame lays out rather than a `hover` refinement (§5.5).
	cards_hovered:         bool,
	/// Whether the operator opened the queue over the transcript, at a width
	/// whose row has no room for a rail beside it (§5.14). Window-local like
	/// the row menu: a float that came back with a snapshot would cover the
	/// transcript the window was opened to read.
	queue_float_open:      bool,
	/// Whether the width the last frame resolved floats the queue rather than
	/// docking it, which is what decides whether the rail control toggles the
	/// float or the standing collapsed state.
	queue_floats:          bool,
	destination_focus:     Option<FocusHandle>,
	general_settings_list: GeneralSettingsListState,
	now_ms:                u64,
	subscriptions:         Vec<Subscription>,
}

impl ShellView {
	/// Builds the root view from an installed token set and a state to draw.
	pub fn new(installed: InstalledTokens, state: ShellState) -> Self {
		let mut palette_input = palette::PaletteInput::default();
		if state.overlay.is_some() {
			palette_input.motion = crate::palette::motion::FloatMotion::with_initial(
				veyyon_desktop_motion::SurfaceId::Palette,
				0,
				true,
			);
			palette_input.retained.clone_from(&state.overlay);
		}
		Self {
			installed,
			state,
			notice: None,
			intents: Intents::new(),
			labels: LabelState::default(),
			laid_out: LaidOut::default(),
			keymap: Keymap::default(),
			composer: None,
			composer_cache: String::new(),
			field_editors: BTreeMap::new(),
			field_refusal: None,
			field_focus: None,
			palette_input,
			submitted: None,
			attach: AttachState::default(),
			rail_motion: RailMotion::new(),
			transcript_viewport: TranscriptViewportState::new(),
			find_state: TranscriptFindState::default(),
			split_motion: split::SplitMotions::default(),
			row_menu: None,
			panel_width: None,
			pending_expanded: BTreeSet::new(),
			pending_drawer_tab: None,
			pending_anchor: None,
			focus_handle: None,
			queue_focus: None,
			pane_scrolls: PaneScrolls::default(),
			panel_focus: None,
			transcript_focus: None,
			cards_focus: None,
			cards_hovered: false,
			queue_float_open: false,
			queue_floats: false,
			destination_focus: None,
			general_settings_list: GeneralSettingsListState::new(),
			now_ms: 0,
			subscriptions: Vec::new(),
		}
	}

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

impl Render for ShellView {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		render::render_shell(self, window, cx)
	}
}
