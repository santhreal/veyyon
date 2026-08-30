//! Every surface a window can be showing, and the data it is showing.
//!
//! A route that were only a name — `Route::Settings` — would leave the page's
//! data somewhere else, and the two would disagree: a window on the settings
//! route holding a board because the last screen's data never got cleared. A
//! route carries its own data, so that pair is not a state that can exist.

use super::{Board, Form, PickList, Report, Splash, Tree, Wizard};
use crate::view::Diff;

/// What a window is showing.
#[derive(Debug, Clone, PartialEq)]
pub enum Route {
	/// The transcript. The route a window returns to, and the only one that is
	/// not a screen over it.
	Session,
	/// Anything chosen from a list: the model picker, the theme selector, the
	/// session list, history search.
	Pick(PickList),
	/// Anything with fields: settings, a hook editor, a provider login.
	Form(Form),
	/// Cards in columns: the todo board, the agent dashboard.
	Board(Board),
	/// Figures and rows: usage, the release list, the keybinding reference.
	Report(Report),
	/// Nested rows that open and close: the file tree, a plan's contents.
	Tree(Tree),
	/// A full-window statement with key hints: welcome, pause, a fatal error.
	Splash(Splash),
	/// Ordered steps: first-run setup, adding an MCP server.
	Wizard(Wizard),
	/// Changed lines: the diff viewer, a plan review.
	Diff(Diff),
}

impl Route {
	/// Which route this is, without its data.
	pub fn id(&self) -> RouteId {
		match self {
			Route::Session => RouteId::Session,
			Route::Pick(_) => RouteId::Pick,
			Route::Form(_) => RouteId::Form,
			Route::Board(_) => RouteId::Board,
			Route::Report(_) => RouteId::Report,
			Route::Tree(_) => RouteId::Tree,
			Route::Splash(_) => RouteId::Splash,
			Route::Wizard(_) => RouteId::Wizard,
			Route::Diff(_) => RouteId::Diff,
		}
	}

	/// Whether the route is drawn over the transcript rather than instead of it.
	///
	/// A window keeps the transcript mounted under either kind, so dismissing a
	/// route does not rebuild the scroll position. What this decides is whether
	/// the transcript still shows through.
	///
	/// A sheet shows it through a scrim, because it is answering a question
	/// about what is on screen: which model, which file, what changed. A splash
	/// and a wizard cover it. Both are reached when there is nothing behind
	/// them worth reading — a first run, a pause, a fatal stop — and a half-lit
	/// transcript under a setup step invites answering the transcript instead
	/// of the step.
	pub fn is_overlay(&self) -> bool {
		!matches!(self, Route::Session | Route::Splash(_) | Route::Wizard(_))
	}
}

/// The name of a [`Route`], with no data attached.
///
/// This is what a capture sweep and the `--route` argument name. A route added
/// to [`Route`] without a line here does not compile, because [`Route::id`] is
/// exhaustive; a route added here without a fixture turns the fixture sweep
/// red.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RouteId {
	Session,
	Pick,
	Form,
	Board,
	Report,
	Tree,
	Splash,
	Wizard,
	Diff,
}

impl RouteId {
	/// Every route, in the order [`Route`] declares them.
	pub const ALL: [RouteId; 9] = [
		RouteId::Session,
		RouteId::Pick,
		RouteId::Form,
		RouteId::Board,
		RouteId::Report,
		RouteId::Tree,
		RouteId::Splash,
		RouteId::Wizard,
		RouteId::Diff,
	];

	/// The name an operator types: `--route report`.
	pub fn key(self) -> &'static str {
		match self {
			RouteId::Session => "session",
			RouteId::Pick => "pick",
			RouteId::Form => "form",
			RouteId::Board => "board",
			RouteId::Report => "report",
			RouteId::Tree => "tree",
			RouteId::Splash => "splash",
			RouteId::Wizard => "wizard",
			RouteId::Diff => "diff",
		}
	}

	/// The route `key` names.
	pub fn parse(key: &str) -> Option<RouteId> {
		RouteId::ALL.into_iter().find(|id| id.key() == key)
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! [`RouteId`] is the name half of a data-carrying enum, and the two halves
	//! drift silently in one direction: [`Route::id`] is exhaustive so a new
	//! variant is a compile error there, but [`RouteId::ALL`] and
	//! [`RouteId::key`] are hand-written, and a route missing from `ALL` makes
	//! every sweep over it pass while never drawing that route.
	//!
	//! WHAT IT DOES NOT CATCH. Whether a route has a page. That is the sweep in
	//! the fixtures, which needs data for each one.

	use super::*;

	#[test]
	fn every_route_is_listed_once_in_all() {
		let mut keys: Vec<&str> = RouteId::ALL.iter().map(|id| id.key()).collect();
		let count = keys.len();
		keys.sort_unstable();
		keys.dedup();
		assert_eq!(keys.len(), count, "RouteId::ALL repeats a route");
	}

	#[test]
	fn every_key_parses_back_to_its_route() {
		for id in RouteId::ALL {
			assert_eq!(RouteId::parse(id.key()), Some(id), "{} did not round-trip", id.key());
		}
	}

	#[test]
	fn an_unknown_key_is_not_a_route() {
		assert_eq!(RouteId::parse("settings"), None);
		assert_eq!(RouteId::parse(""), None);
	}

	#[test]
	fn each_route_states_whether_the_transcript_shows_through_it() {
		let covering: Vec<&str> = RouteId::ALL
			.iter()
			.filter(|id| !crate::fixtures::routes::route(**id).is_overlay())
			.map(|id| id.key())
			.collect();
		assert_eq!(
			covering,
			vec!["session", "splash", "wizard"],
			"a route changed what it does to the transcript behind it"
		);
	}
}
