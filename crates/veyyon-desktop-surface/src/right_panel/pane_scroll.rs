//! The scroll handles the right panel's mono panes report their offsets
//! through (§5.11).
//!
//! A scroll region retains its offset either way: an element with an id keeps
//! one in the window's element state. What that does not do is state the
//! offset to the code that builds the region's children, and building only the
//! rows the pane draws needs exactly that. A handle is the same retained
//! offset, readable while the frame is still being built.
//!
//! The handles are held by the window rather than by the panel state, for the
//! same reason the docked panel's dragged width is: where a pane is scrolled
//! to is this window's, and a snapshot from the host never moves it.

use std::{cell::RefCell, collections::BTreeMap};

use veyyon_gpui::ScrollHandle;

/// Which pane a handle belongs to.
///
/// A diff pane carries its file's index, because the panel draws every changed
/// file into one region and two panes on one handle would scroll together.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PaneId {
	/// The file view's vertical region, which carries the whole file.
	FileRows,
	/// The file view's code column.
	FileColumns,
	/// The diff view's vertical region, which carries every changed file.
	DiffRows,
	/// One file's unified pane.
	DiffUnified(usize),
	/// One file's old side in split mode.
	DiffOld(usize),
	/// And its new side.
	DiffNew(usize),
}

/// The handles this window's panes scroll on.
///
/// Minted on first use and kept, so the offset survives a rebuild of the panel
/// the way the element state it replaces did. The count is bounded by the panes
/// the panel can draw: two for the file view, and three per changed file.
#[derive(Default)]
pub struct PaneScrolls {
	handles: RefCell<BTreeMap<PaneId, ScrollHandle>>,
}

impl PaneScrolls {
	/// The handle for `id`, minting it if this window has not drawn that pane
	/// yet.
	pub fn handle(&self, id: PaneId) -> ScrollHandle {
		self.handles.borrow_mut().entry(id).or_default().clone()
	}
}
