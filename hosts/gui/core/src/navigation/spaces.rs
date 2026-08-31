//! Named workspaces and ordered session tabs.
//!
//! A space is an isolated work context containing an ordered set of open tabs,
//! an active tab index, and independent panel layout configuration.

use crate::{
	model::{SessionId, SpaceId},
	navigation::{BottomTab, InspectorTab, PanelState},
};

/// A single open session tab in a space.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Tab {
	pub session: SessionId,
}

impl Tab {
	pub fn new(session: SessionId) -> Self {
		Self { session }
	}
}

/// A named, ordered set of open tabs with independent panel layout and active
/// tab.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Space {
	pub id:            SpaceId,
	pub name:          String,
	pub tabs:          Vec<Tab>,
	pub active_tab:    Option<usize>,
	pub panels:        PanelState,
	pub bottom_tab:    BottomTab,
	pub inspector_tab: InspectorTab,
}

impl Space {
	pub fn new(id: SpaceId, name: impl Into<String>) -> Self {
		Self {
			id,
			name: name.into(),
			tabs: Vec::new(),
			active_tab: None,
			panels: PanelState::default(),
			bottom_tab: BottomTab::default(),
			inspector_tab: InspectorTab::default(),
		}
	}

	pub fn active_session(&self) -> Option<SessionId> {
		self
			.active_tab
			.and_then(|idx| self.tabs.get(idx).map(|t| t.session.clone()))
	}
}

/// Navigation collection of spaces and active space index.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SpacesState {
	pub spaces:       Vec<Space>,
	pub active_space: usize,
}

impl Default for SpacesState {
	fn default() -> Self {
		let default_id = SpaceId::from_static("default");
		Self { spaces: vec![Space::new(default_id, "Default")], active_space: 0 }
	}
}

impl SpacesState {
	pub fn new(spaces: Vec<Space>, active_space: usize) -> Self {
		let mut state = if spaces.is_empty() {
			Self::default()
		} else {
			let bounded_active = active_space.min(spaces.len() - 1);
			Self { spaces, active_space: bounded_active }
		};
		state.clamp_active_tabs();
		state
	}

	pub fn active(&self) -> Option<&Space> {
		self.spaces.get(self.active_space)
	}

	pub fn active_mut(&mut self) -> Option<&mut Space> {
		self.spaces.get_mut(self.active_space)
	}

	pub fn active_session(&self) -> Option<SessionId> {
		self.active().and_then(|s| s.active_session())
	}

	pub fn active_space_id(&self) -> Option<SpaceId> {
		self.active().map(|s| s.id.clone())
	}

	pub fn active_tab_index(&self) -> Option<usize> {
		self.active().and_then(|s| s.active_tab)
	}

	pub fn open_tab(&mut self, session: SessionId) {
		let Some(space) = self.spaces.get_mut(self.active_space) else {
			return;
		};
		if let Some(existing) = space.tabs.iter().position(|t| t.session == session) {
			space.active_tab = Some(existing);
		} else {
			space.tabs.push(Tab::new(session));
			space.active_tab = Some(space.tabs.len() - 1);
		}
	}

	pub fn close_tab(&mut self, index: usize) -> Option<Tab> {
		let space = self.spaces.get_mut(self.active_space)?;
		if index >= space.tabs.len() {
			return None;
		}
		let removed = space.tabs.remove(index);
		let len = space.tabs.len();
		if len == 0 {
			space.active_tab = None;
		} else if let Some(curr) = space.active_tab {
			if curr == index {
				space.active_tab = Some(index.min(len - 1));
			} else if curr > index {
				space.active_tab = Some(curr - 1);
			} else {
				space.active_tab = Some(curr.min(len - 1));
			}
		}
		Some(removed)
	}

	pub fn move_tab(&mut self, from: usize, to: usize) -> bool {
		let Some(space) = self.spaces.get_mut(self.active_space) else {
			return false;
		};
		if from >= space.tabs.len() || to >= space.tabs.len() {
			return false;
		}
		if from == to {
			return true;
		}
		let tab = space.tabs.remove(from);
		space.tabs.insert(to, tab);
		if let Some(curr) = space.active_tab {
			if curr == from {
				space.active_tab = Some(to);
			} else if from < curr && curr <= to {
				space.active_tab = Some(curr - 1);
			} else if to <= curr && curr < from {
				space.active_tab = Some(curr + 1);
			}
		}
		true
	}

	pub fn select_tab(&mut self, index: usize) -> bool {
		let Some(space) = self.spaces.get_mut(self.active_space) else {
			return false;
		};
		if index < space.tabs.len() {
			space.active_tab = Some(index);
			true
		} else {
			false
		}
	}

	pub fn cycle_tabs(&mut self, forward: bool) {
		let Some(space) = self.spaces.get_mut(self.active_space) else {
			return;
		};
		let len = space.tabs.len();
		if len <= 1 {
			if len == 1 {
				space.active_tab = Some(0);
			}
			return;
		}
		let curr = space.active_tab.unwrap_or(0);
		let next = if forward {
			(curr + 1) % len
		} else {
			(curr + len - 1) % len
		};
		space.active_tab = Some(next);
	}

	pub fn create_space(&mut self, name: impl Into<String>) -> SpaceId {
		let count = self.spaces.len() + 1;
		let id_str = format!("space-{count}");
		let id = SpaceId::new(&id_str).unwrap_or_else(|_| SpaceId::from_static("space"));
		self.spaces.push(Space::new(id.clone(), name));
		id
	}

	pub fn rename_space(&mut self, id: &SpaceId, name: impl Into<String>) -> bool {
		if let Some(space) = self.spaces.iter_mut().find(|s| &s.id == id) {
			space.name = name.into();
			true
		} else {
			false
		}
	}

	pub fn close_space(&mut self, id: &SpaceId) -> bool {
		let Some(index) = self.spaces.iter().position(|s| &s.id == id) else {
			return false;
		};
		if self.spaces.len() == 1 {
			let default_id = SpaceId::from_static("default");
			self.spaces = vec![Space::new(default_id, "Default")];
			self.active_space = 0;
			return true;
		}
		self.spaces.remove(index);
		if self.active_space == index {
			self.active_space = index.min(self.spaces.len() - 1);
		} else if self.active_space > index {
			self.active_space -= 1;
		}
		true
	}

	pub fn select_space(&mut self, id: &SpaceId) -> bool {
		if let Some(index) = self.spaces.iter().position(|s| &s.id == id) {
			self.active_space = index;
			true
		} else {
			false
		}
	}

	fn clamp_active_tabs(&mut self) {
		for space in &mut self.spaces {
			if space.tabs.is_empty() {
				space.active_tab = None;
			} else if let Some(active) = space.active_tab {
				if active >= space.tabs.len() {
					space.active_tab = Some(space.tabs.len() - 1);
				}
			} else {
				space.active_tab = Some(0);
			}
		}
	}
}
