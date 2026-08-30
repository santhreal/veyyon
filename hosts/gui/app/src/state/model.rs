//! Every value the window draws from.
//!
//! No gpui here, and none in any sibling of this module. The whole model is
//! plain data with plain moves over it, so what the app DOES is decided and
//! tested without a window, a GPU or a frame clock.
//!
//! The engine is not attached yet. Two seams stand where it will: [`Seed`]
//! supplies the starting store, and `state::agent` answers a send. Everything
//! else — selection, drafts, streaming into a message, terminal output,
//! settings — already moves for real, and keeps moving unchanged once those two
//! are fed from a socket instead.

use std::collections::BTreeMap;

/// A session's identity. A string because the engine's ids are strings, so the
/// swap does not rewrite every signature.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SessionId(pub String);

impl SessionId {
	pub fn new(id: impl Into<String>) -> Self {
		Self(id.into())
	}

	pub fn as_str(&self) -> &str {
		&self.0
	}
}

/// A checkout the sessions belong to.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProjectId(pub String);

impl ProjectId {
	pub fn new(id: impl Into<String>) -> Self {
		Self(id.into())
	}

	pub fn as_str(&self) -> &str {
		&self.0
	}
}

/// A checkout: a name, where it is, and whether its group is folded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
	pub id:        ProjectId,
	pub name:      String,
	pub path:      String,
	pub collapsed: bool,
}

/// What a session is doing, which is the only thing the list is sorted by.
///
/// Ordered by how much it wants the operator, not by how recently it moved. A
/// list sorted by time buries the one session that stopped and is waiting under
/// every session that is still running, which is the failure this ordering
/// exists to prevent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Activity {
	/// Stopped, and wants an answer.
	Waiting,
	/// Stopped because it broke.
	Failed,
	/// Running now.
	Working,
	/// Finished cleanly, not yet read.
	Done,
	/// Nothing in flight.
	Idle,
}

impl Activity {
	/// Every activity there is, for the suites that sweep the union rather
	/// than a list somebody typed. A new variant turns those red.
	#[cfg(test)]
	pub const ALL: [Activity; 5] =
		[Activity::Waiting, Activity::Failed, Activity::Working, Activity::Done, Activity::Idle];

	/// Sort rank. Lower sorts first.
	pub fn rank(self) -> u8 {
		match self {
			Activity::Waiting => 0,
			Activity::Failed => 1,
			Activity::Working => 2,
			Activity::Done => 3,
			Activity::Idle => 4,
		}
	}

	/// The word the row shows, or `None` for a row that shows its time instead.
	pub fn label(self) -> Option<&'static str> {
		match self {
			Activity::Waiting => Some("Input"),
			Activity::Failed => Some("Failed"),
			Activity::Working => Some("Working"),
			Activity::Done => Some("Done"),
			Activity::Idle => None,
		}
	}

	pub fn is_running(self) -> bool {
		self == Activity::Working
	}

	pub fn needs_answer(self) -> bool {
		matches!(self, Activity::Waiting | Activity::Failed)
	}
}

/// Who said a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
	User,
	Assistant,
}

/// How a tool call ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolState {
	Running,
	Ok,
	Failed,
}

impl Project {
	pub fn new(id: &str, name: &str, path: &str) -> Project {
		Project {
			id:        ProjectId::new(id),
			name:      name.to_owned(),
			path:      path.to_owned(),
			collapsed: false,
		}
	}
}

/// One piece of a message. A message is a list of these in the order they
/// arrived, so a reply that reads, calls a tool and then keeps talking is one
/// message rather than three.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Block {
	/// Prose. Streams a character at a time while a run is live.
	Text(String),
	/// A fenced block: the language, then the body.
	Code { lang: String, body: String },
	/// A tool call: what ran, on what, and what came back.
	Tool { name: String, target: String, output: String, state: ToolState },
	/// Changed lines: a path, then `(sign, text)` where sign is `+`, `-` or ` `.
	Diff { path: String, lines: Vec<(char, String)> },
}

