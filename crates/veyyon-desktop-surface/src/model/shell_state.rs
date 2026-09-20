//! The state one shell render draws (§5.1-§5.14).
//!
//! Every surface reads its own slice of this: the queue reads `sections`, the
//! transcript reads `transcript`, the composer reads `composer` and `turn`.
//! Held apart from the view models in `model.rs` so the shape a frame is
//! handed is one file, and each field states which section owns it.

use veyyon_desktop_model::Notification;

use super::{
	AppearanceChoice, Badge, Card, CardAnswers, ComposerState, ConnectionPhase, ControlStates,
	DrawerContent, KeymapState, Overlay, PaletteState, PanelContent, Row, Section, SettingsState,
	Turn, TurnPhase,
};
use crate::{HostCommands, PaletteMode, menu::MenuState};

/// Everything one shell render draws.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellState {
	/// The window title: the open session's name.
	pub title:              String,
	/// Window-local spaces and stable host session tabs.
	pub navigation:         veyyon_desktop_model::persistence::NavigationStore,
	/// A host activation is awaiting acknowledgement; the displayed draft stays
	/// here.
	pub navigation_pending: bool,
	/// Tab labels and draft markers projected without changing host identity.
	pub session_tabs:       Vec<(veyyon_desktop_model::SessionId, String, bool)>,
	/// The queue's sections and their rows.
	pub sections:           Vec<(Section, Vec<Row>)>,
	/// The open session's transcript.
	pub transcript:         Vec<Turn>,
	/// The transcript entry each turn was opened by, index-aligned with
	/// `transcript`.
	///
	/// A turn is what the operator reads and an entry is what the host
	/// reports, and one turn merges every entry the agent produced, so the
	/// entry that opened it is the id a remembered reading position names
	/// (§8.10). Empty for a fixture that states turns without a host.
	pub turn_anchors:       Vec<String>,
	/// The active conversational turn phase.
	pub turn:               TurnPhase,
	/// The composer's footer: model, thinking level, queue mode, attachments
	/// and the context meter, as the host reported them (§5.4).
	pub composer:           ComposerState,
	/// The run bar's status line.
	pub run_status:         Option<(Badge, String)>,
	/// The right panel's content and tabs (§5.6, §5.11).
	pub panel:              PanelContent,
	/// Decisions attached above the composer.
	pub cards:              Vec<Card>,
	/// Whether each kind of decision can be answered, which is what a card's
	/// answer rows are gated by.
	pub card_answers:       CardAnswers,
	/// The open session's goal, if one is running.
	pub goal:               Option<veyyon_desktop_model::GoalView>,
	/// Whether the goal card is open above the composer.
	pub goal_card_open:     bool,
	/// Terminal drawer state and tenants.
	pub drawer:             DrawerContent,
	/// Whether the terminal drawer is open.
	pub drawer_open:        bool,
	/// The open session.
	pub current_id:         u64,
	/// Active transport connectivity phase or authentication overlay state.
	pub connection:         ConnectionPhase,
	/// How long the host has held every agent frozen, absent while they run
	/// (§4.1).
	///
	/// Process-wide rather than the open session's, so the strip that states
	/// it sits above every surface the window draws. The duration is what the
	/// strip prints, resolved where every other elapsed label is and moved by
	/// the same clock tick, so one freeze reads the same as one working row.
	pub paused:             Option<String>,
	/// Control availability and error states for capability gate resolution.
	pub controls:           ControlStates,
	/// Modal floating overlay currently active (Palette or Settings).
	pub overlay:            Option<Overlay>,
	/// Keymap and keyboard navigation state (§5.14).
	pub keymap:             KeymapState,
	/// Whether the operator has turned structural motion off, which the
	/// window reads off `display.transitions` and every motion driver
	/// resolves against (§7.2).
	pub reduced_motion:     bool,
	/// The appearance the window draws in, and the one the pointer is resting
	/// on while the appearance page is open (§6.9).
	pub appearance:         AppearanceChoice,
	/// Which menu the bar has open, where the keyboard is inside it, and
	/// which of its verbs the host declined.
	pub menu:               MenuState,
	/// The announcements waiting to be read, newest first, as the host's
	/// queue holds them (§5.15).
	///
	/// The window draws the stack from this and nothing else: an
	/// announcement is raised, deduped, expired and bounded in the model, so
	/// what one frame shows is what the queue holds at that moment.
	pub notices:            Vec<Notification>,
	/// What the host states this workspace can run (§5.8).
	///
	/// Held whether or not a command surface is open, because a palette is
	/// opened by a keystroke and the catalogue arrives with a host event:
	/// a window that composed its rows only while one was open would list
	/// what the binary was built knowing until the next unrelated event.
	pub commands:           HostCommands,
}

