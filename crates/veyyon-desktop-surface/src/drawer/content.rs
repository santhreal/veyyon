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
	/// One supervised process's output, on the terminal surface (§5.12).
	Process { name: String },
}

impl DrawerTab {
	/// The name the tab is written under in what the window remembers (§8.10).
	///
	/// A tenant's identity, not its position: the drawer's tabs are the
	/// host's, so an index written here would name a different terminal on the
	/// next launch. A terminal is named by its id and a process by its name,
	/// and the title is left out because the host reports it again.
	#[must_use]
	pub fn slug(&self) -> String {
		match self {
			Self::Terminal { id, .. } => format!("terminal:{id}"),
			Self::Processes => "processes".to_string(),
			Self::Process { name } => format!("process:{name}"),
		}
	}
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
	/// Whether the host offers either of the drawer's tenants.
	///
	/// §5.13: a surface absent for want of a capability is not rendered, never
	/// rendered empty. A host that runs no terminals and supervises no
	/// processes has no drawer, so the toggle, the chord and `/terminal` do not
	/// offer one.
	pub offered:        bool,
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
			offered:        false,
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

	/// The name of the process whose output tab is active, if one is.
	#[must_use]
	pub fn active_process_name(&self) -> Option<&str> {
		match self.tabs.get(self.active_tab) {
			Some(DrawerTab::Process { name }) => Some(name),
			_ => None,
		}
	}

	/// The index of the tab holding this process's output.
	#[must_use]
	pub fn process_tab_index(&self, name: &str) -> Option<usize> {
		self
			.tabs
			.iter()
			.position(|tab| matches!(tab, DrawerTab::Process { name: held } if held == name))
	}
}
