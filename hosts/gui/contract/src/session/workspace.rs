//! The sidebar's data: projects, and the threads under them.
//!
//! A thread is one conversation with one agent. A window shows one at a time
//! and lists the rest, so the list is not navigation furniture: it is where an
//! operator finds the thread that is waiting on them, which is the thing
//! several parallel agents make hard to see.
//!
//! The list is grouped by project rather than flat because a thread's meaning
//! is its repository. Two threads named "fix the parser" in different checkouts
//! are not the same work, and a flat list makes them look like it.

use crate::view::Badge;

/// Every project and thread the window can reach.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Workspace {
	pub projects: Vec<Project>,
	/// The thread on screen, by id. `None` while nothing is open.
	pub active:   Option<String>,
}

impl Workspace {
	pub fn new(projects: Vec<Project>) -> Workspace {
		Workspace { projects, active: None }
	}

	/// Opens `id`. Not checked against the projects: a session may report a
	/// thread it has not listed yet, and [`Workspace::active_thread`] is what
	/// resolves the id.
	pub fn active(mut self, id: impl Into<String>) -> Workspace {
		self.active = Some(id.into());
		self
	}

	/// Every thread, in project order.
	pub fn threads(&self) -> impl Iterator<Item = &Thread> {
		self
			.projects
			.iter()
			.flat_map(|project| project.threads.iter())
	}

	/// The thread on screen, or `None` when nothing is open or the id names a
	/// thread that is no longer listed. Never index: the id arrives from
	/// outside, and a stale one must not blank the window.
	pub fn active_thread(&self) -> Option<&Thread> {
		let active = self.active.as_deref()?;
		self.threads().find(|thread| thread.id == active)
	}

	/// The project the thread on screen belongs to.
	pub fn active_project(&self) -> Option<&Project> {
		let active = self.active.as_deref()?;
		self
			.projects
			.iter()
			.find(|project| project.threads.iter().any(|thread| thread.id == active))
	}

	/// Threads that are still someone's business, in project order.
	pub fn open_threads(&self) -> impl Iterator<Item = &Thread> {
		self.threads().filter(|thread| !thread.state.is_settled())
	}

	/// Threads that have been settled and moved out of the way.
	pub fn settled_threads(&self) -> impl Iterator<Item = &Thread> {
		self.threads().filter(|thread| thread.state.is_settled())
	}

	/// How many threads are waiting on the operator.
	///
	/// This is the number the sidebar header carries. A count of running threads
	/// says how busy the machine is; this one says how much of the work has
	/// stopped moving without anybody being told.
	pub fn waiting(&self) -> usize {
		self
			.threads()
			.filter(|thread| thread.state == ThreadState::Waiting)
			.count()
	}

	/// How many threads are running.
	pub fn working(&self) -> usize {
		self
			.threads()
			.filter(|thread| thread.state == ThreadState::Working)
			.count()
	}
}

/// One checkout, and the threads in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
	pub name:      String,
	/// The checkout, as the session knows it. Shortened by the renderer, never
	/// here: how much of a path fits is a question about the window.
	pub path:      String,
	pub threads:   Vec<Thread>,
	/// True when the group is folded. Reported by the session rather than held
	/// by the window, because it survives a restart and the window does not.
	pub collapsed: bool,
}

impl Project {
	pub fn new(name: impl Into<String>, path: impl Into<String>, threads: Vec<Thread>) -> Project {
		Project { name: name.into(), path: path.into(), threads, collapsed: false }
	}

	pub fn collapsed(mut self) -> Project {
		self.collapsed = true;
		self
	}

	/// Threads a folded group still counts, so a header can say what is hidden.
	pub fn waiting(&self) -> usize {
		self
			.threads
			.iter()
			.filter(|thread| thread.state == ThreadState::Waiting)
			.count()
	}
}

/// One conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thread {
	pub id:         String,
	pub title:      String,
	pub state:      ThreadState,
	pub badges:     Vec<Badge>,
	/// When it last changed, as a wire timestamp in milliseconds.
	pub updated_ms: i64,
	/// Blocks added since the operator last read it.
	pub unread:     usize,
}

impl Thread {
	pub fn new(id: impl Into<String>, title: impl Into<String>, state: ThreadState) -> Thread {
		Thread {
			id: id.into(),
			title: title.into(),
			state,
			badges: Vec::new(),
			updated_ms: 0,
			unread: 0,
		}
	}

	pub fn badge(mut self, badge: Badge) -> Thread {
		self.badges.push(badge);
		self
	}

	pub fn updated_ms(mut self, updated_ms: i64) -> Thread {
		self.updated_ms = updated_ms;
		self
	}

	pub fn unread(mut self, unread: usize) -> Thread {
		self.unread = unread;
		self
	}
}

/// What a thread is doing, from the operator's side of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadState {
	/// An agent is working. Nothing is expected of the operator.
	Working,
	/// Stopped, and cannot continue until the operator answers: a question, a
	/// permission, a choice. This is the state the sidebar exists for.
	Waiting,
	/// Finished its turn and expecting nothing.
	Idle,
	/// Ended in a failure that has not been read.
	Failed,
	/// Read and put away. Settled threads sort below every other kind, which is
	/// what keeps a long history from burying the four threads that matter.
	Settled,
}

