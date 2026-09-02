//! The desktop front end keyboard model and keymap (§5.14).
//!
//! Loads `keymap.toml`, derives GPUI `KeyBinding` records, validates operator
//! overrides from `KeybindingView`, and registers global and region action
//! handlers.

pub mod actions;
pub mod overrides;
pub mod table;

pub use actions::{Command, Scope, ScrollBy};
pub use overrides::OverrideReport;
pub use table::{DEFAULT_KEYMAP_TOML, Keymap, KeymapError, KeymapRow, resolve_chord};

/// State owned by the keymap subsystem held on `ShellState` (Contract item 1).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeymapState {
	/// Whether the queue rail has been collapsed via keyboard chord.
	pub queue_collapsed:         bool,
	/// Whether the right panel has been collapsed via keyboard chord.
	pub panel_collapsed:         bool,
	/// Active filter query applied to the queue rail.
	pub queue_filter:            Option<String>,
	/// Pending transcript scroll request.
	pub transcript_scroll:       Option<ScrollBy>,
	/// Whether the in-transcript search input is open.
	pub find_open:               bool,
	/// Currently focused transcript turn index.
	pub focused_turn:            Option<usize>,
	/// Whether the focused block inside an assistant turn is collapsed.
	pub focused_block_collapsed: bool,
	/// Last applied queue selection delta.
	pub selection_delta:         i32,
	/// Last session id pinned via keyboard.
	pub pinned_session:          Option<u64>,
	/// Last session id deferred via keyboard.
	pub deferred_session:        Option<u64>,
	/// Last session id parked via keyboard.
	pub parked_session:          Option<u64>,
}