impl Block {
	/// A tool call. Written here rather than at each site, because a reply, the
	/// seed and a future engine frame all build the same four fields.
	pub fn tool(name: &str, target: &str, output: &str, state: ToolState) -> Block {
		Block::Tool {
			name: name.to_owned(),
			target: target.to_owned(),
			output: output.to_owned(),
			state,
		}
	}

	/// Whether this is a tool call for the same call as `other`, which is what
	/// makes a finished call replace its own running form rather than appearing
	/// beside it.
	pub fn same_tool_as(&self, other: &Block) -> bool {
		match (self, other) {
			(
				Block::Tool { name, target, .. },
				Block::Tool { name: other_name, target: other_target, .. },
			) => name == other_name && target == other_target,
			_ => false,
		}
	}

	/// Whether this block is a tool call that has not finished.
	pub fn is_running_tool(&self) -> bool {
		matches!(self, Block::Tool { state: ToolState::Running, .. })
	}
}

/// One turn on screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
	pub id:     u64,
	pub role:   Role,
	pub blocks: Vec<Block>,
	pub at_ms:  u64,
}

impl Message {
	pub fn user(id: u64, at_ms: u64, text: impl Into<String>) -> Self {
		Self { id, role: Role::User, blocks: vec![Block::Text(text.into())], at_ms }
	}

	/// The prose of this message, joined. What the sidebar preview and the
	/// palette search read.
	pub fn text(&self) -> String {
		self
			.blocks
			.iter()
			.filter_map(|block| match block {
				Block::Text(text) => Some(text.as_str()),
				_ => None,
			})
			.collect::<Vec<_>>()
			.join("\n\n")
	}
}

/// A reply arriving. The whole reply is known up front and revealed over time,
/// which is what a stream is from the view's side: the view cannot tell a
/// scripted reveal from a socket, and neither can the transcript's autoscroll.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
	/// The message being written into.
	pub message:  u64,
	/// Blocks still to arrive, in order.
	pub pending:  Vec<Block>,
	/// How much of `pending[0]` has landed, in characters, when it is prose.
	pub revealed: usize,
	/// When the next reveal is due.
	pub next_ms:  u64,
	/// What the session becomes when the last block lands.
	pub ends_as:  Activity,
}

/// A session: one conversation, its transcript, and its draft.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
	pub id:         SessionId,
	pub project:    ProjectId,
	pub title:      String,
	pub branch:     Option<String>,
	pub status:     Activity,
	pub unread:     bool,
	pub archived:   bool,
	pub updated_ms: u64,
	pub model:      String,
	pub messages:   Vec<Message>,
	pub draft:      String,
	pub run:        Option<Run>,
	/// Where the caret sits in `draft`, as a byte offset.
	pub caret:      usize,
}

impl Session {
	pub fn new(id: impl Into<String>, project: &ProjectId, title: impl Into<String>) -> Self {
		Self {
			id:         SessionId::new(id),
			project:    project.clone(),
			title:      title.into(),
			branch:     None,
			status:     Activity::Idle,
			unread:     false,
			archived:   false,
			updated_ms: 0,
			model:      String::new(),
			messages:   Vec::new(),
			draft:      String::new(),
			run:        None,
			caret:      0,
		}
	}

	/// The last thing said, for the row's second line.
	pub fn preview(&self) -> Option<String> {
		let text = self.messages.last()?.text();
		let line = text.lines().find(|line| !line.trim().is_empty())?;
		Some(line.trim().to_owned())
	}

	pub fn next_message_id(&self) -> u64 {
		self.messages.last().map_or(1, |message| message.id + 1)
	}
}

/// One terminal tab: what ran, where, and what it printed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalTab {
	pub id:      u64,
	pub title:   String,
	pub cwd:     String,
	pub lines:   Vec<String>,
	pub exit:    Option<i32>,
	/// Lines still to print, and when the next one is due. `None` once the
	/// command has finished.
	pub pending: Vec<String>,
	pub next_ms: u64,
}

