//! Scene registry, runtime enumeration, and catalogue completeness validation.
//!
//! The required scene set is derived programmatically from protocol enums via
//! `strum::IntoEnumIterator`. A state with no registered scene fails
//! completeness validation, preventing UI states from shipping unverified.

use std::collections::{BTreeMap, BTreeSet};

use strum::IntoEnumIterator;
pub use veyyon_desktop_kit::PrimitiveKind;
// `ConnectionStateKind` is the model's own fieldless projection of `ConnectionState`,
// re-exported so a consumer of this crate still names one type. A copy declared here would not
// grow when the protocol does, which is the staleness this catalogue exists to catch.
pub use veyyon_desktop_model::ConnectionStateKind;
use veyyon_desktop_model::{
	BadgeKind, BlockKind, Capability, ErrorScope, MessageRole, QueuePartition,
};

/// Control capability gate availability variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, strum::EnumIter)]
pub enum GateVariant {
	Enabled,
	Pending,
	Unavailable,
	Unknown,
}

/// Row visual presentation shapes in the queue surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, strum::EnumIter)]
pub enum RowShape {
	Card,
	Line,
}

/// Converts a `PascalCase` identifier to a lowercase kebab-case slug.
fn to_kebab_case(s: &str) -> String {
	let mut result = String::with_capacity(s.len() + 4);
	for (i, ch) in s.chars().enumerate() {
		if ch.is_uppercase() {
			if i != 0 {
				result.push('-');
			}
			for lower in ch.to_lowercase() {
				result.push(lower);
			}
		} else {
			result.push(ch);
		}
	}
	result
}

/// Identifies a required state derived from protocol state enumerations.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum RequiredState {
	Connection(ConnectionStateKind),
	CapabilityGate { capability: Capability, gate: GateVariant },
	Role(MessageRole),
	Block(BlockKind),
	Error(ErrorScope),
	Badge(BadgeKind),
	Section(QueuePartition),
	RowShape(RowShape),
	Primitive(PrimitiveKind),
}

impl RequiredState {
	/// Returns the surface identifier this state belongs to.
	#[must_use]
	pub const fn surface(&self) -> &'static str {
		match self {
			Self::Connection(_) => "shell",
			Self::CapabilityGate { .. } => "capability-gate",
			Self::Role(_) => "transcript-role",
			Self::Block(_) => "transcript-block",
			Self::Error(_) => "error-scope",
			Self::Badge(_) => "queue-badge",
			Self::Section(_) => "queue-section",
			Self::RowShape(_) => "queue-row",
			Self::Primitive(_) => "kit",
		}
	}

	/// Returns the state name slug.
	#[must_use]
	pub fn state_name(&self) -> String {
		match self {
			Self::Connection(k) => format!("connection-{}", to_kebab_case(&format!("{k:?}"))),
			Self::CapabilityGate { capability, gate } => {
				format!(
					"{}-{}",
					to_kebab_case(&format!("{capability:?}")),
					to_kebab_case(&format!("{gate:?}"))
				)
			},
			Self::Role(r) => to_kebab_case(&format!("{r:?}")),
			Self::Block(b) => to_kebab_case(&format!("{b:?}")),
			Self::Error(e) => to_kebab_case(&format!("{e:?}")),
			Self::Badge(b) => to_kebab_case(&format!("{b:?}")),
			Self::Section(s) => to_kebab_case(&format!("{s:?}")),
			Self::RowShape(r) => to_kebab_case(&format!("{r:?}")),
			Self::Primitive(p) => to_kebab_case(&format!("{p:?}")),
		}
	}

	/// Returns the canonical scene identifier in `surface/state` format.
	#[must_use]
	pub fn scene_name(&self) -> String {
		format!("{}/{}", self.surface(), self.state_name())
	}
}

