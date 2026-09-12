//! History responses never overwrite the active transcript or composer.

use veyyon_desktop_model::{
	BackendError, Capability, ErrorScope, HostAction, RequestId, RequestRegistry, Store,
	TranscriptTree,
};
use veyyon_desktop_surface::{
	Intent, Overlay, PaletteItem, PaletteItemKind, ShellState, palette::PaletteMeta,
};

use super::transcript::turns;

const DAY_MS: u64 = 86_400_000;

/// Date buckets are UTC calendar days, rather than rolling 24-hour periods.
pub fn history_date(modified_ms: u64, now_ms: u64) -> String {
	let today = now_ms / DAY_MS;
	let date = modified_ms / DAY_MS;
	match today.checked_sub(date) {
		Some(0) => "Today (UTC)".into(),
		Some(1) => "Yesterday (UTC)".into(),
		Some(days) => format!("{days} days ago (UTC)"),
		None => format!("In {} days (UTC)", date - today),
	}
}

pub fn project_history(store: &Store, state: &mut ShellState, now_ms: u64) {
	match &mut state.overlay {
		Some(Overlay::Palette(palette)) if palette.is_history() => {
			let Some(found) = &store.domains.session_search else {
				return;
			};
			if found.query != palette.query() || palette.notice.is_some() {
				return;
			}
			let mut sessions: Vec<_> = found.sessions.iter().collect();
			sessions.sort_by(|a, b| {
				(b.modified_at_ms / DAY_MS)
					.cmp(&(a.modified_at_ms / DAY_MS))
					.then_with(|| a.cwd.cmp(&b.cwd))
					.then_with(|| b.modified_at_ms.cmp(&a.modified_at_ms))
					.then_with(|| a.path.cmp(&b.path))
			});
			palette.set_host_items(
				sessions
					.into_iter()
					.enumerate()
					.map(|(index, session)| PaletteItem {
						id:         index as u64 + 1,
						title:      session
							.title
							.clone()
							.or_else(|| session.first_message.clone())
							.filter(|title| !title.is_empty())
							.unwrap_or_else(|| "Untitled session".into()),
						subtitle:   session.first_message.clone(),
						group:      Some(format!(
							"{} · {}",
							history_date(session.modified_at_ms, now_ms),
							session.cwd
						)),
						search:     None,
						badge:      None,
						meta:       Some(PaletteMeta::Note(format!(
							"{} messages · Preview",
							session.message_count
						))),
						capability: Some(Capability::Transcript),
						kind:       PaletteItemKind::Command {
							intent: Box::new(Intent::PreviewSession(session.id.0.clone())),
						},
					})
					.collect(),
			);
		},
		Some(Overlay::History(preview)) => {
			let Some(found) = &store.domains.session_preview else {
				return;
			};
			if found.session.0 != preview.session
				|| preview.error.is_some()
				|| preview.revision == Some(found.transcript.revision)
			{
				return;
			}
			let mut tree = TranscriptTree::new();
			for entry in &found.transcript.value {
				tree.append(entry.clone());
			}
			preview.turns = turns(&tree).turns;
			preview.revision = Some(found.transcript.revision);
			preview.loading = false;
		},
		_ => {},
	}
}

/// Only the newest request for the currently drawn target can report a failure.
#[derive(Debug, Default)]
pub struct HistoryRequests {
	search:  Option<(RequestId, String)>,
	preview: Option<(RequestId, String)>,
}

impl HistoryRequests {
	pub fn sent(&mut self, request: RequestId, action: &HostAction) {
		match action {
			HostAction::SearchSessions { query } => self.search = Some((request, query.clone())),
			HostAction::PreviewSessionTranscript { session } => {
				self.preview = Some((request, session.0.clone()));
			},
			_ => {},
		}
	}

	pub fn finished(&mut self, request: RequestId) {
		if self.search.as_ref().is_some_and(|(id, _)| *id == request) {
			self.search = None;
		}
		if self.preview.as_ref().is_some_and(|(id, _)| *id == request) {
			self.preview = None;
		}
	}

	pub fn expire(
		&mut self,
		now_ms: u64,
		registry: &mut RequestRegistry,
		state: &mut ShellState,
	) -> bool {
		let mut changed = false;
		for (request, scope, message) in [
			(
				self.search.as_ref().map(|(id, _)| *id),
				ErrorScope::Session,
				"Session search timed out. Retry the search.",
			),
			(
				self.preview.as_ref().map(|(id, _)| *id),
				ErrorScope::Transcript,
				"Session preview timed out. Retry loading the transcript.",
			),
		] {
			let Some(request) = request else { continue };
			// Registration can prune an expired request before the next clock tick.
			// Terminal responses remove feature tracking through `finished` first.
			if registry.get(&request).is_some_and(|pending| {
				now_ms.saturating_sub(pending.issued_at_ms) <= pending.timeout_ms
			}) {
				continue;
			}
			registry.complete(&request);
			changed |= self.land_failure(
				&BackendError {
					scope,
					code: Some("HISTORY_REQUEST_TIMEOUT".into()),
					message: message.into(),
					retryable: true,
					request: Some(request),
					occurred_at_ms: now_ms,
				},
				state,
			);
			self.finished(request);
		}
		changed
	}

	pub fn land_failure(&mut self, error: &BackendError, state: &mut ShellState) -> bool {
		let Some(request) = error.request else {
			return false;
		};
		match &mut state.overlay {
			Some(Overlay::Palette(palette))
				if palette.is_history()
					&& self
						.search
						.as_ref()
						.is_some_and(|(id, query)| *id == request && query == palette.query()) =>
			{
				palette.set_host_items(Vec::new());
				palette.notice = Some(error.message.clone());
				self.search = None;
				return true;
			},
			Some(Overlay::History(preview))
				if self
					.preview
					.as_ref()
					.is_some_and(|(id, session)| *id == request && session == &preview.session) =>
			{
				preview.loading = false;
				preview.error = Some(error.message.clone());
				self.preview = None;
				return true;
			},
			_ => {},
		}
		false
	}
}
