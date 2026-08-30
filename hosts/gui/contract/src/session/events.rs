//! Input events a renderer reports back to the session.
//!
//! Mirrors `@veyyon/wire/presentation/events`. The direction is one way: the
//! session sends view-models down, the renderer sends these up. Nothing here
//! carries a callback or a handle, so an event survives the transport
//! unchanged.

use serde::{Deserialize, Serialize};

use crate::session::{overlay::DialogResult, transcript::Attachment};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum UiEvent {
	/// The operator submitted the composer.
	Submit { text: String, attachments: Vec<Attachment> },
	/// The operator asked the current turn to stop.
	Interrupt,
	/// The operator scrolled the transcript. Negative walks back into history.
	Scroll { delta: i32 },
	/// The operator jumped the transcript to the live tail.
	ScrollToLive,
	/// The operator answered a tool-approval prompt.
	#[serde(rename = "select-tool-approval", rename_all = "camelCase")]
	SelectToolApproval {
		tool_call_id: String,
		approved:     bool,
		/// True when the answer applies to later calls of the same tool.
		remember:     bool,
	},
	/// A dialog closed with an answer.
	#[serde(rename_all = "camelCase")]
	DialogResult { dialog_id: String, result: DialogResult },
	/// The operator ran a slash command.
	Command { command: String, args: String },
	/// The rendering surface changed size.
	Resize { width: u32, height: u32 },
	/// The composer's text or cursor changed. Sent as the operator types.
	#[serde(rename_all = "camelCase")]
	ComposerChange { text: String, cursor_offset: u32 },
	/// The operator asked to leave the session.
	Exit {
		/// True when the operator wants the session kept for a later resume.
		save: bool,
	},
}

#[cfg(test)]
mod tests {
	use super::*;

	/// The one event whose tag is not its variant name in kebab-case.
	/// `SelectToolApproval` would derive `select-tool-approval` anyway, so this
	/// asserts the explicit rename did not change it — a rename that drifts from
	/// the derived spelling is an event the session drops.
	#[test]
	fn the_tool_approval_event_keeps_its_wire_tag() {
		let event = UiEvent::SelectToolApproval {
			tool_call_id: "c1".into(),
			approved:     true,
			remember:     false,
		};
		let json = serde_json::to_string(&event).expect("serializes");
		assert!(json.contains(r#""type":"select-tool-approval""#), "{json}");
		assert!(json.contains(r#""toolCallId":"c1""#), "{json}");
	}

	/// A unit event is its tag alone. `interrupt` is sent on every escape, and a
	/// payload the session does not expect would fail the whole message.
	#[test]
	fn a_unit_event_serializes_as_its_tag_alone() {
		assert_eq!(serde_json::to_string(&UiEvent::Interrupt).unwrap(), r#"{"type":"interrupt"}"#);
		assert_eq!(
			serde_json::to_string(&UiEvent::ScrollToLive).unwrap(),
			r#"{"type":"scroll-to-live"}"#
		);
	}

	/// A negative scroll delta survives. It is how the renderer says "back into
	/// history", and an unsigned field would turn it into a jump forward.
	#[test]
	fn a_negative_scroll_delta_survives() {
		let event: UiEvent =
			serde_json::from_str(r#"{ "type": "scroll", "delta": -12 }"#).expect("deserializes");
		assert_eq!(event, UiEvent::Scroll { delta: -12 });
	}

	/// A nested dialog result keeps its own tag inside the event's.
	#[test]
	fn a_nested_dialog_result_keeps_its_tag() {
		let event = UiEvent::DialogResult {
			dialog_id: "d1".into(),
			result:    DialogResult::Approved { remember: true },
		};
		let json = serde_json::to_string(&event).expect("serializes");
		assert!(json.contains(r#""type":"dialog-result""#), "{json}");
		assert!(json.contains(r#""outcome":"approved""#), "{json}");

		let back: UiEvent = serde_json::from_str(&json).expect("deserializes");
		assert_eq!(back, event);
	}

	/// Every event round-trips through the wire shape unchanged.
	#[test]
	fn every_event_round_trips() {
		for event in crate::fixtures::ui_events() {
			let json = serde_json::to_string(&event).expect("serializes");
			let back: UiEvent =
				serde_json::from_str(&json).unwrap_or_else(|error| panic!("{json}: {error}"));
			assert_eq!(back, event, "{json}");
		}
	}
}
