//! Every value the window draws from.
//!
//! No gpui here, and none in any sibling of this module. The whole model is
//! plain data with plain moves over it, so what the app DOES is decided and
//! tested without a window, a GPU or a frame clock.
//!
//! WHAT IS DELIBERATELY ABSENT. No engine is attached, so nothing here
//! describes a reply, a tool call, a run, a model catalog or a shell. A field
//! with no producer is a field the window has to draw from an invention, and
//! every one of those was deleted rather than filled with a fixture. What is
//! left is what the window can be honest about on its own: the checkout it was
//! opened in, the conversations the operator starts in it, what they type, and
//! how they want it to look.

/// A session's identity. A string because an engine's ids are strings, so
/// attaching one does not rewrite every signature.
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

/// A checkout: what it is called, where it is, and whether its group is folded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
	pub id:        ProjectId,
	pub name:      String,
	pub path:      String,
	pub collapsed: bool,
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

/// One piece of a message, in the order it was written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Block {
	/// Prose.
	Text(String),
	/// A fenced block: the language as written, then the body.
	Code { lang: String, body: String },
}

/// One turn on screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
	pub id:     u64,
	pub blocks: Vec<Block>,
	pub at_ms:  u64,
}

impl Message {
	/// Split what was typed into prose and fenced blocks.
	///
	/// A fence is three backticks at the start of a line, with an optional
	/// language after them. Text that opens a fence and never closes it is a
	/// block to the end, which is what the writer is looking at while they type
	/// it.
	pub fn written(id: u64, at_ms: u64, text: &str) -> Self {
		let mut blocks = Vec::new();
		let mut prose: Vec<&str> = Vec::new();
		let mut code: Option<(String, Vec<&str>)> = None;

		let flush_prose = |prose: &mut Vec<&str>, blocks: &mut Vec<Block>| {
			let joined = prose.join("\n").trim().to_owned();
			prose.clear();
			if !joined.is_empty() {
				blocks.push(Block::Text(joined));
			}
		};

		for line in text.lines() {
			match (&mut code, line.trim_start().strip_prefix("```")) {
				(None, Some(lang)) => {
					flush_prose(&mut prose, &mut blocks);
					code = Some((lang.trim().to_owned(), Vec::new()));
				},
				(Some(_), Some(_)) => {
					let (lang, body) = code.take().expect("the fence is open");
					blocks.push(Block::Code { lang, body: body.join("\n") });
				},
				(Some((_, body)), None) => body.push(line),
				(None, None) => prose.push(line),
			}
		}
		if let Some((lang, body)) = code {
			blocks.push(Block::Code { lang, body: body.join("\n") });
		}
		flush_prose(&mut prose, &mut blocks);

		Self { id, blocks, at_ms }
	}

	/// The prose of this message, joined. What the sidebar preview and the
	/// palette's search read.
	pub fn text(&self) -> String {
		self
			.blocks
			.iter()
			.filter_map(|block| match block {
				Block::Text(text) => Some(text.as_str()),
				Block::Code { .. } => None,
			})
			.collect::<Vec<_>>()
			.join("\n\n")
	}
}

/// A session: one conversation, its transcript, and its draft.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
	pub id:         SessionId,
	pub project:    ProjectId,
	pub title:      String,
	pub updated_ms: u64,
	pub messages:   Vec<Message>,
	pub draft:      String,
	/// Where the caret sits in `draft`, as a byte offset.
	pub caret:      usize,
}

impl Session {
	pub fn new(id: impl Into<String>, project: &ProjectId, title: impl Into<String>) -> Self {
		Self {
			id:         SessionId::new(id),
			project:    project.clone(),
			title:      title.into(),
			updated_ms: 0,
			messages:   Vec::new(),
			draft:      String::new(),
			caret:      0,
		}
	}

