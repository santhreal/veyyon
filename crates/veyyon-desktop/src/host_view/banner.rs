//! Connection-state banner projection and host stderr enrichment.
//!
//! A host failure whose reason exists is shown on the banner rather than
//! discarding the child's stderr: the startup path, which ends in
//! `HostSpawnError::ExitedBeforeListening`, and every later transport state
//! that carries a message (`Reconnecting` and `Fatal`).

use veyyon_desktop::{Attachment, HostStderr};
use veyyon_desktop_model::HostEvent;
use veyyon_desktop_surface::{ShellView, attach::ConnectionPhase};
use veyyon_gpui::Context;

/// How many of the host's last stderr lines the connection banner carries.
///
/// The banner is one line of a card, so the reason is the tail of the
/// stream, not the stream.
const HOST_WORDS_LINES: usize = 3;

/// Formats the initial connection notice when starting to attach.
pub(super) fn initial_notice(attachment: &Attachment) -> String {
	match &attachment.spawned {
		Ok(Some(child)) => {
			format!("started veyyon gui (pid {}) at {}", child.pid, attachment.endpoint)
		},
		Ok(None) => format!("attaching to {}", attachment.endpoint),
		Err(error) => format!("Host startup: {error}; connecting to {}", attachment.endpoint),
	}
}

/// What a batch of host events decided about the connection notice.
///
/// Three states, because clearing the notice and leaving the one on screen
/// are different answers: a batch that saw no connection event repaints
/// whatever the last one set, and a batch that reached `Connected` takes the
/// notice down.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum NoticeUpdate {
	/// No event in the batch spoke about the notice.
	Unchanged,
	/// The notice the batch decided on, `None` taking it down.
	Set(Option<String>),
}

/// Sets the view notice and fatal connection phase when transport startup
/// fails.
pub(super) fn record_transport_failure(
	view: &mut ShellView,
	error: &std::io::Error,
	cx: &mut Context<ShellView>,
) {
	view.set_notice(Some(format!("transport failed to start: {error}")), cx);
	view.state_mut().connection = ConnectionPhase::Fatal { message: error.to_string() };
	cx.notify();
}

/// The host child's stderr tail and any error that occurred during startup,
/// used to enrich connection-state messages on the banner.
pub(super) struct ConnectionBanner {
	host_words:    Option<HostStderr>,
	startup_error: Option<String>,
}

impl ConnectionBanner {
	pub(super) fn new(attachment: &Attachment) -> Self {
		let host_words = attachment
			.spawned
			.as_ref()
			.ok()
			.and_then(Option::as_ref)
			.map(|child| child.stderr.clone());
		let startup_error = attachment
			.spawned
			.as_ref()
			.err()
			.map(|error| error.to_string());
		Self { host_words, startup_error }
	}

	/// Enriches reconnecting and fatal connection events with the host child's
	/// stderr tail, and clears startup errors once connected.
	pub(super) fn enrich_batch(&mut self, batch: &mut [HostEvent]) -> Option<String> {
		for event in batch {
			match event {
				HostEvent::ConnectionChanged(veyyon_desktop_model::ConnectionState::Connected {
					..
				}) => self.startup_error = None,
				HostEvent::ConnectionChanged(
					veyyon_desktop_model::ConnectionState::Reconnecting { message, .. }
					| veyyon_desktop_model::ConnectionState::Fatal { message },
				) => {
					if let Some(words) = self
						.host_words
						.as_ref()
						.and_then(|kept| kept.last_words(HOST_WORDS_LINES))
					{
						*message = format!("{message}: {words}");
					}
				},
				_ => {},
			}
		}
		self.startup_error.clone()
	}

	/// Appends the startup error to the connection notice when present.
	pub(super) fn apply_startup_error(startup_notice: Option<&str>, notice: &mut NoticeUpdate) {
		if let Some(error) = startup_notice {
			let status = match std::mem::replace(notice, NoticeUpdate::Unchanged) {
				NoticeUpdate::Set(Some(status)) => status,
				NoticeUpdate::Unchanged | NoticeUpdate::Set(None) => {
					"waiting for connection".to_string()
				},
			};
			*notice = NoticeUpdate::Set(Some(format!("Host startup: {error}; {status}")));
		}
	}
}

#[cfg(test)]
mod tests {
	use veyyon_desktop_model::ConnectionState;

	use super::*;

	#[test]
	fn initial_notice_formats_expected_variants() {
		let endpoint =
			veyyon_desktop::Endpoint::parse("unix:/tmp/test.sock", None).expect("valid endpoint");
		let without_child = Attachment { endpoint: endpoint.clone(), spawned: Ok(None) };
		assert_eq!(initial_notice(&without_child), "attaching to unix:/tmp/test.sock");

		let with_err =
			Attachment { endpoint, spawned: Err(veyyon_desktop::HostSpawnError::NoBinary) };
		assert_eq!(
			initial_notice(&with_err),
			"Host startup: no `veyyon` binary on PATH; install veyyon or set VEYYON_BIN to the \
			 binary; connecting to unix:/tmp/test.sock"
		);
	}

	#[test]
	fn apply_startup_error_augments_notice_or_sets_waiting() {
		let mut notice = NoticeUpdate::Unchanged;
		ConnectionBanner::apply_startup_error(Some("spawn failed"), &mut notice);
		assert_eq!(
			notice,
			NoticeUpdate::Set(Some("Host startup: spawn failed; waiting for connection".into()))
		);

		let mut notice = NoticeUpdate::Set(Some("connecting (attempt 1)".into()));
		ConnectionBanner::apply_startup_error(Some("spawn failed"), &mut notice);
		assert_eq!(
			notice,
			NoticeUpdate::Set(Some("Host startup: spawn failed; connecting (attempt 1)".into()))
		);

		let mut untouched = NoticeUpdate::Set(None);
		ConnectionBanner::apply_startup_error(None, &mut untouched);
		assert_eq!(untouched, NoticeUpdate::Set(None));
	}

	#[test]
	fn enrich_batch_clears_startup_error_on_connected() {
		let mut banner =
			ConnectionBanner { host_words: None, startup_error: Some("failed initially".into()) };
		let mut batch = vec![HostEvent::ConnectionChanged(ConnectionState::Connected {
			endpoint: "unix:/tmp/test.sock".into(),
			protocol: 1,
		})];
		let startup = banner.enrich_batch(&mut batch);
		assert_eq!(startup, None);
		assert_eq!(banner.startup_error, None);
	}
}
