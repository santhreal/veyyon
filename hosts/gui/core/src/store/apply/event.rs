//! Incremental stream, transcript, terminal, and diagnostic event reducers.

use super::Store;
use crate::model::*;

impl Store {
	pub(crate) fn mark_replica_stale(&mut self, reason: StaleReason) {
		self.replica.workspaces.mark_stale(reason.clone());
		self.replica.sessions.sessions.mark_stale(reason.clone());
		self.replica.active_session.mark_stale(reason.clone());
		self.replica.transcript.mark_stale(reason.clone());
		self.replica.transcript_paging.mark_stale(reason.clone());
		self.replica.runtime.mark_stale(reason.clone());
		self.replica.tools.mark_stale(reason.clone());
		self.replica.interactions.mark_stale(reason.clone());
		self.replica.plan.mark_stale(reason.clone());
		self.replica.files.mark_stale(reason.clone());
		self.replica.changes.mark_stale(reason.clone());
		self.replica.terminals.mark_stale(reason.clone());
		self.replica.processes.processes.mark_stale(reason.clone());
		self.replica.output.mark_stale(reason.clone());
		self.replica.models.mark_stale(reason.clone());
		self.replica.providers.mark_stale(reason.clone());
		self.replica.auth.mark_stale(reason.clone());
		self.replica.mcp.mark_stale(reason.clone());
		self.replica.extensions.mark_stale(reason.clone());
		self.replica.agents.mark_stale(reason.clone());
		self.replica.tasks.mark_stale(reason.clone());
		self.replica.settings.mark_stale(reason.clone());
		self.replica.themes.mark_stale(reason.clone());
		self.replica.keybindings.mark_stale(reason.clone());
		self.replica.diagnostics.mark_stale(reason.clone());
		self.replica.usage.mark_stale(reason.clone());
		self.replica.context.mark_stale(reason.clone());
		self.replica.lifecycle.mark_stale(reason);
	}
}

pub(crate) fn apply_event<T, F>(
	slot: &mut RemoteData<Versioned<T>>,
	revision: u64,
	update: F,
	ignored: &mut bool,
) -> bool
where
	F: FnOnce(&mut T),
{
	let current_revision = match slot {
		RemoteData::Ready(current) => current.revision,
		_ => {
			*ignored = true;
			return false;
		},
	};
	if revision <= current_revision {
		*ignored = true;
		return false;
	}
	if revision != current_revision.saturating_add(1) {
		let prior = std::mem::replace(slot, RemoteData::Unrequested);
		if let RemoteData::Ready(value) = prior {
			*slot = RemoteData::Stale {
				value,
				reason: StaleReason::RevisionGap {
					expected: current_revision.saturating_add(1),
					received: revision,
				},
			};
		}
		*ignored = true;
		return true;
	}
	if let RemoteData::Ready(current) = slot {
		update(&mut current.value);
		current.revision = revision;
		true
	} else {
		false
	}
}

pub(crate) fn apply_vec_event<T, F>(
	slot: &mut RemoteData<Versioned<Vec<T>>>,
	revision: u64,
	update: F,
	ignored: &mut bool,
) -> bool
where
	F: FnOnce(&mut Vec<T>),
{
	let current_revision = match slot {
		RemoteData::Ready(current) => current.revision,
		_ => {
			*ignored = true;
			return false;
		},
	};
	if revision <= current_revision {
		*ignored = true;
		return false;
	}
	if revision != current_revision.saturating_add(1) {
		let prior = std::mem::replace(slot, RemoteData::Unrequested);
		if let RemoteData::Ready(value) = prior {
			*slot = RemoteData::Stale {
				value,
				reason: StaleReason::RevisionGap {
					expected: current_revision.saturating_add(1),
					received: revision,
				},
			};
		}
		*ignored = true;
		return true;
	}
	if let RemoteData::Ready(current) = slot {
		update(&mut current.value);
		current.revision = revision;
		true
	} else {
		false
	}
}
