//! Drawer content and tenant models.
//!
//! Models the terminal tabs, process tabs, visible terminal grid cells,
//! cursor position, scroll offset, supervised process rows, search filters,
//! and selection highlights.

use veyyon_desktop_model::SurfaceId;

use crate::{
	controls::ControlError,
	terminal::{Cell, TerminalSelection},
};

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

/// The failure the host sent for a control the drawer draws, with the
/// control it landed on.
///
/// The drawer sends a request from every control on it -- the strip's `New`,
/// a terminal's `Clear`, `Restart` and `Close`, the supervisor's `Start`, a
/// row's `Stop`, `Restart` and `Send` -- and the refusal the host answers
/// with lands on the control that sent it. The drawer stated one of them, so
/// a start the host refused and a line it could not write reached nothing
/// that draws. The surface travels with the message because a retry sends
/// the request that failed there, which the surface id is the key to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrawerFailure {
	/// The control the failure landed on, and the key to the request it sent.
	pub surface: SurfaceId,
	/// What the host said, and whether it offered to be asked again.
	pub error:   ControlError,
}

/// State of the terminal drawer surface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrawerContent {
	/// Open tabs in the drawer chrome.
	pub tabs:           Vec<DrawerTab>,
	/// Index of the active tab.
	pub active_tab:     usize,
	/// Whether the active tab is one the operator chose.
	///
	/// The drawer's opening asks the host for a terminal, which arrives a
	/// round trip later, so the index the drawer holds until then is a
	/// fallback rather than a choice: a host that supervises processes has
	/// the process list at index zero, and carrying that index forward as
	/// though it had been picked left the drawer on the supervisor after the
	/// terminal it had just asked for arrived. A tab is carried across
	/// projections only once a click, a process's log or a remembered shape
	/// has chosen it; until then the drawer follows the terminal.
	pub tab_chosen:     bool,
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
	/// The host's failure for one of the drawer's own controls, restated
	/// every projection.
	pub failure:        Option<DrawerFailure>,
}

impl Default for DrawerContent {
	fn default() -> Self {
		Self {
			tabs:           Vec::new(),
			tab_chosen:     false,
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
			failure:        None,
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
