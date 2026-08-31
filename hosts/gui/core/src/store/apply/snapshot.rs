//! Snapshot section assimilation into replica state.

use super::Store;
use crate::{host::SnapshotSection, model::*};

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
				replace_newer(&mut self.replica.changes, value)
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
				true
			},
		}
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
