//! Files route: lazy tree, host-backed search, selected reader, and inspector.
//!
//! The handles retain scroll identity and decoded content. No engine payload is
//! written here; every action leaves as a `UiCommand`.

mod error;
mod header;
mod inspector;
mod logic;
pub(crate) mod owners;
mod preview;
mod search;
mod tree;
pub(crate) mod tree_cache;
mod view;

use gpui::{Entity, ScrollHandle, ScrollStrategy, UniformListScrollHandle};
use preview::CachedBody;
pub(crate) use tree_cache::TreeCache;
use veyyon_gui_core::{Store, model::FileId};
use veyyon_gui_kit::{input::Editor, motion::CollectionPlan};
pub use view::{render_inspector, render_route, render_sidebar};

/// Long-lived GPUI and presentation caches passed by the shell.
pub struct FilesHandles {
	pub search:           Entity<Editor>,
	pub tree_scroll:      ScrollHandle,
	pub preview_scroll:   UniformListScrollHandle,
	pub markdown_scroll:  ScrollHandle,
	pub inspector_scroll: ScrollHandle,
	tree:                 TreeCache,
	read:                 Option<CachedRead>,
	revealed_cursor:      Option<FileId>,
	revealed_line:        Option<(FileId, u32)>,
}

struct CachedRead {
	revision: u64,
	file:     FileId,
	body:     CachedBody,
}

impl FilesHandles {
	pub fn new(search: Entity<Editor>) -> Self {
		Self {
			search,
			tree_scroll: ScrollHandle::new(),
			preview_scroll: UniformListScrollHandle::new(),
			markdown_scroll: ScrollHandle::new(),
			inspector_scroll: ScrollHandle::new(),
			tree: TreeCache::default(),
			read: None,
			revealed_cursor: None,
			revealed_line: None,
		}
	}

	fn sync(&mut self, store: &Store) {
		let Some(files) = store.replica.files.readable() else {
			self.read = None;
			return;
		};
		self.tree.sync(
			files,
			store.frontend.selected_workspace.as_ref(),
			&store.frontend.expanded_files,
			store.frontend.file_cursor.as_ref(),
		);
		if self.revealed_cursor.as_ref() != store.frontend.file_cursor.as_ref() {
			self.revealed_cursor.clone_from(&store.frontend.file_cursor);
			self.tree_scroll.scroll_to_item(
				self
					.tree
					.selected_child(store.frontend.file_cursor.as_ref()),
			);
		}

		if let Some(read) = files.value.selected_read.readable() {
			let changed = self
				.read
				.as_ref()
				.is_none_or(|cached| cached.revision != read.revision || cached.file != read.value.id);
			if changed {
				self.read = Some(CachedRead {
					revision: read.revision,
					file:     read.value.id.clone(),
					body:     CachedBody::from_read(&read.value),
				});
			}
			if let Some(range) = store.frontend.file_range {
				let target = (read.value.id.clone(), range.start);
				if self.revealed_line.as_ref() != Some(&target) {
					self.revealed_line = Some(target);
					let index = usize::try_from(range.start.saturating_sub(1)).unwrap_or(usize::MAX);
					self
						.preview_scroll
						.scroll_to_item(index, ScrollStrategy::Nearest);
				}
			}
		} else if files.value.selected_read.readable().is_none() {
			self.read = None;
			self.revealed_line = None;
		}
	}

	/// Latest bounded tree insert/remove/reorder program for the shell's frame
	/// transaction.
	pub fn collection_plan(&self) -> CollectionPlan {
		self.tree.collection_plan()
	}

	fn cached_body(&self, file: &FileId) -> Option<CachedBody> {
		self
			.read
			.as_ref()
			.filter(|cached| &cached.file == file)
			.map(|cached| cached.body.clone())
	}
}

#[cfg(test)]
mod every_object_the_files_route_draws_animates_on_its_own_track;
