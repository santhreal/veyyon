//! Every value the window draws from.
//!
//! No toolkit here, and none in any sibling of this module. The whole model is
//! plain data with plain moves over it, so what the app DOES is decided and
//! tested without a window, a GPU or a frame clock.
//!
//! One file per axis: what things are called, what a turn is made of, what a
//! conversation is, what the operator can change, and what is on screen. The
//! aggregate is here, and it is the only type that knows about all five.
//!
//! WHAT IS DELIBERATELY ABSENT. No engine is attached, so nothing here holds a
//! reply, a token count, a model catalog or a running command. The shapes an
//! engine fills are declared where a renderer needs them and nothing constructs
//! one: a field drawn from an invention is worse than a field that is not
//! there, because every other thing on screen becomes suspect.

pub mod ids;
pub mod message;
pub mod session;
pub mod settings;
pub mod view;

pub use ids::*;
pub use message::*;
pub use session::*;
pub use settings::*;
pub use view::*;

/// What a conversation is called before its first send names it.
pub const SESSION_TITLE_UNTITLED: &str = "New conversation";

/// The whole app.
#[derive(Debug, Clone, PartialEq)]
pub struct Store {
	pub projects:     Vec<Project>,
	pub sessions:     Vec<Session>,
	pub selected:     Option<SessionId>,
	pub settings:     Settings,
	pub route:        Route,
	pub overlay:      Overlay,
	/// Whether anything answers.
	pub engine:       Engine,
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
			engine:       Engine::Detached,
			now_ms:       0,
			notice:       None,
			notice_until: None,
			next_session: 1,
		};
		crate::store::moves::new_session(&mut store);
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