	/// The last thing said, for the row's second line.
	///
	/// A conversation is named after its first line, so a one-message
	/// conversation would otherwise print that line twice in the same row. The
	/// second line appears once it has something else to say.
	pub fn preview(&self) -> Option<String> {
		let text = self.messages.last()?.text();
		let line = text.lines().find(|line| !line.trim().is_empty())?.trim();
		if line.starts_with(self.title.as_str()) || self.title.starts_with(line) {
			return None;
		}
		Some(line.to_owned())
	}

	pub fn next_message_id(&self) -> u64 {
		self.messages.last().map_or(1, |message| message.id + 1)
	}
}

/// What fills the main panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
	/// The selected conversation.
	Chat,
	/// A settings page.
	Settings(SettingsPage),
}

/// The settings pages, in nav order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SettingsPage {
	Appearance,
	Keys,
}

impl SettingsPage {
	pub const ALL: [SettingsPage; 2] = [SettingsPage::Appearance, SettingsPage::Keys];

	pub fn label(self) -> &'static str {
		match self {
			SettingsPage::Appearance => "Appearance",
			SettingsPage::Keys => "Keyboard",
		}
	}
}

/// One row of the palette.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaletteRow {
	pub key:     String,
	pub label:   String,
	pub detail:  String,
	pub current: bool,
}

/// The open palette: the query, and where the cursor is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Palette {
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
	pub sidebar_width:   f32,
	pub sidebar_open:    bool,
	pub group_by_folder: bool,
	pub font_size:       f32,
}

impl Default for Settings {
	fn default() -> Self {
		Self {
			appearance:      Appearance::Dark,
			sidebar_width:   SIDEBAR_DEFAULT,
			sidebar_open:    true,
			group_by_folder: true,
			font_size:       14.0,
		}
	}
}

/// What a conversation is called before its first send names it.
pub const SESSION_TITLE_UNTITLED: &str = "New conversation";

/// Sidebar width bounds. A drag is clamped to these and a double-click on the
/// handle returns to the default.
pub const SIDEBAR_MIN: f32 = 200.0;
pub const SIDEBAR_DEFAULT: f32 = 260.0;
pub const SIDEBAR_MAX: f32 = 400.0;

/// Text size bounds, for the appearance page's stepper.
pub const FONT_MIN: f32 = 11.0;
pub const FONT_MAX: f32 = 20.0;

/// The whole app.
#[derive(Debug, Clone, PartialEq)]
pub struct Store {
	pub projects:     Vec<Project>,
	pub sessions:     Vec<Session>,
	pub selected:     Option<SessionId>,
	pub settings:     Settings,
	pub route:        Route,
	pub overlay:      Overlay,
	/// Milliseconds since the window opened. Every deadline in the store is
	/// against this, so time is an input rather than a call into the clock.
	pub now_ms:       u64,
	/// Transient line under the composer: what just happened.
	pub notice:       Option<String>,
	/// When that line retires.
	pub notice_until: Option<u64>,
	/// The next id a new conversation takes.
	pub next_session: u64,
}

impl Store {
	/// The store the window opens with: the checkout it was launched in, and one
	/// empty conversation to type into.
	pub fn opened_in(name: &str, path: &str) -> Store {
		let project = Project::new("cwd", name, path);
		let mut store = Store {
			projects:     vec![project],
			sessions:     Vec::new(),
			selected:     None,
			settings:     Settings::default(),
			route:        Route::Chat,
			overlay:      Overlay::None,
			now_ms:       0,
			notice:       None,
			notice_until: None,
			next_session: 1,
		};
		super::moves::new_session(&mut store);
		store
	}

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

	/// The conversations of one checkout, most recently touched first.
	pub fn rows(&self, project: &ProjectId) -> Vec<&Session> {
		let mut rows: Vec<&Session> = self
			.sessions
			.iter()
			.filter(|session| &session.project == project)
			.collect();
		rows.sort_by(|left, right| {
			right
				.updated_ms
				.cmp(&left.updated_ms)
				.then(right.id.cmp(&left.id))
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

	/// When the store next has something to do on its own, if ever. The notice
	/// is the only thing in it that moves without a keystroke.
	pub fn deadline(&self) -> Option<u64> {
		self.notice_until
	}
}
