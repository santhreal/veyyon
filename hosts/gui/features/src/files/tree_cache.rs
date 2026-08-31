//! Retained tree projection, collection program reconciliation, and key
//! registries.

use std::collections::{BTreeMap, BTreeSet};

use veyyon_gui_core::model::{
	FileId, FileKind, FileNode, FileWorkspaceState, RemoteData, Versioned, WorkspaceId,
};
use veyyon_gui_kit::motion::{CollectionItem, CollectionPlan};

use super::owners;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TreeEntry {
	File { id: FileId, depth: u8 },
	Loading { parent: FileId, depth: u8 },
	Empty { parent: FileId, depth: u8 },
	Error { workspace: WorkspaceId, parent: FileId, depth: u8, message: String },
}

/// Event-time tree projection. Rendering only follows retained row ids.
#[derive(Default)]
pub struct TreeCache {
	revision:  Option<u64>,
	workspace: Option<WorkspaceId>,
	expanded:  BTreeSet<FileId>,
	index:     BTreeMap<FileId, usize>,
	pub rows:  Vec<TreeEntry>,
	items:     Vec<CollectionItem>,
	plan:      CollectionPlan,
}

impl TreeCache {
	pub fn sync(
		&mut self,
		versioned: &Versioned<FileWorkspaceState>,
		workspace: Option<&WorkspaceId>,
		expanded: &BTreeSet<FileId>,
		cursor: Option<&FileId>,
	) {
		if self.revision == Some(versioned.revision)
			&& self.workspace.as_ref() == workspace
			&& &self.expanded == expanded
			&& self
				.items
				.iter()
				.find(|item| item.selected)
				.map(|item| item.owner)
				== cursor.map(owners::file)
		{
			return;
		}
		self.revision = Some(versioned.revision);
		self.workspace = workspace.cloned();
		self.expanded.clone_from(expanded);
		self.index.clear();
		for (index, node) in versioned.value.nodes.iter().enumerate() {
			self.index.insert(node.id.clone(), index);
		}
		self.rows.clear();
		let Some(workspace) = workspace else { return };
		let mut visited = BTreeSet::new();
		for node in versioned
			.value
			.nodes
			.iter()
			.filter(|node| node.workspace == *workspace && node.parent.is_none())
		{
			self.push_node(node, 0, &versioned.value, &mut visited);
		}
		let old = std::mem::take(&mut self.items);
		let rows = std::mem::take(&mut self.rows);
		for (position, row) in rows.iter().enumerate() {
			let TreeEntry::File { id, .. } = row else {
				continue;
			};
			self.items.push(CollectionItem {
				owner:    owners::file(id),
				position: position as f32,
				selected: cursor == Some(id),
			});
		}
		self.rows = rows;
		self.plan = CollectionPlan::reconcile(&old, &self.items);
	}

	/// Bounded insert/remove/reorder program produced only when the model
	/// projection changes.
	pub fn collection_plan(&self) -> CollectionPlan {
		self.plan
	}

	fn push_node(
		&mut self,
		node: &FileNode,
		depth: u8,
		state: &FileWorkspaceState,
		visited: &mut BTreeSet<FileId>,
	) {
		if !visited.insert(node.id.clone()) {
			return;
		}
		self
			.rows
			.push(TreeEntry::File { id: node.id.clone(), depth });
		if node.kind != FileKind::Directory || !self.expanded.contains(&node.id) {
			return;
		}
		let child_depth = depth.saturating_add(1);
		match &node.children {
			RemoteData::Unrequested | RemoteData::Loading { .. } => {
				self
					.rows
					.push(TreeEntry::Loading { parent: node.id.clone(), depth: child_depth });
			},
			RemoteData::Empty => {
				self
					.rows
					.push(TreeEntry::Empty { parent: node.id.clone(), depth: child_depth });
			},
			RemoteData::Ready(children) | RemoteData::Stale { value: children, .. } => {
				for child in &children.value {
					if let Some(index) = self.index.get(child).copied() {
						self.push_node(&state.nodes[index], child_depth, state, visited);
					}
				}
			},
			RemoteData::Error { message, stale, .. } => {
				if let Some(children) = stale {
					for child in &children.value {
						if let Some(index) = self.index.get(child).copied() {
							self.push_node(&state.nodes[index], child_depth, state, visited);
						}
					}
				} else {
					self.rows.push(TreeEntry::Error {
						workspace: node.workspace.clone(),
						parent:    node.id.clone(),
						depth:     child_depth,
						message:   message.clone(),
					});
				}
			},
		}
	}

	pub fn selected_child(&self, selected: Option<&FileId>) -> usize {
		let Some(selected) = selected else { return 0 };
		self
			.rows
			.iter()
			.position(|row| matches!(row, TreeEntry::File { id, .. } if id == selected))
			.unwrap_or(0)
	}
}
