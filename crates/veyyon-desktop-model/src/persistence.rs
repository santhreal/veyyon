use std::collections::{BTreeSet, HashMap};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
	composer::QueueMode,
	connection::{EntryId, SessionId},
};

/// Persistence error identifying corrupted, truncated, or incompatible state
/// files.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PersistenceError {
	#[error("version mismatch: expected {expected}, found {found}")]
	VersionMismatch { expected: u32, found: u32 },
	#[error("deserialization failed: {0}")]
	DeserializationFailed(String),
	#[error("truncated payload")]
	TruncatedPayload,
}

/// Trait implemented by persisted domain stores enforcing single-version
/// compatibility.
pub trait VersionedStore: Sized {
	const CURRENT_VERSION: u32 = 1;

	fn version(&self) -> u32;
}

/// Window geometry, placement, and display assignment settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowStore {
	pub version:    u32,
	pub x:          i32,
	pub y:          i32,
	pub width:      u32,
	pub height:     u32,
	pub maximized:  bool,
	pub display_id: Option<String>,
}

impl Default for WindowStore {
	fn default() -> Self {
		Self {
			version:    Self::CURRENT_VERSION,
			x:          100,
			y:          100,
			width:      1200,
			height:     800,
			maximized:  false,
			display_id: None,
		}
	}
}

impl VersionedStore for WindowStore {
	fn version(&self) -> u32 {
		self.version
	}
}

/// Root shell layout parameters and active session pointer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShellStore {
	pub version:         u32,
	pub queue_width:     u32,
	pub queue_collapsed: bool,
	pub active_session:  Option<SessionId>,
}

impl Default for ShellStore {
	fn default() -> Self {
		Self {
			version:         Self::CURRENT_VERSION,
			queue_width:     256,
			queue_collapsed: false,
			active_session:  None,
		}
	}
}

impl VersionedStore for ShellStore {
	fn version(&self) -> u32 {
		self.version
	}
}

/// Right panel and terminal drawer state for a specific session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PanelsStore {
	pub version:             u32,
	pub right_panel_visible: bool,
	pub right_panel_width:   u32,
	pub drawer_visible:      bool,
	pub drawer_height:       u32,
	pub open_right_tabs:     Vec<String>,
	pub active_right_tab:    Option<String>,
	pub open_drawer_tabs:    Vec<String>,
	pub active_drawer_tab:   Option<String>,
	pub diff_mode_split:     bool,
}

impl Default for PanelsStore {
	fn default() -> Self {
		Self {
			version:             Self::CURRENT_VERSION,
			right_panel_visible: false,
			right_panel_width:   540,
			drawer_visible:      false,
			drawer_height:       280,
			open_right_tabs:     Vec::new(),
			active_right_tab:    None,
			open_drawer_tabs:    Vec::new(),
			active_drawer_tab:   None,
			diff_mode_split:     false,
		}
	}
}

impl VersionedStore for PanelsStore {
	fn version(&self) -> u32 {
		self.version
	}
}

/// Transcript scroll anchor and collapsible block configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TranscriptStore {
	pub version:              u32,
	pub scroll_anchor_entry:  Option<EntryId>,
	pub scroll_anchor_offset: f32,
	pub collapsed_block_ids:  BTreeSet<String>,
}

impl Default for TranscriptStore {
	fn default() -> Self {
		Self {
			version:              Self::CURRENT_VERSION,
			scroll_anchor_entry:  None,
			scroll_anchor_offset: 0.0,
			collapsed_block_ids:  BTreeSet::new(),
		}
	}
}

impl VersionedStore for TranscriptStore {
	fn version(&self) -> u32 {
		self.version
	}
}

/// Persisted composer input buffer and dispatch settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComposerStore {
	pub version:     u32,
	pub draft_text:  String,
	pub attachments: Vec<String>,
	pub queue_mode:  QueueMode,
}

impl Default for ComposerStore {
	fn default() -> Self {
		Self {
			version:     Self::CURRENT_VERSION,
			draft_text:  String::new(),
			attachments: Vec::new(),
			queue_mode:  QueueMode::Steer,
		}
	}
}

impl VersionedStore for ComposerStore {
	fn version(&self) -> u32 {
		self.version
	}
}

/// Queue partition collapse state and pagination size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueueStore {
	pub version:            u32,
	pub deferred_collapsed: bool,
	pub parked_collapsed:   bool,
	pub parked_page_size:   u32,
}

impl Default for QueueStore {
	fn default() -> Self {
		Self {
			version:            Self::CURRENT_VERSION,
			deferred_collapsed: false,
			parked_collapsed:   false,
			parked_page_size:   25,
		}
	}
}

impl VersionedStore for QueueStore {
	fn version(&self) -> u32 {
		self.version
	}
}

/// Operator token overrides in raw TOML format.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokensStore {
	pub version:        u32,
	pub overrides_toml: String,
}

impl Default for TokensStore {
	fn default() -> Self {
		Self { version: Self::CURRENT_VERSION, overrides_toml: String::new() }
	}
}

impl VersionedStore for TokensStore {
	fn version(&self) -> u32 {
		self.version
	}
}

/// Container grouping all persisted client settings and layout caches.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PersistedState {
	pub window:      WindowStore,
	pub shell:       ShellStore,
	pub panels:      HashMap<SessionId, PanelsStore>,
	pub transcripts: HashMap<SessionId, TranscriptStore>,
	pub composer:    HashMap<SessionId, ComposerStore>,
	pub queue:       QueueStore,
	pub tokens:      TokensStore,
}

impl PersistedState {
	/// Creates an initialized persisted state container with default sub-stores.
	#[must_use]
	pub fn new() -> Self {
		Self {
			window:      WindowStore::default(),
			shell:       ShellStore::default(),
			panels:      HashMap::new(),
			transcripts: HashMap::new(),
			composer:    HashMap::new(),
			queue:       QueueStore::default(),
			tokens:      TokensStore::default(),
		}
	}
}

/// Validates serialized JSON and deserializes into a versioned store, rejecting
/// stale or malformed payloads.
pub fn validate_and_deserialize<T>(json_str: &str) -> Result<T, PersistenceError>
where
	T: VersionedStore + serde::de::DeserializeOwned,
{
	let trimmed = json_str.trim();
	if trimmed.is_empty() || (!trimmed.ends_with('}') && !trimmed.ends_with(']')) {
		return Err(PersistenceError::TruncatedPayload);
	}

	let value: T = serde_json::from_str(trimmed)
		.map_err(|e| PersistenceError::DeserializationFailed(e.to_string()))?;

	if value.version() != T::CURRENT_VERSION {
		return Err(PersistenceError::VersionMismatch {
			expected: T::CURRENT_VERSION,
			found:    value.version(),
		});
	}

	Ok(value)
}

/// Loads a versioned store from serialized JSON or returns the default value
/// alongside any encountered error.
#[must_use]
pub fn load_or_default<T>(json_str: &str) -> (T, Option<PersistenceError>)
where
	T: VersionedStore + Default + serde::de::DeserializeOwned,
{
	match validate_and_deserialize::<T>(json_str) {
		Ok(store) => (store, None),
		Err(err) => (T::default(), Some(err)),
	}
}