impl ThreadState {
	/// Every state, in the order they are declared.
	pub const ALL: [ThreadState; 5] = [
		ThreadState::Working,
		ThreadState::Waiting,
		ThreadState::Idle,
		ThreadState::Failed,
		ThreadState::Settled,
	];

	pub fn is_settled(self) -> bool {
		matches!(self, ThreadState::Settled)
	}

	/// Whether the state is waiting on a person rather than on a machine.
	pub fn needs_attention(self) -> bool {
		matches!(self, ThreadState::Waiting | ThreadState::Failed)
	}

	/// Where the state sorts in the list. Lower is higher up.
	///
	/// The order is what the sidebar is for: what has stopped and needs an
	/// answer, then what failed, then what is running, then what is done, then
	/// what has been put away. Sorting by time instead buries a blocked thread
	/// under every thread that has moved since.
	pub fn rank(self) -> u8 {
		match self {
			ThreadState::Waiting => 0,
			ThreadState::Failed => 1,
			ThreadState::Working => 2,
			ThreadState::Idle => 3,
			ThreadState::Settled => 4,
		}
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! The sidebar's whole reason to exist is that a blocked thread is findable
	//! among a dozen running ones. Two things break that and neither looks
	//! wrong: a sort that puts the most recently changed thread first, which
	//! buries the one that stopped, and an id lookup that indexes rather than
	//! searches, which panics or draws the wrong thread when a thread is
	//! closed.
	//!
	//! WHAT IT DOES NOT CATCH. Whether a state is reported correctly. Nothing
	//! here produces one yet.

	use super::*;

	fn workspace() -> Workspace {
		Workspace::new(vec![
			Project::new("veyyon", "/repo/veyyon", vec![
				Thread::new("t1", "Port the grep kernel", ThreadState::Working).updated_ms(9_000),
				Thread::new("t2", "Which auth flow?", ThreadState::Waiting).updated_ms(1_000),
			]),
			Project::new("site", "/repo/site", vec![
				Thread::new("t3", "Fix the changelog render", ThreadState::Settled).updated_ms(20_000),
			]),
		])
	}

	#[test]
	fn a_thread_waiting_on_an_answer_sorts_above_everything_that_is_moving() {
		let mut states = ThreadState::ALL;
		states.sort_by_key(|state| state.rank());
		assert_eq!(states[0], ThreadState::Waiting, "a blocked thread is not first");
		assert_eq!(states[4], ThreadState::Settled, "a settled thread is not last");

		let mut ranks: Vec<u8> = ThreadState::ALL.iter().map(|state| state.rank()).collect();
		let count = ranks.len();
		ranks.sort_unstable();
		ranks.dedup();
		assert_eq!(ranks.len(), count, "two states share a rank, so their order is arbitrary");
	}

	#[test]
	fn the_most_recent_change_does_not_decide_the_order() {
		let workspace = workspace();
		let waiting = workspace
			.threads()
			.find(|thread| thread.state == ThreadState::Waiting)
			.expect("a waiting thread");
		let working = workspace
			.threads()
			.find(|thread| thread.state == ThreadState::Working)
			.expect("a working thread");
		assert!(waiting.updated_ms < working.updated_ms, "the fixture cannot show the difference");
		assert!(waiting.state.rank() < working.state.rank(), "the older blocked thread sank");
	}

	#[test]
	fn a_stale_active_id_reads_as_nothing_open() {
		let workspace = workspace().active("t9");
		assert_eq!(workspace.active_thread(), None);
		assert_eq!(workspace.active_project(), None);
	}

	#[test]
	fn the_open_thread_resolves_to_its_own_project() {
		let workspace = workspace().active("t3");
		assert_eq!(
			workspace
				.active_thread()
				.map(|thread| thread.title.as_str()),
			Some("Fix the changelog render")
		);
		assert_eq!(
			workspace
				.active_project()
				.map(|project| project.name.as_str()),
			Some("site")
		);
	}

	#[test]
	fn settled_threads_are_counted_apart_from_the_rest() {
		let workspace = workspace();
		assert_eq!(workspace.open_threads().count(), 2);
		assert_eq!(workspace.settled_threads().count(), 1);
		assert_eq!(workspace.waiting(), 1);
		assert_eq!(workspace.working(), 1);
	}

	#[test]
	fn a_folded_group_still_reports_what_it_is_hiding() {
		let folded = Project::new("veyyon", "/repo/veyyon", vec![
			Thread::new("t1", "Blocked", ThreadState::Waiting),
			Thread::new("t2", "Running", ThreadState::Working),
		])
		.collapsed();
		assert!(folded.collapsed);
		assert_eq!(folded.waiting(), 1, "a folded group hides the count that made it worth opening");
	}

	#[test]
	fn only_a_person_can_unblock_the_states_that_say_so() {
		assert!(ThreadState::Waiting.needs_attention());
		assert!(ThreadState::Failed.needs_attention());
		assert!(!ThreadState::Working.needs_attention());
		assert!(!ThreadState::Idle.needs_attention());
		assert!(!ThreadState::Settled.needs_attention());
	}
}
