//! Drawer content and tenant models.
//!
//! Models the terminal tabs, process tabs, visible terminal grid cells,
//! cursor position, scroll offset, supervised process rows, search filters,
//! and selection highlights.

use crate::terminal::{Cell, TerminalSelection};

/// A tab in the drawer tab strip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DrawerTab {
	/// Managed terminal with identifier and title.
	Terminal { id: String, title: String },
	/// Supervised background processes.
	Processes,
}

/// Metadata for a supervised background process row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessRow {
	/// Process name or handle.
	pub name:          String,
	/// Operating system process ID if running.
	pub pid:           Option<u32>,
	/// Status text (e.g. "running", "exited", "failed").
	pub status:        String,
	/// Elapsed time or runtime label.
	pub elapsed_label: String,
	/// Who initiated termination if stopped.
	pub terminated_by: Option<String>,
	/// Process exit code if completed.
	pub exit_code:     Option<i32>,
}

/// Palette search state scoped to the terminal drawer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrawerSearch {
	/// Active search query string.
	pub query:       String,
	/// Number of matches found in scrollback.
	pub match_count: usize,
}

/// State of the terminal drawer surface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrawerContent {
	/// Open tabs in the drawer chrome.
	pub tabs:           Vec<DrawerTab>,
	/// Index of the active tab.
	pub active_tab:     usize,
	/// Visible rows of terminal cells.
	pub grid_rows:      Vec<Vec<Cell>>,
	/// Cursor horizontal column index.
	pub cursor_col:     usize,
	/// Cursor vertical row index.
	pub cursor_row:     usize,
	/// Cursor visibility (DECTCEM).
	pub cursor_visible: bool,
	/// Title of the active terminal session.
	pub title:          String,
	/// Vertical scrollback offset in rows.
	pub scroll_offset:  usize,
	/// Supervised processes list.
	pub processes:      Vec<ProcessRow>,
	/// Active text selection range.
	pub selection:      Option<TerminalSelection>,
	/// Optional search filter from the command palette.
	pub search:         Option<DrawerSearch>,
}

impl Default for DrawerContent {
	fn default() -> Self {
		Self {
			tabs:           Vec::new(),
			active_tab:     0,
			grid_rows:      Vec::new(),
			cursor_col:     0,
			cursor_row:     0,
			cursor_visible: true,
			title:          String::new(),
			scroll_offset:  0,
			processes:      Vec::new(),
			selection:      None,
			search:         None,
		}
	}
}

impl DrawerContent {
	/// Returns the identifier of the active terminal tab if one is selected.
	#[must_use]
	pub fn active_terminal_id(&self) -> Option<&str> {
		match self.tabs.get(self.active_tab) {
			Some(DrawerTab::Terminal { id, .. }) => Some(id),
			_ => None,
		}
	}

	/// Returns true if the processes tab is active.
	#[must_use]
	pub fn is_processes_active(&self) -> bool {
		matches!(self.tabs.get(self.active_tab), Some(DrawerTab::Processes))
	}
}