impl ShellState {
	/// Lists the host's commands on a command surface as it opens.
	///
	/// The window's own rows are already on it, and the host's go after
	/// them, so a command this workspace installed is reachable from the
	/// keystroke that opened the surface rather than from the next host
	/// event (§5.8).
	pub fn list_host_commands(&self, palette: &mut PaletteState) {
		if self.commands.rows.is_empty() {
			return;
		}
		let mut items = palette.items().to_vec();
		items.extend(self.commands.rows.iter().cloned());
		palette.set_items(items);
	}
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

	/// The rows the rail lists, in rail order, with the queue filter applied.
	///
	/// The row an arrow steps to and the row the cursor is allowed to sit on
	/// are read from here, so the two cannot disagree about what is listed.
	pub fn listed_rows(&self) -> impl Iterator<Item = &Row> {
		let needle = self
			.keymap
			.queue_filter
			.as_ref()
			.map(|filter| filter.trim().to_lowercase())
			.filter(|needle| !needle.is_empty());
		self
			.sections
			.iter()
			.flat_map(|(_, rows)| rows.iter())
			.filter(move |row| {
				needle.as_ref().is_none_or(|needle| {
					row.title.to_lowercase().contains(needle)
						|| row.subtitle.to_lowercase().contains(needle)
				})
			})
	}

	/// The row the rail's selection cursor is on (§5.14).
	///
	/// The cursor starts on the open session and moves under the arrows
	/// without opening anything, so this is what `Enter`, `P`, `D` and `K`
	/// act on and what the rail scrolls to. It is `current_id` while no arrow
	/// has moved it, and `0` when no session is open and none is listed.
	///
	/// A cursor the rail no longer lists — a row a filter hid, a session the
	/// host removed — falls back to the open session, so a press cannot act
	/// on a row that is not drawn.
	pub fn selected_row(&self) -> u64 {
		self
			.keymap
			.queue_cursor
			.filter(|&id| self.listed_rows().any(|row| row.id == id))
			.unwrap_or(self.current_id)
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
			title:              "veyyon".to_string(),
			navigation:         veyyon_desktop_model::persistence::NavigationStore::default(),
			navigation_pending: false,
			session_tabs:       Vec::new(),
			sections:           Vec::new(),
			transcript:         Vec::new(),
			turn_anchors:       Vec::new(),
			turn:               TurnPhase::default(),
			composer:           ComposerState::default(),
			run_status:         None,
			panel:              PanelContent::default(),
			cards:              Vec::new(),
			card_answers:       CardAnswers::default(),
			goal:               None,
			goal_card_open:     false,
			drawer:             DrawerContent::default(),
			drawer_open:        false,
			current_id:         0,
			connection:         ConnectionPhase::default(),
			paused:             None,
			controls:           ControlStates::default(),
			overlay:            None,
			keymap:             KeymapState::default(),
			reduced_motion:     false,
			appearance:         AppearanceChoice::default(),
			menu:               MenuState::default(),
			notices:            Vec::new(),
			commands:           HostCommands::default(),
		}
	}
}