impl TerminalTab {
	pub fn is_running(&self) -> bool {
		self.exit.is_none()
	}

	pub fn failed(&self) -> bool {
		self.exit.is_some_and(|code| code != 0)
	}
}

/// The bottom panel.
#[derive(Debug, Clone, PartialEq)]
pub struct Terminal {
	pub tabs:   Vec<TerminalTab>,
	pub active: usize,
	pub open:   bool,
	pub height: f32,
	/// The exit code a tab takes when its last line lands, by tab id.
	///
	/// Held beside the tab rather than inside it because a running tab has no
	/// exit code, and a field that holds one anyway is a field the view has to
	/// be told to ignore.
	pub exits:  BTreeMap<u64, Option<i32>>,
}

impl Terminal {
	pub fn active_tab(&self) -> Option<&TerminalTab> {
		self.tabs.get(self.active)
	}

	pub fn running(&self) -> usize {
		self.tabs.iter().filter(|tab| tab.is_running()).count()
	}
}

/// What fills the main panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
	/// The selected session, or the new-session canvas when nothing is selected.
	Chat,
	/// A settings page.
	Settings(SettingsPage),
}

/// The settings pages, in nav order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SettingsPage {
	Appearance,
	Models,
	Shortcuts,
	Agents,
}

impl SettingsPage {
	pub const ALL: [SettingsPage; 4] = [
		SettingsPage::Appearance,
		SettingsPage::Models,
		SettingsPage::Shortcuts,
		SettingsPage::Agents,
	];

	pub fn label(self) -> &'static str {
		match self {
			SettingsPage::Appearance => "Appearance",
			SettingsPage::Models => "Models",
			SettingsPage::Shortcuts => "Shortcuts",
			SettingsPage::Agents => "Agents",
		}
	}
}

/// What the palette is searching over. One overlay, several corpora, so the
/// keyboard path is written once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaletteKind {
	/// Sessions and commands together.
	Command,
	/// Models for the selected session.
	Model,
	/// Themes.
	Theme,
}

/// One row of the palette.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaletteRow {
	pub key:     String,
	pub label:   String,
	pub detail:  String,
	pub current: bool,
}

/// The open palette: what it is searching, the query, and where the cursor is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Palette {
	pub kind:     PaletteKind,
	pub query:    String,
	pub selected: usize,
}

/// What floats over the window, if anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Overlay {
	None,
	Palette(Palette),
}

impl Overlay {
	pub fn palette(&self) -> Option<&Palette> {
		match self {
			Overlay::Palette(palette) => Some(palette),
			Overlay::None => None,
		}
	}

	pub fn is_open(&self) -> bool {
		!matches!(self, Overlay::None)
	}
}

/// Which way the window reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Appearance {
	Dark,
	Light,
}

impl Appearance {
	pub fn flipped(self) -> Appearance {
		match self {
			Appearance::Dark => Appearance::Light,
			Appearance::Light => Appearance::Dark,
		}
	}
}

/// Everything the operator can change and the window remembers.
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
	pub appearance:      Appearance,
	pub theme:           String,
	pub sidebar_width:   f32,
	pub sidebar_open:    bool,
	pub group_by_folder: bool,
	pub show_settled:    bool,
	pub sounds:          bool,
	pub font_size:       f32,
}

impl Default for Settings {
	fn default() -> Self {
		Self {
			appearance:      Appearance::Dark,
			theme:           "graphite".to_owned(),
			sidebar_width:   SIDEBAR_DEFAULT,
			sidebar_open:    true,
			group_by_folder: true,
			show_settled:    false,
			sounds:          false,
			font_size:       14.0,
		}
	}
}

/// What a session is called before its first send names it.
pub const SESSION_TITLE_UNTITLED: &str = "New session";

/// Sidebar width bounds. A drag is clamped to these and a double-click on the
/// handle returns to the default.
pub const SIDEBAR_MIN: f32 = 208.0;
pub const SIDEBAR_DEFAULT: f32 = 268.0;
pub const SIDEBAR_MAX: f32 = 420.0;

