//! Every scope the palette lists past its root is opened by a row, and a row
//! that sends a host request is refused by the capability that request needs
//! and by no other.
//!
//! WHY: a row gated by another capability than its request's is drawn
//! runnable while the host would refuse it, or refused while the host would
//! take it; a scope no row opens is a list nobody reaches. The sweep reads
//! `Capability::iter()` at run time and takes each row's request from what the
//! row runs, so a new capability, row or request is covered without an edit,
//! and a new kind of row or scope fails to compile here until it states what
//! it sends or what opens it.
//!
//! Gap: rows listed only under a state this window does not seed (a guest's
//! `/leave`, a host's `/collab stop`) are the commands suite's state test;
//! what a window action does once dispatched is its region's suite.

use std::collections::BTreeSet;

use gpui::TestAppContext;
use strum::IntoEnumIterator;
use veyyon_desktop_app::palette::{ActionData, Run, Scope};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, HostActionKind, HostEvent, SnapshotSection, action_to_capability,
};

use super::{
	arguments::catalogue,
	harness::{Win, seeded, window},
};

/// The queries whose rows the sweep reads: the root, every command, a message
/// typed after a command and a subcommand typed after its command.
const QUERIES: [&str; 4] = ["", "/", "/ask-builtin a message", "/mcp add docs"];

/// The request choosing `run` sends, or `None` for a window action.
const fn sends(run: &Run) -> Option<HostActionKind> {
	match run {
		Run::Host(action, _) => Some(action.kind()),
		Run::Argument { takes, .. } | Run::Filled { takes, .. } => Some(takes.kind()),
		Run::Command(_) | Run::Subcommands(_) => Some(HostActionKind::RunCommand),
		Run::OpenSession(_) => Some(HostActionKind::OpenSession),
		Run::CreateSession(_) | Run::CreateSessionInFolder => Some(HostActionKind::CreateSession),
		Run::ActionWith(ActionData::OpenFile { .. }) => Some(HostActionKind::ReadFile),
		Run::Action(_) | Run::ActionWith(ActionData::OpenSettings(_)) => None,
	}
}

fn withheld(capability: Capability) -> String {
	format!("{capability:?} is withheld")
}

#[gpui::test]
fn each_row_is_refused_by_the_capability_its_request_needs(app: &mut TestAppContext) {
	let mut events = seeded();
	events.push(catalogue());
	let mut w = window(app, events, true);
	w.open();
	for capability in Capability::iter() {
		let statuses = Capability::iter()
			.map(|each| {
				let status = if each == capability {
					CapabilityStatus::Unavailable { reason: withheld(each) }
				} else {
					CapabilityStatus::Available
				};
				(each, status)
			})
			.collect();
		w.apply(vec![HostEvent::Snapshot(SnapshotSection::Capabilities(statuses))]);
		for query in QUERIES {
			w.query(query);
			for row in w.rows() {
				let expected = sends(&row.run)
					.filter(|kind| action_to_capability(*kind) == capability)
					.map(|_| withheld(capability));
				assert_eq!(
					row.blocked.as_deref(),
					expected.as_deref(),
					"{:?} under {query:?} while {capability:?} is withheld",
					row.label
				);
			}
		}
	}
}

/// The name of each scope past the root, so a new scope fails to compile
/// until a row is shown to open it.
const fn opened(scope: &Scope) -> Option<&'static str> {
	match scope {
		Scope::Root => None,
		Scope::Subcommands(_) => Some("subcommands"),
		Scope::Argument { .. } => Some("argument"),
	}
}

#[gpui::test]
fn every_scope_past_the_root_is_opened_by_the_row_that_states_it(app: &mut TestAppContext) {
	let mut events = seeded();
	events.push(catalogue());
	let mut w = window(app, events, true);
	let scope = |w: &Win<'_>| {
		w.palette
			.read_with(&*w.cx, |palette, _| palette.scope().clone())
	};
	w.open();
	w.query("/");
	let openers: Vec<(String, Scope)> = w
		.rows()
		.into_iter()
		.filter_map(|row| {
			let scope = match row.run {
				Run::Subcommands(name) => Scope::Subcommands(name),
				Run::Argument { line, hint, takes } => Scope::Argument { line, hint, takes },
				_ => return None,
			};
			Some((row.label.to_string(), scope))
		})
		.collect();
	let mut reached = BTreeSet::new();
	for (label, expected) in openers {
		w.query(&label);
		w.pick(&label);
		assert!(w.is_open(), "{label:?} keeps the palette open");
		assert_eq!(scope(&w), expected, "{label:?} opens the scope it states");
		reached.extend(opened(&expected));
		w.keys("escape");
		assert_eq!(scope(&w), Scope::Root, "escape returns {label:?} to the root");
	}
	assert_eq!(reached, BTreeSet::from(["argument", "subcommands"]));
}
