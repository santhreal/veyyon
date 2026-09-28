//! The lines the sidebar lists.
//!
//! Threads the window placed apart from their projects are listed in blocks:
//! `Unsent` (a typed prompt not sent, other than the open thread), `Pinned`
//! above the projects, `Deferred` and `Archived` below them. Every other
//! thread is listed under its project, inset under the nearest listed thread
//! it branched from, and a thread whose branches are folded hides them. The
//! blocks and projects collapsed, the branches folded and the archived pages
//! listed are the ones the store records.

use std::collections::HashMap;

use veyyon_desktop_model::{QueuePartition, SessionId};

use super::model::contains_folded;
use crate::{
	AppState,
	state::{Project, SessionRow},
};

/// The archived threads one page lists; an [`Item::Older`] line lists the
/// next page.
pub const ARCHIVED_PAGE: usize = 25;

/// A block of threads listed apart from their projects.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Block {
	/// Threads holding a prompt that was typed and not sent.
	Unsent,
	/// Pinned threads.
	Pinned,
	/// Threads set aside until they are recalled.
	Deferred,
	/// Archived threads.
	Archived,
}

impl Block {
	/// The header label.
	pub const fn label(self) -> &'static str {
		match self {
			Self::Unsent => "Unsent",
			Self::Pinned => "Pinned",
			Self::Deferred => "Deferred",
			Self::Archived => "Archived",
		}
	}

	/// The name the store records the block as collapsed under.
	pub const fn key(self) -> &'static str {
		match self {
			Self::Unsent => "unsent",
			Self::Pinned => "pinned",
			Self::Deferred => "deferred",
			Self::Archived => "parked",
		}
	}
}

/// Whether a thread row has branches listed under it, and whether they show.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Branches {
	/// No listed thread branched from it.
	None,
	/// Its branches are listed under it.
	Shown,
	/// Its branches are hidden.
	Folded,
}

/// One line of the sidebar list, as indices into `AppState::projects`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Item {
	/// The header of a block and the number of threads in it.
	Block {
		/// The block.
		block: Block,
		/// The threads the block holds, listed or not.
		count: usize,
	},
	/// The header of the project at this index.
	Project(usize),
	/// Session `row` of project `project`.
	Session {
		/// The project index.
		project:  usize,
		/// The row index inside the project.
		row:      usize,
		/// The branch levels the row is inset by.
		depth:    usize,
		/// Whether the row has branches under it.
		branches: Branches,
	},
	/// The line that lists the next page of archived threads, and the number
	/// of archived threads not listed.
	Older(usize),
}

/// What the lines are built from.
pub struct Listing<'a> {
	/// The state holding the projects, each thread's placement and draft, the
	/// open thread, which is never listed as unsent, and the folds.
	pub app:   &'a AppState,
	/// The lowercase filter. A filter lists only the threads whose title
	/// contains it, under their blocks and projects, collapsed, folded and
	/// paged or not, and drops a header with no match under it.
	pub query: &'a str,
}

/// A listed thread that later rows of its project may have branched from.
#[derive(Clone, Copy)]
struct Ancestor {
	/// Its depth in the project's thread tree.
	depth:  usize,
	/// Its line, `None` while a folded ancestor hides it.
	line:   Option<usize>,
	hidden: bool,
	folded: bool,
}

