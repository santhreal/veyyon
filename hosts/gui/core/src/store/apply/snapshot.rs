//! Snapshot section assimilation into replica state.

use super::Store;
use crate::{
	host::{HostAction, SnapshotSection},
	model::*,
	store::{CommandTarget, Completion, Effects},
};

impl Store {
	pub(super) fn apply_snapshot(&mut self, section: SnapshotSection) -> bool {
		match section {
			SnapshotSection::Workspaces(value) => replace_newer(&mut self.replica.workspaces, value),
			SnapshotSection::Sessions(value, unreadable) => {
				let changed = replace_newer(&mut self.replica.sessions.sessions, value);
				if changed {
					self.replica.sessions.unreadable = unreadable;
					self.adopt_session_selection();
				}
				changed
			},
			SnapshotSection::ActiveSession(value) => {
				let changed = replace_newer(&mut self.replica.active_session, value);
				if changed {
					self.adopt_session_selection();
				}
				changed
			},
			SnapshotSection::Transcript(value) => replace_newer(&mut self.replica.transcript, value),
			SnapshotSection::TranscriptPaging(value) => {
				replace_newer(&mut self.replica.transcript_paging, value)
			},
			SnapshotSection::Runtime(value) => replace_newer(&mut self.replica.runtime, value),
			SnapshotSection::Tools(value) => replace_newer(&mut self.replica.tools, value),
			SnapshotSection::Interactions(value) => {
				replace_newer(&mut self.replica.interactions, value)
			},
			SnapshotSection::Plan(value) => replace_newer(&mut self.replica.plan, value),
			SnapshotSection::Files(value) => {
				let changed = replace_newer(&mut self.replica.files, value);
				if changed {
					self.recompute_visible_files();
				}
				changed
			},
			SnapshotSection::Changes(mut value) => {
				if value.value.parsed.is_empty()
					&& let Some(raw) = value.value.raw_diff.as_deref()
				{
					value.value.parsed = crate::text::diff::parse(raw);
				}
				let changed = replace_newer(&mut self.replica.changes, value);
				if changed && let Some(versioned) = self.replica.changes.readable() {
					self.frontend.review.remap_anchors(&versioned.value.parsed);
				}
				changed
			},
			SnapshotSection::Terminals(value) => replace_newer(&mut self.replica.terminals, value),
			SnapshotSection::Processes(value, completions) => {
				let changed = replace_newer(&mut self.replica.processes.processes, value);
				if changed {
					self.replica.processes.completions = completions;
				}
				changed
			},
			SnapshotSection::Output(value) => replace_newer(&mut self.replica.output, value),
			SnapshotSection::Models(value) => replace_newer(&mut self.replica.models, value),
			SnapshotSection::Providers(value) => replace_newer(&mut self.replica.providers, value),
			SnapshotSection::Authentication(value) => replace_newer(&mut self.replica.auth, value),
			SnapshotSection::Mcp(value) => replace_newer(&mut self.replica.mcp, value),
			SnapshotSection::Extensions(value) => replace_newer(&mut self.replica.extensions, value),
			SnapshotSection::Agents(value) => replace_newer(&mut self.replica.agents, value),
			SnapshotSection::Tasks(value) => replace_newer(&mut self.replica.tasks, value),
			SnapshotSection::Settings(value) => replace_newer(&mut self.replica.settings, value),
			SnapshotSection::Themes(value) => replace_newer(&mut self.replica.themes, value),
			SnapshotSection::Keybindings(value) => replace_newer(&mut self.replica.keybindings, value),
			SnapshotSection::Diagnostics(value) => replace_newer(&mut self.replica.diagnostics, value),
			SnapshotSection::Usage(value) => replace_newer(&mut self.replica.usage, value),
			SnapshotSection::Context(value) => replace_newer(&mut self.replica.context, value),
			SnapshotSection::Lifecycle(value) => replace_newer(&mut self.replica.lifecycle, value),
			SnapshotSection::Capabilities(values) => {
				self.replica.capabilities = values.into_iter().collect();
				self.ask_for_what_the_window_opens_on();
				true
			},
		}
	}

	/// Ask for the values the opening route draws, once the engine has stated
	/// what it can answer.
	///
	/// A window that attaches and asks for nothing draws an empty product with a
	/// reload control on it, which reads as an engine with no sessions rather
	/// than a window that never asked. Nothing requested this, so it is silent:
	/// an engine that does not report the capability, or a replica that already
	/// holds the value, is left alone rather than reported as a refusal.
	fn ask_for_what_the_window_opens_on(&mut self) {
		if !matches!(self.replica.sessions.sessions, RemoteData::Unrequested)
			|| self.request_pending(&CommandTarget::Sessions)
			|| !matches!(self.replica.capability(Capability::Sessions), CapabilityStatus::Available)
		{
			return;
		}
		let mut discarded = Effects::default();
		self.emit(
			HostAction::ListSessions,
			CommandTarget::Sessions,
			Completion::None,
			&mut discarded,
		);
	}
}

pub(crate) fn replace_newer<T>(
	slot: &mut RemoteData<Versioned<T>>,
	incoming: Versioned<T>,
) -> bool {
	if slot
		.readable()
		.is_some_and(|current| current.revision >= incoming.revision)
	{
		return false;
	}
	*slot = RemoteData::Ready(incoming);
	true
}
