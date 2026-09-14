//! Window-local tab membership and named layouts. Session identities are host
//! identities.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize, Serializer, ser::SerializeStruct};

use super::{ComposerStore, PanelsStore, QueueStore, VersionedStore};
use crate::SessionId;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpaceStore {
	pub id:              u64,
	pub name:            String,
	pub tabs:            Vec<SessionId>,
	pub selected:        Option<SessionId>,
	pub queue_collapsed: bool,
	pub queue:           QueueStore,
	pub panels:          HashMap<SessionId, PanelsStore>,
	/// Input retained while the space has no selected session.
	pub empty_draft:     ComposerStore,
}

impl SpaceStore {
	fn new(id: u64, name: String) -> Self {
		Self {
			id,
			name,
			tabs: Vec::new(),
			selected: None,
			queue_collapsed: false,
			empty_draft: ComposerStore::default(),
			queue: QueueStore::default(),
			panels: HashMap::new(),
		}
	}
}

/// An active space is stored directly, so even empty navigation has a layout.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "NavigationDocument")]
pub struct NavigationStore {
	active:      SpaceStore,
	others:      Vec<SpaceStore>,
	initialized: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NavigationDocument {
	active_space: u64,
	spaces:       Vec<SpaceStore>,
	initialized:  bool,
}

impl Serialize for NavigationStore {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		let mut document = serializer.serialize_struct("NavigationStore", 3)?;
		document.serialize_field("initialized", &self.initialized)?;
		document.serialize_field("active_space", &self.active.id)?;
		let spaces: Vec<_> = self.spaces().collect();
		document.serialize_field("spaces", &spaces)?;
		document.end()
	}
}

impl TryFrom<NavigationDocument> for NavigationStore {
	type Error = String;

	fn try_from(mut document: NavigationDocument) -> Result<Self, Self::Error> {
		let mut ids = HashSet::new();
		let mut names = HashSet::new();
		for space in &document.spaces {
			let tabs: HashSet<_> = space.tabs.iter().collect();
			if space.id == 0
				|| !ids.insert(space.id)
				|| space.name.trim().is_empty()
				|| space.name != space.name.trim()
				|| !names.insert(&space.name)
				|| tabs.len() != space.tabs.len()
				|| space.tabs.iter().any(|id| id.0.trim().is_empty())
				|| space.selected.as_ref().is_some_and(|id| !tabs.contains(id))
				|| (!space.tabs.is_empty() && space.selected.is_none())
				|| space.queue.version != QueueStore::CURRENT_VERSION
				|| space.empty_draft.version != ComposerStore::CURRENT_VERSION
				|| space
					.panels
					.values()
					.any(|panel| panel.version != PanelsStore::CURRENT_VERSION)
			{
				return Err("invalid space identity, tab selection, or layout version".into());
			}
		}
		document.spaces.sort_by_key(|space| space.id);
		let index = document
			.spaces
			.iter()
			.position(|space| space.id == document.active_space)
			.ok_or("active space is missing")?;
		let active = document.spaces.remove(index);
		Ok(Self { active, others: document.spaces, initialized: document.initialized })
	}
}

impl Default for NavigationStore {
	fn default() -> Self {
		Self {
			active:      SpaceStore::new(1, "Default".into()),
			others:      Vec::new(),
			initialized: false,
		}
	}
}

impl NavigationStore {
	/// Before the first navigation, the host's initial session is adopted.
	pub const fn is_initialized(&self) -> bool {
		self.initialized
	}

	#[must_use]
	pub const fn active(&self) -> &SpaceStore {
		&self.active
	}

	pub const fn active_mut(&mut self) -> &mut SpaceStore {
		&mut self.active
	}

	pub fn spaces(&self) -> impl Iterator<Item = &SpaceStore> {
		let at = self
			.others
			.partition_point(|space| space.id < self.active.id);
		self.others[..at]
			.iter()
			.chain(std::iter::once(&self.active))
			.chain(self.others[at..].iter())
	}

	pub fn space_mut(&mut self, id: u64) -> Option<&mut SpaceStore> {
		if self.active.id == id {
			Some(&mut self.active)
		} else {
			self.others.iter_mut().find(|space| space.id == id)
		}
	}

	/// Called only after the host has confirmed the session open.
	pub fn opened(&mut self, session: SessionId) {
		self.initialized = true;
		if !self.active.tabs.contains(&session) {
			self.active.tabs.push(session.clone());
		}
		self.active.selected = Some(session);
	}

	/// Removes membership only; drafts, transcripts and layout caches remain
	/// available.
	pub fn close(&mut self, session: &SessionId) -> Option<SessionId> {
		self.initialized = true;
		let space = &mut self.active;
		let Some(index) = space.tabs.iter().position(|tab| tab == session) else {
			return space.selected.clone();
		};
		space.tabs.remove(index);
		if space.selected.as_ref() == Some(session) {
			space.selected = space.tabs.get(index).or_else(|| space.tabs.last()).cloned();
		}
		space.selected.clone()
	}

	/// Moves the dragged session to the target's position in either direction.
	pub fn reorder(&mut self, session: &SessionId, target: &SessionId) {
		let space = &mut self.active;
		if let (Some(from), Some(to)) = (
			space.tabs.iter().position(|tab| tab == session),
			space.tabs.iter().position(|tab| tab == target),
		) {
			let tab = space.tabs.remove(from);
			space.tabs.insert(to, tab);
		}
	}

	pub fn create(&mut self, name: &str) -> Option<u64> {
		let name = name.trim();
		if name.is_empty() || self.spaces().any(|space| space.name == name) {
			return None;
		}
		let id = self.spaces().map(|space| space.id).max()?.checked_add(1)?;
		self.others.push(SpaceStore::new(id, name.to_owned()));
		self.initialized = true;
		Some(id)
	}

	pub fn rename(&mut self, id: u64, name: &str) -> bool {
		let name = name.trim();
		if name.is_empty()
			|| self
				.spaces()
				.any(|space| space.id != id && space.name == name)
		{
			return false;
		}
		let Some(space) = self.space_mut(id) else {
			return false;
		};
		name.clone_into(&mut space.name);
		true
	}

	pub fn switch(&mut self, id: u64) -> bool {
		if self.active.id == id {
			return true;
		}
		let Some(space) = self.others.iter_mut().find(|space| space.id == id) else {
			return false;
		};
		std::mem::swap(&mut self.active, space);
		self.initialized = true;
		self.others.sort_by_key(|space| space.id);
		true
	}
}