impl Listing<'_> {
	/// The lines, in order.
	pub fn items(&self) -> Vec<Item> {
		let projects = self.app.projects();
		let mut placed_rows = HashMap::new();
		let mut unsent = Vec::new();
		for (project, listed) in projects.iter().enumerate() {
			for (row, session) in listed.sessions.iter().enumerate() {
				match self.block_of(&session.id) {
					Some(Block::Unsent) if self.matches(session) => unsent.push((project, row)),
					Some(block) if self.matches(session) => {
						placed_rows.insert(&session.id, (block, project, row));
					},
					_ => {},
				}
			}
		}
		let placed = |block: Block, ids: &[SessionId]| -> Vec<(usize, usize)> {
			ids.iter()
				.filter_map(|id| placed_rows.get(id))
				.filter(|(placed, ..)| *placed == block)
				.map(|&(_, project, row)| (project, row))
				.collect()
		};
		let sessions = &self.app.store().sessions;
		let mut items = Vec::new();
		self.push_block(&mut items, Block::Unsent, &unsent);
		self.push_block(&mut items, Block::Pinned, &placed(Block::Pinned, &sessions.pinned));
		for (project, listed) in projects.iter().enumerate() {
			self.push_project(&mut items, project, listed);
		}
		self.push_block(&mut items, Block::Deferred, &placed(Block::Deferred, &sessions.deferred));
		self.push_block(&mut items, Block::Archived, &placed(Block::Archived, &sessions.parked));
		items
	}

	/// The block `session` is listed in, `None` for its project.
	pub fn block_of(&self, session: &SessionId) -> Option<Block> {
		match self.app.partition(session) {
			QueuePartition::Pinned | QueuePartition::Live if self.holds_unsent(session) => {
				Some(Block::Unsent)
			},
			QueuePartition::Pinned => Some(Block::Pinned),
			QueuePartition::Live => None,
			QueuePartition::Deferred => Some(Block::Deferred),
			QueuePartition::Parked => Some(Block::Archived),
		}
	}

	/// Whether `session` is not the open thread and holds typed text.
	fn holds_unsent(&self, session: &SessionId) -> bool {
		self.app.active_session() != Some(session)
			&& self
				.app
				.store()
				.persisted
				.composer
				.get(session)
				.is_some_and(|draft| !draft.draft_text.trim().is_empty())
	}

	fn matches(&self, session: &SessionRow) -> bool {
		contains_folded(&session.title, self.query)
	}

	fn push_block(&self, items: &mut Vec<Item>, block: Block, rows: &[(usize, usize)]) {
		if rows.is_empty() {
			return;
		}
		items.push(Item::Block { block, count: rows.len() });
		let filtering = !self.query.is_empty();
		if !filtering && self.app.is_section_collapsed(block.key()) {
			return;
		}
		let listed = if filtering || block != Block::Archived {
			rows.len()
		} else {
			rows
				.len()
				.min(self.app.archived_pages().saturating_mul(ARCHIVED_PAGE))
		};
		items.extend(
			rows
				.iter()
				.take(listed)
				.map(|&(project, row)| Item::Session {
					project,
					row,
					depth: 0,
					branches: Branches::None,
				}),
		);
		if listed < rows.len() {
			items.push(Item::Older(rows.len() - listed));
		}
	}

	fn push_project(&self, items: &mut Vec<Item>, project: usize, listed: &Project) {
		let filtering = !self.query.is_empty();
		let header = items.len();
		items.push(Item::Project(project));
		if !filtering && self.app.is_project_collapsed(&listed.path) {
			return;
		}
		let mut ancestors: Vec<Ancestor> = Vec::new();
		for (row, session) in listed.sessions.iter().enumerate() {
			while ancestors
				.last()
				.is_some_and(|ancestor| ancestor.depth >= session.depth)
			{
				ancestors.pop();
			}
			if self.block_of(&session.id).is_some() || !self.matches(session) {
				continue;
			}
			let parent = ancestors.last().copied();
			if let Some(Ancestor { line: Some(line), folded, .. }) = parent
				&& let Some(Item::Session { branches, .. }) = items.get_mut(line)
			{
				*branches = if folded {
					Branches::Folded
				} else {
					Branches::Shown
				};
			}
			let hidden = parent.is_some_and(|parent| parent.hidden || parent.folded);
			let line = (!hidden).then(|| {
				items.push(Item::Session {
					project,
					row,
					depth: ancestors.len(),
					branches: Branches::None,
				});
				items.len() - 1
			});
			let folded = !filtering && self.app.are_branches_folded(&session.id);
			ancestors.push(Ancestor { depth: session.depth, line, hidden, folded });
		}
		if filtering && items.len() == header + 1 {
			items.truncate(header);
		}
	}
}
