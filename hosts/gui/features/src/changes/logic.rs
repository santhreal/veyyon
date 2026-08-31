//! Pure presentation decisions for the Changes route.

use veyyon_gui_core::{
	Store,
	model::{
		Capability, CapabilityStatus, ChangeScope, ChangedFileView, ChangesSnapshot, ConnectionState,
		EntryId, FileId, RemoteData, StaleReason, Versioned,
	},
	text::diff::{Change, FileDiff},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Summary {
	pub files:     u64,
	pub additions: u64,
	pub deletions: u64,
}

impl Summary {
	pub fn from_snapshot(snapshot: &ChangesSnapshot) -> Self {
		let mut summary = Self { files: snapshot.files.len() as u64, ..Self::default() };
		for file in &snapshot.files {
			summary.additions = summary.additions.saturating_add(file.additions);
			summary.deletions = summary.deletions.saturating_add(file.deletions);
		}
		summary
	}
}

pub struct Ready<'a> {
	pub versioned:     &'a Versioned<ChangesSnapshot>,
	pub stale:         Option<&'a StaleReason>,
	pub refresh_error: Option<&'a str>,
}

pub enum SurfaceState<'a> {
	Detached,
	Loading,
	Empty,
	Ready(Ready<'a>),
	Unavailable(&'a str),
	Error { message: &'a str, retryable: bool },
	Fatal(&'a str),
}

pub fn surface(store: &Store) -> SurfaceState<'_> {
	if let ConnectionState::Fatal { message } = &store.connection {
		return SurfaceState::Fatal(message);
	}
	if let CapabilityStatus::Unavailable { reason } = store.replica.capability(Capability::Changes) {
		return SurfaceState::Unavailable(reason.as_str());
	}

	match &store.replica.changes {
		RemoteData::Unrequested => {
			if matches!(store.connection, ConnectionState::Detached) {
				SurfaceState::Detached
			} else {
				SurfaceState::Loading
			}
		},
		RemoteData::Loading { .. } => SurfaceState::Loading,
		RemoteData::Empty => SurfaceState::Empty,
		RemoteData::Ready(versioned) => ready_or_empty(versioned, None, None),
		RemoteData::Stale { value, reason } => ready_or_empty(value, Some(reason), None),
		RemoteData::Error { message, retryable, stale } => match stale {
			Some(value) => ready_or_empty(value, None, Some(message.as_str())),
			None => SurfaceState::Error { message, retryable: *retryable },
		},
	}
}

fn ready_or_empty<'a>(
	versioned: &'a Versioned<ChangesSnapshot>,
	stale: Option<&'a StaleReason>,
	refresh_error: Option<&'a str>,
) -> SurfaceState<'a> {
	if versioned.value.files.is_empty() && versioned.value.parsed.is_empty() {
		SurfaceState::Empty
	} else {
		SurfaceState::Ready(Ready { versioned, stale, refresh_error })
	}
}

pub fn selected_index(snapshot: &ChangesSnapshot, selected: Option<&FileId>) -> Option<usize> {
	selected
		.and_then(|selected| snapshot.files.iter().position(|file| &file.id == selected))
		.or_else(|| (!snapshot.files.is_empty()).then_some(0))
}

pub fn parsed_file(snapshot: &ChangesSnapshot, file: usize) -> Option<&FileDiff> {
	let changed = snapshot.files.get(file)?;
	snapshot
		.parsed
		.get(file)
		.filter(|parsed| parsed.path() == changed.path)
		.or_else(|| {
			snapshot
				.parsed
				.iter()
				.find(|parsed| parsed.path() == changed.path)
		})
}

pub fn file_status(file: Option<&FileDiff>, summary: &ChangedFileView) -> &'static str {
	if summary.binary {
		return "binary";
	}
	match file.map(|file| file.change) {
		Some(Change::Added) => "added",
		Some(Change::Removed) => "deleted",
		Some(Change::Renamed) => "renamed",
		Some(Change::Modified) | None => "modified",
	}
}

pub fn scope_name(scope: &ChangeScope) -> &str {
	match scope {
		ChangeScope::WorkingTree => "Working tree",
		ChangeScope::Session => "Conversation",
		ChangeScope::Entry(_) => "Latest turn",
		ChangeScope::Custom(name) => name,
	}
}

