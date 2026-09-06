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

use veyyon_desktop_kit::input::{Editor, EditorEvent, EditorMode};
use veyyon_gpui::{
	AppContext, Context, Entity, FocusHandle, IntoElement, Render, Subscription, Window,
};

mod attach;
mod commands;
mod composer;
pub mod connection;
mod float;
pub mod keys;
pub mod overlay;
mod palette;
mod render;
mod session;
pub mod titlebar;

pub use attach::AttachState;
pub use connection::{connection_banner, error_hairline};
pub use overlay::overlay_scrim;
pub use titlebar::{
	TitlebarState, attention_strip, attention_strip_height, platform_inset_left_px, titlebar,
};

use crate::{
	damage::LaidOut,
	intent::{Intent, Intents},
	keymap::Keymap,
	layout::LabelState,
	model::ShellState,
	queue::{RailMotion, RowMenu},
	tokens::InstalledTokens,
};

/// The window's root view.
pub struct ShellView {
	installed:      InstalledTokens,
	state:          ShellState,
	notice:         Option<String>,
	intents:        Intents,
	/// What the last frame settled the composer's labels on. Carried because
	/// the decision has hysteresis, so it is a function of the previous frame
	/// as well as of this width (§5.4).
	labels:         LabelState,
	/// Where the last frame laid each region out, for a repaint scoped to
	/// the regions a state change touched (P5).
	laid_out:       LaidOut,
	keymap:         Keymap,
	composer:       Option<Entity<Editor>>,
	composer_cache: String,
	palette_input:  palette::PaletteInput,
	submitted:      Option<composer::SubmittedDraft>,
	/// What the composer draws that is the window's: the drop target and
	/// the refusal line.
	attach:         AttachState,
	rail_motion:    RailMotion,
	/// The queue row menu that is open, if one is (§5.1). Window-local,
	/// like a hover: a snapshot never reopens one.
	row_menu:       Option<RowMenu>,
	/// The width the operator dragged the docked right panel to. Window-local
	/// like the row menu: a snapshot never moves the handle (§5.6).
	panel_width:    Option<f32>,
	focus_handle:   Option<FocusHandle>,
	now_ms:         u64,
	subscriptions:  Vec<Subscription>,
}

impl ShellView {
	/// Builds the root view from an installed token set and a state to draw.
	pub fn new(installed: InstalledTokens, state: ShellState) -> Self {
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
			palette_input: palette::PaletteInput::default(),
			submitted: None,
			attach: AttachState::default(),
			rail_motion: RailMotion::new(),
			row_menu: None,
			panel_width: None,
			focus_handle: None,
			now_ms: 0,
			subscriptions: Vec::new(),
		}
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

	/// Sets the clock time in milliseconds for relative time computations.
	pub const fn set_clock_ms(&mut self, now_ms: u64) {
		self.now_ms = now_ms;
	}

	/// Returns the current clock time in milliseconds.
	#[must_use]
	pub const fn clock_ms(&self) -> u64 {
		self.now_ms
	}

	/// Returns true if an attention notice is active.
	#[must_use]
	pub const fn has_notice(&self) -> bool {
		self.notice.is_some()
	}

	/// Returns the attention notice text if set.
	#[must_use]
	pub fn notice(&self) -> Option<&str> {
		self.notice.as_deref()
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

	/// Returns the current composer text content.
	#[must_use]
	pub fn composer_text(&self) -> &str {
		&self.composer_cache
	}

	/// Returns true if the composer contains non-whitespace text characters.
	#[must_use]
	pub fn has_composer_text(&self) -> bool {
		!self.composer_cache.trim().is_empty()
	}

	/// Lazily creates and returns the composer editor entity.
	pub fn ensure_composer(&mut self, cx: &mut Context<Self>) -> Entity<Editor> {
		if let Some(ed) = &self.composer {
			return ed.clone();
		}

		let editor = cx.new(|cx| {
			Editor::new(EditorMode::Multiline { newline_on_enter: false }, cx)
				.placeholder("Ask, or describe a change")
				.max_visible_lines(8)
		});

		let sub = cx.subscribe(&editor, |this, ed, event: &EditorEvent, cx| match event {
			EditorEvent::Submit => {
				this.submit_primary_turn_action(cx);
			},
			EditorEvent::Escape => {
				if this
					.state
					.overlay
					.as_ref()
					.and_then(crate::Overlay::as_palette)
					.is_some()
				{
					this.close_palette(cx);
					return;
				}
				if !this.state.cards.is_empty() {
					this.state.cards.remove(0);
					cx.notify();
				}
			},
			EditorEvent::Changed => {
				this.composer_cache = ed.read(cx).text().to_string();
				this.update_slash_palette(cx);
				cx.notify();
			},
			EditorEvent::PasteMedia(item) => this.attach_clipboard(item, cx),
		});

		self.composer = Some(editor.clone());
		self.subscriptions.push(sub);
		editor
	}

	/// Sets the composer text content.
	pub fn set_composed(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
		let text = text.into();
		self.composer_cache.clone_from(&text);
		let ed = self.ensure_composer(cx);
		ed.update(cx, |editor, cx| {
			editor.set_text(text, cx);
		});
	}

	/// Takes and clears the composer text content.
	pub fn take_composed(&mut self, cx: &mut Context<Self>) -> String {
		self.composer_cache.clear();
		if let Some(ed) = &self.composer {
			ed.update(cx, |editor, cx| editor.take_text(cx))
		} else {
			String::new()
		}
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

	/// Sets or clears the attention strip's message.
	///
	/// A reload that failed keeps the last good token set and reports the
	/// failure here, so the window stays usable and the operator still learns
	/// that the file they just saved was rejected.
	pub fn set_notice(&mut self, notice: Option<String>) {
		self.notice = notice;
	}

	/// Applies what the operator did, and records what a host must answer.
	///
	/// Every surface reaches the state through here and through nothing else,
	/// so what an interaction does is decided in one place rather than in each
	/// click handler.
	pub fn dispatch(&mut self, intent: Intent, cx: &mut Context<Self>) {
		if !self.composer_action_allowed(&intent) {
			return;
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
}

impl Render for ShellView {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		render::render_shell(self, window, cx)
	}
}