/// Derives the complete set of required states from protocol enums.
#[must_use]
pub fn required_states() -> Vec<RequiredState> {
	let mut states = Vec::with_capacity(190);
	states.extend(ConnectionStateKind::iter().map(RequiredState::Connection));
	for capability in Capability::iter() {
		for gate in GateVariant::iter() {
			states.push(RequiredState::CapabilityGate { capability, gate });
		}
	}
	states.extend(MessageRole::iter().map(RequiredState::Role));
	states.extend(BlockKind::iter().map(RequiredState::Block));
	states.extend(ErrorScope::iter().map(RequiredState::Error));
	states.extend(BadgeKind::iter().map(RequiredState::Badge));
	states.extend(QueuePartition::iter().map(RequiredState::Section));
	states.extend(RowShape::iter().map(RequiredState::RowShape));
	states.extend(PrimitiveKind::iter().map(RequiredState::Primitive));
	states
}

/// State descriptor associated with a scene.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum StateDescriptor {
	Required(RequiredState),
	Custom { surface: String, state: String },
}

/// Strategy for fixture selection when constructing a scene.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub enum FixtureSelection {
	#[default]
	Typical,
	Extreme,
	Seed(u64),
	Custom(String),
}

/// Stable scene identifier and metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scene {
	pub name:              String,
	pub surface:           String,
	pub state:             StateDescriptor,
	pub fixture_selection: FixtureSelection,
}

impl Scene {
	/// Creates a new scene descriptor after validating name format.
	pub fn new(
		name: impl Into<String>,
		surface: impl Into<String>,
		state: StateDescriptor,
		fixture_selection: FixtureSelection,
	) -> Result<Self, SceneError> {
		let name_str = name.into();
		validate_scene_name(&name_str)?;
		Ok(Self { name: name_str, surface: surface.into(), state, fixture_selection })
	}
}

/// Validates that a scene name adheres to `surface/state` lowercase kebab
/// format.
fn validate_scene_name(name: &str) -> Result<(), SceneError> {
	let mut parts = name.split('/');
	let surface = parts.next();
	let state = parts.next();
	let extra = parts.next();

	if extra.is_some() || surface.is_none() || state.is_none() {
		return Err(SceneError::InvalidSceneName(name.to_string()));
	}

	let surface_str = match surface {
		Some(s) if !s.is_empty() => s,
		_ => return Err(SceneError::InvalidSceneName(name.to_string())),
	};
	let state_str = match state {
		Some(s) if !s.is_empty() => s,
		_ => return Err(SceneError::InvalidSceneName(name.to_string())),
	};

	let is_valid = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-';
	if !surface_str.chars().all(is_valid) || !state_str.chars().all(is_valid) {
		return Err(SceneError::InvalidSceneName(name.to_string()));
	}
	Ok(())
}

/// Registry error variants for scene operations and completeness validation.
#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum SceneError {
	#[error("duplicate scene name: {0}")]
	DuplicateScene(String),
	#[error("invalid scene name: {0}")]
	InvalidSceneName(String),
	#[error("catalogue is missing required scenes: {0:?}")]
	MissingScenes(Vec<String>),
}

/// In-memory catalogue of registered deterministic scenes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneRegistry {
	scenes: BTreeMap<String, Scene>,
}

impl Default for SceneRegistry {
	fn default() -> Self {
		Self::new()
	}
}

