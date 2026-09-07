use std::collections::{BTreeSet, HashMap};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{composer::QueueMode, connection::SessionId};

mod document;

pub use document::{Rejection, StoreKind};

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
	#[error("serialization failed: {0}")]
	SerializationFailed(String),
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
	pub queue_collapsed: bool,
	pub active_session:  Option<SessionId>,
}

impl Default for ShellStore {
	fn default() -> Self {
		Self { version: Self::CURRENT_VERSION, queue_collapsed: false, active_session: None }
	}
}

impl VersionedStore for ShellStore {
	const CURRENT_VERSION: u32 = 2;

	fn version(&self) -> u32 {
		self.version
	}
}

/// Diff view layout mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffMode {
	/// Single column with inline additions and deletions.
	#[default]
	Unified,
	/// Side-by-side split columns for old and new content.
	Split,
}

/// Which of a session's two docked systems are open, how large they are, and
/// which tenant each one shows.
///
/// The tab a system shows is the operator's; the tabs it offers are not. A
/// right panel lists the tenants the host's capabilities allow and a drawer
/// lists the terminals the host reports, so a list of open tabs written here
/// would be re-derived on the next frame and could only disagree with it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PanelsStore {
	pub version:             u32,
	pub right_panel_visible: bool,
	/// The width the operator dragged the panel to, absent when they never
	/// dragged one. A width written for a window that never set one pins the
	/// panel at that measure and takes it out of the breakpoint ladder, so
	/// "never dragged" is a value here rather than the wide row's number.
	pub right_panel_width:   Option<u32>,
	pub drawer_visible:      bool,
	/// The height the operator dragged the drawer to, absent when they never
	/// dragged one.
	pub drawer_height:       Option<u32>,
	pub active_right_tab:    Option<String>,
	pub active_drawer_tab:   Option<String>,
	pub diff_mode:           DiffMode,
}

impl Default for PanelsStore {
	fn default() -> Self {
		Self {
			version:             Self::CURRENT_VERSION,
			right_panel_visible: false,
			right_panel_width:   None,
			drawer_visible:      false,
			drawer_height:       None,
			active_right_tab:    None,
			active_drawer_tab:   None,
			diff_mode:           DiffMode::default(),
		}
	}
}

impl VersionedStore for PanelsStore {
	const CURRENT_VERSION: u32 = 2;

	fn version(&self) -> u32 {
		self.version
	}
}

/// Where a session's transcript was left: which cards are disclosed and where
/// the operator was reading.
///
/// A block is addressed by the invocation's own `call_id` and the scroll
/// anchor by the entry id the top turn was opened by, both of which the host
/// reports and both of which survive the transcript being fetched again; a
/// turn and block index does not, because a session that pages in earlier
/// turns shifts every index after them. A session left at the live edge holds
/// no anchor, so it comes back at the live edge however far the turn ran on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TranscriptStore {
	pub version:           u32,
	pub expanded_call_ids: BTreeSet<String>,
	pub scroll_anchor:     Option<TranscriptAnchor>,
}

/// Where a transcript was scrolled to, as the entry the top turn was opened by
/// and the pixels the view starts past it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TranscriptAnchor {
	/// The transcript entry the turn at the top of the view was opened by.
	pub entry_id:  String,
	/// How far into that turn the view starts, in whole pixels.
	pub offset_px: u32,
}

impl Default for TranscriptStore {
	fn default() -> Self {
		Self {
			version:           Self::CURRENT_VERSION,
			expanded_call_ids: BTreeSet::new(),
			scroll_anchor:     None,
		}
	}
}

impl VersionedStore for TranscriptStore {
	const CURRENT_VERSION: u32 = 3;

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

/// Which of the queue's sections the operator collapsed, and how far the
/// parked section is paged in.
///
/// A set of section names rather than one flag per section: the rail collapses
/// every section it draws, so a pair of flags names two of them and goes stale
/// the moment the queue grows a sixth. The name is the section's own, so a
/// section this binary does not draw is dropped on load rather than reopening
/// one that is gone. The parked page is a count of pages and not a row count,
/// because the rows a page holds come from the queue's own tokens: a window
/// that reopens under a larger page draws that page's rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueueStore {
	pub version:            u32,
	pub collapsed_sections: BTreeSet<String>,
	pub parked_page:        u32,
}

impl Default for QueueStore {
	fn default() -> Self {
		Self {
			version:            Self::CURRENT_VERSION,
			collapsed_sections: BTreeSet::new(),
			parked_page:        1,
		}
	}
}

impl VersionedStore for QueueStore {
	const CURRENT_VERSION: u32 = 3;

	fn version(&self) -> u32 {
		self.version
	}
}

/// Container grouping all persisted client settings and layout caches.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PersistedState {
	pub window:      WindowStore,
	pub shell:       ShellStore,
	pub panels:      HashMap<SessionId, PanelsStore>,
	pub transcripts: HashMap<SessionId, TranscriptStore>,
	pub composer:    HashMap<SessionId, ComposerStore>,
	pub queue:       QueueStore,
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
		}
	}
}

/// The one field every persisted store shares, read ahead of the store's own
/// shape.
///
/// A stale payload is stale in its fields as well as its version: a field it
/// no longer has, or one it still has under an old name, fails the store's
/// `deny_unknown_fields` deserialization. Reading the version first reports
/// the stale copy as the version mismatch it is, not as a parse failure.
#[derive(Deserialize)]
struct VersionHeader {
	version: u32,
}

/// Names a parse failure for what it is.
///
/// A document that ends before its last value is closed is truncated, whatever
/// its final byte happens to be: a nested map ends in two braces, so a copy
/// missing one of them still ends in a brace. Serde reports that as an
/// end-of-input error, which is the only reliable way to tell a half-written
/// file from one holding a shape this binary does not write.
pub(crate) fn parse_error(error: serde_json::Error) -> PersistenceError {
	if error.is_eof() {
		PersistenceError::TruncatedPayload
	} else {
		PersistenceError::DeserializationFailed(error.to_string())
	}
}

/// Validates serialized JSON and deserializes into a versioned store, rejecting
/// stale or malformed payloads.
pub fn validate_and_deserialize<T>(json_str: &str) -> Result<T, PersistenceError>
where
	T: VersionedStore + serde::de::DeserializeOwned,
{
	let trimmed = json_str.trim();
	let header: VersionHeader = serde_json::from_str(trimmed).map_err(parse_error)?;
	if header.version != T::CURRENT_VERSION {
		return Err(PersistenceError::VersionMismatch {
			expected: T::CURRENT_VERSION,
			found:    header.version,
		});
	}

	let value: T = serde_json::from_str(trimmed).map_err(parse_error)?;

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