/// Terminal panel height bounds.
pub const TERMINAL_MIN: f32 = 120.0;
pub const TERMINAL_DEFAULT: f32 = 260.0;

/// The whole app.
#[derive(Debug, Clone, PartialEq)]
pub struct Store {
	pub projects:     Vec<Project>,
	pub sessions:     Vec<Session>,
	pub selected:     Option<SessionId>,
	pub terminal:     Terminal,
	pub settings:     Settings,
	pub route:        Route,
	pub overlay:      Overlay,
	/// Milliseconds since the window opened. Every deadline in the store is
	/// against this, so time is an input rather than a call into the clock.
	pub now_ms:       u64,
	/// The models a session can be switched to.
	pub models:       Vec<String>,
	/// The themes the appearance page offers.
	pub themes:       Vec<String>,
	/// Transient line under the composer: what just happened.
	pub notice:       Option<String>,
	/// When that line retires.
	pub notice_until: Option<u64>,
}

impl Store {
	pub fn session(&self, id: &SessionId) -> Option<&Session> {
		self.sessions.iter().find(|session| &session.id == id)
	}

	pub fn session_mut(&mut self, id: &SessionId) -> Option<&mut Session> {
		self.sessions.iter_mut().find(|session| &session.id == id)
	}

	pub fn selected_session(&self) -> Option<&Session> {
		self.selected.as_ref().and_then(|id| self.session(id))
	}

	pub fn selected_session_mut(&mut self) -> Option<&mut Session> {
		let id = self.selected.clone()?;
		self.session_mut(&id)
	}

	pub fn project(&self, id: &ProjectId) -> Option<&Project> {
		self.projects.iter().find(|project| &project.id == id)
	}

	/// Sessions of one project in the order the sidebar draws them: what wants
	/// an answer, then what is running, then by recency inside each.
	pub fn rows(&self, project: &ProjectId) -> Vec<&Session> {
		let mut rows: Vec<&Session> = self
			.sessions
			.iter()
			.filter(|session| &session.project == project)
			.filter(|session| !session.archived)
			// A settled row leaves the list, except the one being read: a
			// session that vanishes from the sidebar the moment its reply
			// lands leaves the reader looking at a transcript with no row.
			.filter(|session| {
				self.settings.show_settled
					|| session.status != Activity::Done
					|| self.selected.as_ref() == Some(&session.id)
			})
			.collect();
		rows.sort_by(|left, right| {
			left
				.status
				.rank()
				.cmp(&right.status.rank())
				.then(right.updated_ms.cmp(&left.updated_ms))
				.then(left.id.cmp(&right.id))
		});
		rows
	}

	/// Every visible row, in the order the sidebar draws them across groups.
	/// One function, so keyboard traversal and the drawn list cannot disagree.
	pub fn visible_order(&self) -> Vec<SessionId> {
		self
			.projects
			.iter()
			.filter(|project| !project.collapsed)
			.flat_map(|project| self.rows(&project.id))
			.map(|session| session.id.clone())
			.collect()
	}

	/// How many sessions of a project want an answer, folded or not.
	pub fn waiting(&self, project: &ProjectId) -> usize {
		self
			.sessions
			.iter()
			.filter(|session| &session.project == project && !session.archived)
			.filter(|session| session.status.needs_answer())
			.count()
	}

	pub fn working(&self) -> usize {
		self
			.sessions
			.iter()
			.filter(|session| session.status.is_running())
			.count()
	}

	/// Total unanswered across every project, for the window title and the tray.
	pub fn attention(&self) -> usize {
		self
			.sessions
			.iter()
			.filter(|session| !session.archived && session.status.needs_answer())
			.count()
	}

	/// Whether anything is mid-flight, which is what decides if the window
	/// needs another frame.
	pub fn animating(&self) -> bool {
		self.sessions.iter().any(|session| session.run.is_some())
			|| self.terminal.tabs.iter().any(|tab| !tab.pending.is_empty())
	}
}