impl SceneRegistry {
	/// Creates a new scene registry pre-populated with standard scenes covering
	/// all required states.
	#[must_use]
	pub fn new() -> Self {
		let mut registry = Self::empty();
		for state in required_states() {
			let name = state.scene_name();
			let surface = state.surface().to_string();
			let scene = Scene {
				name: name.clone(),
				surface,
				state: StateDescriptor::Required(state),
				fixture_selection: FixtureSelection::Typical,
			};
			let _ = registry.scenes.insert(name, scene);
		}

		let additional = [
			("queue-card/approval", "queue-card"),
			("queue-card/working", "queue-card"),
			("queue-card/watching", "queue-card"),
			("queue-card/rest", "queue-card"),
			("queue-line/approval", "queue-line"),
			("queue-line/working", "queue-line"),
			("queue-line/rest", "queue-line"),
			("section-header/rest", "section-header"),
			("composer/rest", "composer"),
			("composer/footer", "composer"),
			("opening-line/rest", "opening-line"),
			("run-bar/rest", "run-bar"),
			("palette/rest", "palette"),
			("settings-row/rest", "settings-row"),
			("shell/auth-needs-secret", "shell"),
			("shell/auth-awaiting-external-url", "shell"),
		];

		for (name, surface) in additional {
			let state_part = name
				.strip_prefix(surface)
				.and_then(|s| s.strip_prefix('/'))
				.unwrap_or("rest");
			let scene = Scene {
				name:              name.to_string(),
				surface:           surface.to_string(),
				state:             StateDescriptor::Custom {
					surface: surface.to_string(),
					state:   state_part.to_string(),
				},
				fixture_selection: FixtureSelection::Typical,
			};
			let _ = registry.scenes.insert(name.to_string(), scene);
		}
		registry
	}

	/// Creates an empty scene registry with no registered scenes.
	#[must_use]
	pub const fn empty() -> Self {
		Self { scenes: BTreeMap::new() }
	}

	/// Registers a new scene in the registry, returning an error on duplicate or
	/// invalid names.
	pub fn register(&mut self, scene: Scene) -> Result<(), SceneError> {
		validate_scene_name(&scene.name)?;
		if self.scenes.contains_key(&scene.name) {
			return Err(SceneError::DuplicateScene(scene.name));
		}
		self.scenes.insert(scene.name.clone(), scene);
		Ok(())
	}

	/// Looks up a scene by exact name.
	#[must_use]
	pub fn get(&self, name: &str) -> Option<&Scene> {
		self.scenes.get(name)
	}

	/// Removes a scene by name, returning whether it was present.
	pub fn remove(&mut self, name: &str) -> Option<Scene> {
		self.scenes.remove(name)
	}

	/// Returns the number of registered scenes.
	#[must_use]
	pub fn len(&self) -> usize {
		self.scenes.len()
	}

	/// Returns true if the registry contains no scenes.
	#[must_use]
	pub fn is_empty(&self) -> bool {
		self.scenes.is_empty()
	}

	/// Returns an iterator over all registered scenes.
	pub fn iter(&self) -> impl Iterator<Item = &Scene> {
		self.scenes.values()
	}

	/// Searches registered scenes matching a glob pattern.
	#[must_use]
	pub fn find_glob(&self, pattern: &str) -> Vec<&Scene> {
		if pattern == "*" {
			return self.scenes.values().collect();
		}
		if let Some(prefix) = pattern.strip_suffix('*') {
			if let Some(suffix) = prefix.strip_prefix('*') {
				return self
					.scenes
					.values()
					.filter(|s| s.name.contains(suffix))
					.collect();
			}
			return self
				.scenes
				.values()
				.filter(|s| s.name.starts_with(prefix))
				.collect();
		}
		if let Some(suffix) = pattern.strip_prefix('*') {
			return self
				.scenes
				.values()
				.filter(|s| s.name.ends_with(suffix))
				.collect();
		}
		self.get(pattern).into_iter().collect()
	}

	/// Identifies all required protocol states that lack a registered scene.
	#[must_use]
	pub fn missing_states(&self) -> Vec<RequiredState> {
		let registered_names: BTreeSet<&str> = self.scenes.keys().map(String::as_str).collect();
		required_states()
			.into_iter()
			.filter(|state| !registered_names.contains(state.scene_name().as_str()))
			.collect()
	}

	/// Identifies all required scene names that lack a registered scene.
	#[must_use]
	pub fn missing_scenes(&self) -> Vec<String> {
		self
			.missing_states()
			.into_iter()
			.map(|state| state.scene_name())
			.collect()
	}

	/// Validates that every required state derived from the protocol enums is
	/// present.
	pub fn validate_completeness(&self) -> Result<(), SceneError> {
		let missing = self.missing_scenes();
		if missing.is_empty() {
			Ok(())
		} else {
			Err(SceneError::MissingScenes(missing))
		}
	}
}
