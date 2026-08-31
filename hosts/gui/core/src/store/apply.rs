//! Host event application, request completion, and replica synchronization.

mod event;
mod request;
mod selection;
mod snapshot;

pub(crate) use event::*;

use super::{Changes, Store};
use crate::{host::HostEvent, model::*};

impl Store {
	pub fn apply(&mut self, event: HostEvent) -> Changes {
		let mut changes = Changes::default();
		match event {
			HostEvent::ConnectionChanged(connection) => {
				let disconnected = !connection.is_connected() && self.connection.is_connected();
				let clear_preview = !connection.is_connected();
				self.connection = connection;
				changes.connection = true;
				if clear_preview {
					self.frontend.theme_preview = None;
					changes.frontend = true;
				}
				if disconnected {
					self.mark_replica_stale(StaleReason::Disconnected);
					changes.replica = true;
				}
				if let ConnectionState::Fatal { message }
				| ConnectionState::Reconnecting { message, .. } = &self.connection
				{
					let id = self.replica.notifications.next_id();
					let mut notification = Notification::new(
						id,
						NotificationKey::new("connection-failed"),
						NotificationTone::Error,
						"Connection dropped",
						0,
					);
					notification.detail = Some(message.clone());
					self.replica.notifications.push(notification);
				}
			},
			HostEvent::Snapshot(section) => {
				// A section keeps the newest revision it has seen, so a snapshot
				// at or behind that revision is discarded. Reported rather than
				// silent: a caller replaying recorded events has no other way to
				// learn that the state it thinks it installed is not there.
				changes.replica = self.apply_snapshot(section);
				changes.ignored_stale_event = !changes.replica;
			},
			HostEvent::TranscriptAppended { revision, entries } => {
				changes.replica = apply_vec_event(
					&mut self.replica.transcript,
					revision,
					|current| {
						for entry in entries {
							if let Some(known) = current.iter_mut().find(|known| known.id == entry.id) {
								*known = entry;
							} else {
								current.push(entry);
							}
						}
					},
					&mut changes.ignored_stale_event,
				);
			},
			HostEvent::TranscriptUpdated { revision, entry } => {
				changes.replica = apply_vec_event(
					&mut self.replica.transcript,
					revision,
					|current| {
						if let Some(known) = current.iter_mut().find(|known| known.id == entry.id) {
							*known = entry;
						} else {
							current.push(entry);
						}
					},
					&mut changes.ignored_stale_event,
				);
			},
			HostEvent::StreamingChanged(streaming) => {
				self.replica.streaming = streaming;
				changes.replica = true;
			},
			HostEvent::ToolUpdated { revision, tool } => {
				if tool.is_error {
					let id = self.replica.notifications.next_id();
					let mut notification = Notification::new(
						id,
						NotificationKey::new(format!("tool-error:{}", tool.id)),
						NotificationTone::Error,
						format!("Tool {} failed", tool.name),
						0,
					);
					notification.detail = tool.intent.clone();
					self.replica.notifications.push(notification);
				}
				changes.replica = apply_vec_event(
					&mut self.replica.tools,
					revision,
					|current| {
						if let Some(known) = current.iter_mut().find(|known| known.id == tool.id) {
							*known = tool;
						} else {
							current.push(tool);
						}
					},
					&mut changes.ignored_stale_event,
				);
			},
			HostEvent::InteractionPresented { revision, request } => {
				changes.replica = apply_vec_event(
					&mut self.replica.interactions,
					revision,
					|current| {
						if let Some(known) = current.iter_mut().find(|known| known.id == request.id) {
							*known = request;
						} else {
							current.push(request);
						}
					},
					&mut changes.ignored_stale_event,
				);
			},
			HostEvent::InteractionEnded { revision, interaction } => {
				changes.replica = apply_vec_event(
					&mut self.replica.interactions,
					revision,
					|current| {
						current.retain(|request| request.id != interaction);
					},
					&mut changes.ignored_stale_event,
				);
			},
			HostEvent::TerminalOutput { revision, terminal, bytes } => {
				changes.replica = apply_vec_event(
					&mut self.replica.terminals,
					revision,
					|current| {
						if let Some(run) = current.iter_mut().find(|run| run.id == terminal) {
							run.output.extend(&bytes);
							run.total_bytes = run.output.len() as u64;
						} else {
							let total_bytes = bytes.len() as u64;
							current.push(TerminalRunView {
								id: terminal,
								command: String::new(),
								cwd: String::new(),
								phase: TerminalPhase::Running,
								output: bytes,
								exit_code: None,
								signal: None,
								cancelled: false,
								truncated: false,
								total_lines: 0,
								total_bytes,
								error: None,
								artifact_id: None,
							});
						}
					},
					&mut changes.ignored_stale_event,
				);
			},
			HostEvent::OutputAdded { revision, record } => {
				changes.replica = apply_vec_event(
					&mut self.replica.output,
					revision,
					|current| {
						current.push(record);
					},
					&mut changes.ignored_stale_event,
				);
			},
			HostEvent::NoticeAdded { revision, notice } => {
				changes.replica = apply_event(
					&mut self.replica.diagnostics,
					revision,
					|current| {
						current.notices.push(notice);
					},
					&mut changes.ignored_stale_event,
				);
			},
			HostEvent::RequestSucceeded { request } => {
				self.finish_request(request, None, &mut changes)
			},
			HostEvent::RequestFailed { request, mut error } => {
				error.request = Some(request);
				self.finish_request(request, Some(error), &mut changes);
			},
			HostEvent::FatalProtocolError { message } => {
				self.connection = ConnectionState::Fatal { message: message.clone() };
				self.mark_replica_stale(StaleReason::Disconnected);
				self.frontend.theme_preview = None;
				let id = self.replica.notifications.next_id();
				let mut notification = Notification::new(
					id,
					NotificationKey::new("fatal-protocol-error"),
					NotificationTone::Error,
					"Fatal protocol error",
					0,
				);
				notification.detail = Some(message);
				self.replica.notifications.push(notification);
				changes.connection = true;
				changes.replica = true;
				changes.frontend = true;
			},
		}
		changes
	}
}
