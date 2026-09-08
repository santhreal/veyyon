//! The state one shell render draws (§5.1-§5.14).
//!
//! Every surface reads its own slice of this: the queue reads `sections`, the
//! transcript reads `transcript`, the composer reads `composer` and `turn`.
//! Held apart from the view models in `model.rs` so the shape a frame is
//! handed is one file, and each field states which section owns it.

use super::{
	Badge, Card, ComposerState, ConnectionPhase, ControlStates, DrawerContent, KeymapState, Overlay,
	PaletteState, PanelContent, Row, Section, SettingsState, Turn, TurnPhase,
};
use crate::PaletteMode;

/// Everything one shell render draws.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellState {
	/// The window title: the open session's name.
	pub title:        String,
	/// The queue's sections and their rows.
	pub sections:     Vec<(Section, Vec<Row>)>,
	/// The open session's transcript.
	pub transcript:   Vec<Turn>,
	/// The transcript entry each turn was opened by, index-aligned with
	/// `transcript`.
	///
	/// A turn is what the operator reads and an entry is what the host
	/// reports, and one turn merges every entry the agent produced, so the
	/// entry that opened it is the id a remembered reading position names
	/// (§8.10). Empty for a fixture that states turns without a host.
	pub turn_anchors: Vec<String>,
	/// The active conversational turn phase.
	pub turn:         TurnPhase,
	/// The composer's footer: model, thinking level, queue mode, attachments
	/// and the context meter, as the host reported them (§5.4).
	pub composer:     ComposerState,
	/// The run bar's status line.
	pub run_status:   Option<(Badge, String)>,
	/// The right panel's content and tabs (§5.6, §5.11).
	pub panel:        PanelContent,
	/// Decisions attached above the composer.
	pub cards:        Vec<Card>,
	/// Terminal drawer state and tenants.
	pub drawer:       DrawerContent,
	/// Whether the terminal drawer is open.
	pub drawer_open:  bool,
	/// The open session.
	pub current_id:   u64,
	/// Active transport connectivity phase or authentication overlay state.
	pub connection:   ConnectionPhase,
	/// Control availability and error states for capability gate resolution.
	pub controls:     ControlStates,
	/// Modal floating overlay currently active (Palette or Settings).
	pub overlay:      Option<Overlay>,
	/// Keymap and keyboard navigation state (§5.14).
	pub keymap:       KeymapState,
}

impl ShellState {
	/// The row with this id, in whatever section holds it.
	///
	/// A row's identity is the session's, not its position, because a section
	/// re-sorts under the operator and a position taken before a click is not
	/// the row that was clicked.
	pub fn row(&self, id: u64) -> Option<&Row> {
		self
			.sections
			.iter()
			.flat_map(|(_, rows)| rows.iter())
			.find(|row| row.id == id)
	}

	/// The mutable row with this id, in whatever section holds it.
	pub fn row_mut(&mut self, id: u64) -> Option<&mut Row> {
		self
			.sections
			.iter_mut()
			.flat_map(|(_, rows)| rows.iter_mut())
			.find(|row| row.id == id)
	}

	/// The section holding the row with this id.
	///
	/// A partition move reads it first: parking a session that is already
	/// parked unparks it, which is what the `queue` chords and the row menu
	/// both mean by park, defer and pin (§5.14).
	pub fn section_of(&self, id: u64) -> Option<Section> {
		self
			.sections
			.iter()
			.find(|(_, rows)| rows.iter().any(|row| row.id == id))
			.map(|(section, _)| *section)
	}

	/// Returns the palette state if a palette overlay is open.
	#[must_use]
	pub fn overlay_palette(&self) -> Option<&PaletteState> {
		self.overlay.as_ref().and_then(Overlay::as_palette)
	}

	/// Returns a mutable reference to the palette state if a palette overlay is
	/// open.
	#[must_use]
	pub fn overlay_palette_mut(&mut self) -> Option<&mut PaletteState> {
		self.overlay.as_mut().and_then(Overlay::as_palette_mut)
	}

	/// Runs `edit` against the palette in `mode`, opening one when the overlay
	/// holds anything else: a command row that asks a mode for its rows is run
	/// from another mode's list, and the run closes that list.
	pub fn palette_in(&mut self, mode: PaletteMode, edit: impl FnOnce(&mut PaletteState)) {
		match &mut self.overlay {
			Some(Overlay::Palette(palette)) if palette.mode == mode => edit(palette),
			slot => {
				let mut palette = PaletteState::new(mode);
				edit(&mut palette);
				*slot = Some(Overlay::Palette(palette));
			},
		}
	}

	/// Returns the settings state if a settings overlay is open.
	#[must_use]
	pub fn overlay_settings(&self) -> Option<&SettingsState> {
		self.overlay.as_ref().and_then(Overlay::as_settings)
	}

	/// Returns a mutable reference to the settings state if a settings overlay
	/// is open.
	#[must_use]
	pub fn overlay_settings_mut(&mut self) -> Option<&mut SettingsState> {
		self.overlay.as_mut().and_then(Overlay::as_settings_mut)
	}
}

impl Default for ShellState {
	fn default() -> Self {
		Self {
			title:        "veyyon".to_string(),
			sections:     Vec::new(),
			transcript:   Vec::new(),
			turn_anchors: Vec::new(),
			turn:         TurnPhase::default(),
			composer:     ComposerState::default(),
			run_status:   None,
			panel:        PanelContent::default(),
			cards:        Vec::new(),
			drawer:       DrawerContent::default(),
			drawer_open:  false,
			current_id:   0,
			connection:   ConnectionPhase::default(),
			controls:     ControlStates::default(),
			overlay:      None,
			keymap:       KeymapState::default(),
		}
	}
}
