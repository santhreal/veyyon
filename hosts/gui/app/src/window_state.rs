//! Versioned window state persistence document and atomic storage.
//!
//! Across relaunch, the app persists its open spaces, tabs, and layout in an
//! atomic document with a schema version. Stale document versions and payloads
//! referencing missing sessions are rejected with a typed error rather than
//! silently repaired.
use std::{
	fmt,
	path::Path,
	sync::atomic::{AtomicU64, Ordering},
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

use veyyon_gui_core::{
	Store,
	model::{SessionId, SpaceId},
	navigation::{BottomTab, InspectorTab, PanelState, Preferences, Space, SpacesState, Tab},
};

pub const WINDOW_STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowStateError {
	Io(String),
	Deserialize(String),
	Serialize(String),
	StaleVersion { expected: u32, actual: u32 },
	MissingSession { session: SessionId },
	NoSpacesSection,
}

impl fmt::Display for WindowStateError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Io(err) => write!(formatter, "I/O error: {err}"),
			Self::Deserialize(err) => write!(formatter, "deserialization error: {err}"),
			Self::Serialize(err) => write!(formatter, "serialization error: {err}"),
			Self::StaleVersion { expected, actual } => {
				write!(
					formatter,
					"stale window state document version: expected {expected}, found {actual}"
				)
			},
			Self::MissingSession { session } => {
				write!(
					formatter,
					"session '{session}' referenced in persisted space does not exist in known sessions"
				)
			},
			Self::NoSpacesSection => write!(formatter, "document has no spaces section"),
		}
	}
}

impl std::error::Error for WindowStateError {}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PersistedTab {
	pub session: SessionId,
}

impl From<&Tab> for PersistedTab {
	fn from(tab: &Tab) -> Self {
		Self { session: tab.session.clone() }
	}
}

impl From<&PersistedTab> for Tab {
	fn from(tab: &PersistedTab) -> Self {
		Self { session: tab.session.clone() }
	}
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PersistedSpace {
	pub id:            SpaceId,
	pub name:          String,
	pub tabs:          Vec<PersistedTab>,
	pub active_tab:    Option<usize>,
	pub panels:        PanelState,
	pub bottom_tab:    BottomTab,
	pub inspector_tab: InspectorTab,
}

impl From<&Space> for PersistedSpace {
	fn from(space: &Space) -> Self {
		Self {
			id:            space.id.clone(),
			name:          space.name.clone(),
			tabs:          space.tabs.iter().map(PersistedTab::from).collect(),
			active_tab:    space.active_tab,
			panels:        space.panels.clone(),
			bottom_tab:    space.bottom_tab,
			inspector_tab: space.inspector_tab,
		}
	}
}

impl From<&PersistedSpace> for Space {
	fn from(space: &PersistedSpace) -> Self {
		Self {
			id:            space.id.clone(),
			name:          space.name.clone(),
			tabs:          space.tabs.iter().map(Tab::from).collect(),
			active_tab:    space.active_tab,
			panels:        space.panels.clone(),
			bottom_tab:    space.bottom_tab,
			inspector_tab: space.inspector_tab,
		}
	}
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PersistedSpacesSection {
	pub spaces:       Vec<PersistedSpace>,
	pub active_space: usize,
}

impl From<&SpacesState> for PersistedSpacesSection {
	fn from(state: &SpacesState) -> Self {
		Self {
			spaces:       state.spaces.iter().map(PersistedSpace::from).collect(),
			active_space: state.active_space,
		}
	}
}

impl From<PersistedSpacesSection> for SpacesState {
	fn from(section: PersistedSpacesSection) -> Self {
		let spaces: Vec<Space> = section.spaces.iter().map(Space::from).collect();
		SpacesState::new(spaces, section.active_space)
	}
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PersistedPreferencesSection {
	pub preferences: Preferences,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct WindowStateDocument {
	pub version:     u32,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub spaces:      Option<PersistedSpacesSection>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub preferences: Option<PersistedPreferencesSection>,
}

impl WindowStateDocument {
	pub fn with_spaces(spaces: &SpacesState) -> Self {
		Self {
			version:     WINDOW_STATE_VERSION,
			spaces:      Some(PersistedSpacesSection::from(spaces)),
			preferences: None,
		}
	}
}

pub fn save_window_state(
	path: &Path,
	document: &WindowStateDocument,
) -> Result<(), WindowStateError> {
	let serialized = serde_json::to_string_pretty(document)
		.map_err(|err| WindowStateError::Serialize(err.to_string()))?;

	let parent = path.parent().unwrap_or_else(|| Path::new("."));
	std::fs::create_dir_all(parent).map_err(|err| WindowStateError::Io(err.to_string()))?;

	let count = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
	let temp_path = parent.join(format!(".window-state-{}-{count}.tmp", std::process::id()));
	std::fs::write(&temp_path, serialized.as_bytes())
		.map_err(|err| WindowStateError::Io(err.to_string()))?;
	std::fs::rename(&temp_path, path).map_err(|err| WindowStateError::Io(err.to_string()))?;

	Ok(())
}

pub fn load_window_state(path: &Path) -> Result<WindowStateDocument, WindowStateError> {
	let bytes = std::fs::read(path).map_err(|err| WindowStateError::Io(err.to_string()))?;
	let document: WindowStateDocument = serde_json::from_slice(&bytes)
		.map_err(|err| WindowStateError::Deserialize(err.to_string()))?;

	if document.version != WINDOW_STATE_VERSION {
		return Err(WindowStateError::StaleVersion {
			expected: WINDOW_STATE_VERSION,
			actual:   document.version,
		});
	}

	Ok(document)
}

pub fn restore_spaces_into_store(
	store: &mut Store,
	spaces_section: &PersistedSpacesSection,
	known_sessions: &[SessionId],
) -> Result<(), WindowStateError> {
	for space in &spaces_section.spaces {
		for tab in &space.tabs {
			if !known_sessions.contains(&tab.session) {
				return Err(WindowStateError::MissingSession { session: tab.session.clone() });
			}
		}
	}

	store.frontend.spaces = SpacesState::from(spaces_section.clone());
	if let Some(space) = store.frontend.spaces.active() {
		store.frontend.panels = space.panels.clone();
		store.frontend.bottom_tab = space.bottom_tab;
		store.frontend.inspector_tab = space.inspector_tab;
	}
	store.frontend.selected_session = store.frontend.spaces.active_session();
	Ok(())
}
