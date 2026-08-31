//! Event-time preparation of retained Changes projections.

use gpui::{App, Entity};
use veyyon_gui_core::{Store, model::FileId, navigation::DiffLayout};

use super::{
	rows::Layout,
	tree::{TreeRow, TreeRows},
	viewport::DiffViewport,
};

#[derive(Debug, Default)]
pub struct ChangesCache {
	tree:          TreeRows,
	selected_hunk: Option<(FileId, usize)>,
}

impl ChangesCache {
	pub fn tree(&self) -> &[TreeRow] {
		self.tree.as_slice()
	}

	/// Rebuild projections after a store change, never from a paint callback.
	pub fn prepare(&mut self, store: &Store, viewport: &Entity<DiffViewport>, cx: &mut App) {
		let Some(versioned) = store.replica.changes.readable() else {
			self.tree.clear();
			self.selected_hunk = None;
			return;
		};
		let snapshot = &versioned.value;
		self.tree.prepare(
			versioned.revision,
			snapshot,
			&store.frontend.changes_filter,
			&store.frontend.expanded_change_folders,
		);

		let layout = match store.frontend.preferences.diff_layout {
			DiffLayout::Unified => Layout::Unified,
			DiffLayout::Split => Layout::Split,
		};
		viewport.update(cx, |viewport, cx| {
			viewport.replace(
				versioned.revision,
				&snapshot.parsed,
				0,
				layout,
				store.frontend.preferences.wrap_diff,
				store.frontend.preferences.show_whitespace,
				|_, _| false,
				snapshot.truncated,
				snapshot.malformed_hunks,
				store
					.frontend
					.review_range
					.as_ref()
					.map(|(path, range)| (path.as_str(), *range)),
				cx,
			);
		});

		if self.selected_hunk == store.frontend.selected_hunk {
			return;
		}
		self.selected_hunk.clone_from(&store.frontend.selected_hunk);
		let Some((file, hunk)) = self.selected_hunk.as_ref() else {
			return;
		};
		let Some(file) = snapshot
			.files
			.iter()
			.position(|candidate| &candidate.id == file)
		else {
			return;
		};
		viewport.update(cx, |viewport, _cx| viewport.reveal_selected_hunk(file, *hunk));
	}
}
