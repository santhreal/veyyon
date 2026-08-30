//! What the column shows, decided without a window.
//!
//! Every question the sidebar has an opinion about is answered here: whether a
//! checkout gets a fold, which conversations are under it, whether a row may
//! offer to delete itself. The view then draws exactly what this returns, which
//! is why the ordering and the grouping are testable at all.

use veyyon_gui_core::store::model::{ProjectId, SessionId, Store};

/// One checkout's block in the column.
#[derive(Debug, Clone, PartialEq)]
pub struct Column {
	pub project:   ProjectId,
	pub name:      String,
	/// Whether the heading folds. A single checkout has nothing to fold away
	/// from, so its name is a quiet heading over the whole list instead.
	pub foldable:  bool,
	pub collapsed: bool,
	pub rows:      Vec<Entry>,
}

/// One conversation.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
	pub id:      SessionId,
	pub title:   String,
	/// The last thing said in it, when there is anything to say.
	pub preview: Option<String>,
	/// Whether this is the conversation the window is showing.
	pub active:  bool,
}

/// The column, in the order it is drawn.
///
/// A folded checkout keeps its rows in the returned value: the fold is drawn as
/// a collapse, and a body that is not there cannot be animated out.
pub fn columns(store: &Store) -> Vec<Column> {
	let grouped = store.settings.group_by_folder && store.projects.len() > 1;
	store
		.projects
		.iter()
		.map(|project| Column {
			project:   project.id.clone(),
			name:      project.name.clone(),
			foldable:  grouped,
			collapsed: grouped && project.collapsed,
			rows:      store
				.rows(&project.id)
				.into_iter()
				.map(|session| Entry {
					id:      session.id.clone(),
					title:   session.title.clone(),
					preview: session.preview(),
					active:  store.selected.as_ref() == Some(&session.id),
				})
				.collect(),
		})
		.collect()
}

/// Whether a row may offer to delete itself.
///
/// The last conversation may not: a window with no conversation has nowhere to
/// put the caret, and an offer that does nothing is worse than no offer.
pub fn deletable(store: &Store) -> bool {
	store.sessions.len() > 1
}
