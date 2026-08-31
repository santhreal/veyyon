//! Folder projection for changed files.
//!
//! Paths arrive flat from the host. The tree is rebuilt only when a snapshot,
//! filter, or disclosure changes, then rendered from retained rows.

use std::collections::{BTreeMap, BTreeSet};

use veyyon_gui_core::model::ChangesSnapshot;
use veyyon_gui_kit::motion::RetainedKey;

use super::owners;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TreeRow {
	Folder {
		path:     String,
		name:     String,
		depth:    u8,
		expanded: bool,
		owner:    RetainedKey,
	},
	File {
		file:  usize,
		depth: u8,
		owner: RetainedKey,
	},
}

#[derive(Debug, Default)]
pub struct TreeRows {
	rows:     Vec<TreeRow>,
	revision: Option<u64>,
	query:    String,
	expanded: BTreeSet<String>,
}

impl TreeRows {
	pub fn as_slice(&self) -> &[TreeRow] {
		&self.rows
	}

	pub fn clear(&mut self) {
		self.rows.clear();
		self.revision = None;
		self.query.clear();
		self.expanded.clear();
	}

	pub fn prepare(
		&mut self,
		revision: u64,
		snapshot: &ChangesSnapshot,
		query: &str,
		expanded: &BTreeSet<String>,
	) {
		if self.revision == Some(revision) && self.query == query && self.expanded == *expanded {
			return;
		}
		self.revision = Some(revision);
		query.clone_into(&mut self.query);
		self.expanded.clone_from(expanded);

		let query = query.trim().to_lowercase();
		let mut root = Folder::default();
		for (index, file) in snapshot.files.iter().enumerate() {
			if !query.is_empty() && !file.path.to_lowercase().contains(&query) {
				continue;
			}
			root.insert(&file.path, index);
		}

		self.rows.clear();
		let mut is_expanded = |path: &str| expanded.contains(path);

		root.flatten("", 0, &mut is_expanded, snapshot, &mut self.rows);
	}
}

#[derive(Debug, Default)]
struct Folder {
	folders: BTreeMap<String, Folder>,
	files:   BTreeMap<String, usize>,
}

impl Folder {
	fn insert(&mut self, path: &str, file: usize) {
		let mut parts = path.split('/').filter(|part| !part.is_empty()).peekable();
		let mut folder = self;
		while let Some(part) = parts.next() {
			if parts.peek().is_none() {
				folder.files.insert(part.to_owned(), file);
				return;
			}
			folder = folder.folders.entry(part.to_owned()).or_default();
		}
	}

	fn flatten(
		&self,
		parent: &str,
		depth: u8,
		is_expanded: &mut impl FnMut(&str) -> bool,
		snapshot: &ChangesSnapshot,
		rows: &mut Vec<TreeRow>,
	) {
		for (name, folder) in &self.folders {
			let path = if parent.is_empty() {
				name.clone()
			} else {
				format!("{parent}/{name}")
			};
			let expanded = is_expanded(&path);
			let owner = owners::folder(&path);
			rows.push(TreeRow::Folder {
				path: path.clone(),
				name: name.clone(),
				depth,
				expanded,
				owner,
			});
			if expanded {
				folder.flatten(&path, depth.saturating_add(1), is_expanded, snapshot, rows);
			}
		}

		for &file in self.files.values() {
			let owner = snapshot
				.files
				.get(file)
				.map_or_else(owners::missing, |view| owners::file(&view.id));
			rows.push(TreeRow::File { file, depth, owner });
		}
	}
}