/// Every scope tab to show, in order, for the scope a snapshot arrived under
/// and the entry the user has selected.
///
/// The current scope is always one of them. A host may report a scope this
/// frontend has no fixed tab for, or an entry other than the selected one, and
/// a strip where no tab is current names nothing the user can act on.
pub fn scope_choices(current: &ChangeScope, entry: Option<&EntryId>) -> Vec<ChangeScope> {
	let mut choices = vec![ChangeScope::WorkingTree, ChangeScope::Session];
	// One turn tab, and the scope the snapshot arrived under takes it: two tabs
	// both reading "Latest turn" are two tabs the user cannot tell apart.
	let turn = match current {
		ChangeScope::Entry(current) => Some(current),
		_ => entry,
	};
	if let Some(turn) = turn {
		choices.push(ChangeScope::Entry(turn.clone()));
	}
	if !choices.contains(current) {
		choices.push(current.clone());
	}
	choices
}

pub fn stale_message(reason: &StaleReason) -> &str {
	match reason {
		StaleReason::Disconnected => "Disconnected. Showing the last received changes.",
		StaleReason::Reconnecting => "Reconnecting. Showing the last received changes.",
		StaleReason::RevisionGap { .. } => "The change stream skipped a revision. Refresh to resync.",
		StaleReason::RefreshFailed(_) => "Refresh failed. Showing the previous changes.",
	}
}

#[cfg(test)]
mod tests {
	//! WHY: a changes snapshot carries the scope it was produced under, and the
	//! strip used to hold three fixed tabs. A scope outside that set — a host's
	//! custom scope, or an entry other than the selected one — left every tab
	//! inactive, so the surface showed a diff and named no scope for it. These
	//! pin the invariant instead of the two reported shapes.
	//!
	//! Not covered: the painted strip. These are the decisions behind it.

	use super::*;

	fn entry(id: &str) -> EntryId {
		EntryId::new(id).expect("a nonempty entry id")
	}

	/// An exhaustive match with no wildcard: a new `ChangeScope` variant fails
	/// to compile here until it is listed, so the sweeps below cannot go stale.
	fn every_scope() -> Vec<ChangeScope> {
		let sample = ChangeScope::WorkingTree;
		match &sample {
			ChangeScope::WorkingTree
			| ChangeScope::Session
			| ChangeScope::Entry(_)
			| ChangeScope::Custom(_) => (),
		}
		vec![
			ChangeScope::WorkingTree,
			ChangeScope::Session,
			ChangeScope::Entry(entry("entry-7")),
			ChangeScope::Custom("Staged".to_owned()),
		]
	}

	#[test]
	fn the_strip_always_offers_the_scope_the_snapshot_arrived_under() {
		for selected in [None, Some(entry("entry-1"))] {
			for scope in every_scope() {
				let choices = scope_choices(&scope, selected.as_ref());
				assert!(
					choices.contains(&scope),
					"{scope:?} is missing from {choices:?} with selected {selected:?}"
				);
				assert_eq!(
					choices.iter().filter(|choice| *choice == &scope).count(),
					1,
					"{scope:?} is offered twice in {choices:?}"
				);
				assert!(
					choices
						.iter()
						.filter(|choice| matches!(choice, ChangeScope::Entry(_)))
						.count() <= 1,
					"two turn tabs in {choices:?}"
				);
			}
		}
	}

	#[test]
	fn every_offered_scope_is_named_and_named_once() {
		for scope in every_scope() {
			for choices in
				[scope_choices(&scope, None), scope_choices(&scope, Some(&entry("entry-1")))]
			{
				let mut names: Vec<&str> = choices.iter().map(scope_name).collect();
				assert!(names.iter().all(|name| !name.trim().is_empty()));
				names.sort_unstable();
				let named = names.len();
				names.dedup();
				assert_eq!(names.len(), named, "two tabs share a label: {names:?}");
			}
		}
	}

	#[test]
	fn the_working_tree_and_the_conversation_are_the_fixed_tabs() {
		assert_eq!(scope_choices(&ChangeScope::WorkingTree, None), vec![
			ChangeScope::WorkingTree,
			ChangeScope::Session
		]);
	}

	#[test]
	fn a_selected_entry_adds_the_latest_turn_and_nothing_else() {
		assert_eq!(scope_choices(&ChangeScope::Session, Some(&entry("entry-1"))), vec![
			ChangeScope::WorkingTree,
			ChangeScope::Session,
			ChangeScope::Entry(entry("entry-1")),
		]);
	}

	#[test]
	fn a_host_scope_outside_the_fixed_set_is_appended_last() {
		let custom = ChangeScope::Custom("Staged".to_owned());
		assert_eq!(scope_choices(&custom, None), vec![
			ChangeScope::WorkingTree,
			ChangeScope::Session,
			custom
		]);
	}

	#[test]
	fn a_snapshot_from_another_turn_takes_the_turn_tab() {
		let choices = scope_choices(&ChangeScope::Entry(entry("entry-9")), Some(&entry("entry-1")));
		assert_eq!(choices, vec![
			ChangeScope::WorkingTree,
			ChangeScope::Session,
			ChangeScope::Entry(entry("entry-9")),
		]);
	}
}
