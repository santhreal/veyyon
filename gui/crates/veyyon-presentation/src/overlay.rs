//! Dialog and overlay view-models, and the answers a renderer sends back.
//!
//! Mirrors `@veyyon/wire/presentation/overlay`. A dialog is a question with a
//! result. An overlay is a surface with a lifetime.

use serde::{Deserialize, Serialize};

/// Where an overlay sits relative to the viewport.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OverlayAnchor {
	Center,
	Top,
	Bottom,
	Fullscreen,
}

/// One selectable row in a list dialog.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectOption {
	/// Value reported back when the row is chosen.
	pub value:       String,
	pub label:       String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description: Option<String>,
	/// True when the row cannot be chosen.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub disabled:    Option<bool>,
}

impl SelectOption {
	/// True when the operator may choose this row. An absent `disabled` means
	/// selectable, which is what the TypeScript optional means.
	pub fn selectable(&self) -> bool {
		!self.disabled.unwrap_or(false)
	}
}

/// A modal question.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DialogViewModel {
	#[serde(rename_all = "camelCase")]
	Confirm {
		id:            String,
		title:         String,
		body:          String,
		confirm_label: String,
		cancel_label:  String,
		/// True when the destructive action is the default.
		destructive:   bool,
	},
	#[serde(rename_all = "camelCase")]
	Select {
		id:             String,
		title:          String,
		options:        Vec<SelectOption>,
		/// Index pre-highlighted when the dialog opens.
		selected_index: i32,
		/// True when the operator may choose several rows.
		multi:          bool,
		/// True when the list filters as the operator types.
		filterable:     bool,
	},
	#[serde(rename_all = "camelCase")]
	Prompt {
		id:            String,
		title:         String,
		placeholder:   String,
		/// Text the input opens with.
		initial_value: String,
		/// True when the input must not be echoed.
		masked:        bool,
	},
	/// A tool call waiting for the operator to allow or refuse it.
	#[serde(rename_all = "camelCase")]
	ToolApproval {
		id:           String,
		tool_call_id: String,
		tool_name:    String,
		/// Arguments rendered for display; secrets already redacted.
		input:        String,
		/// What the tool will change, when the tool can say.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		impact:       Option<String>,
	},
}

impl DialogViewModel {
	/// The dialog's id. A result is correlated by it, so every variant has one.
	pub fn id(&self) -> &str {
		match self {
			DialogViewModel::Confirm { id, .. }
			| DialogViewModel::Select { id, .. }
			| DialogViewModel::Prompt { id, .. }
			| DialogViewModel::ToolApproval { id, .. } => id,
		}
	}
}

/// What the operator answered. `Cancelled` covers escape, close and timeout
/// alike.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "kebab-case")]
pub enum DialogResult {
	Cancelled,
	Confirmed,
	Selected {
		values: Vec<String>,
	},
	Entered {
		value: String,
	},
	Approved {
		remember: bool,
	},
	Rejected {
		#[serde(default, skip_serializing_if = "Option::is_none")]
		reason: Option<String>,
	},
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayViewModel {
	pub id:          String,
	pub anchor:      OverlayAnchor,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub title:       Option<String>,
	/// Rendered rows, painted as given.
	///
	/// This is the one place the contract hands the renderer prose instead of
	/// structure, so an overlay looks the same in a window as in a terminal and
	/// no more. Structuring it is tracked against the presentation contract, not
	/// worked around here.
	pub rows:        Vec<String>,
	/// True when the overlay takes input; false when it only displays.
	pub interactive: bool,
	/// True when dismissing the overlay is the operator's to decide.
	pub dismissable: bool,
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_dialog_deserializes_from_the_wire_shape() {
		let json = r#"{
			"kind": "tool-approval",
			"id": "d1",
			"toolCallId": "c1",
			"toolName": "bash",
			"input": "rm -rf build",
			"impact": "deletes build/"
		}"#;
		let dialog: DialogViewModel = serde_json::from_str(json).expect("deserializes");
		assert_eq!(dialog.id(), "d1");
		let DialogViewModel::ToolApproval { tool_name, impact, .. } = &dialog else {
			panic!("wrong variant: {dialog:?}");
		};
		assert_eq!(tool_name, "bash");
		assert_eq!(impact.as_deref(), Some("deletes build/"));
	}

	/// A unit-shaped result carries only its tag. A renderer answering
	/// `cancelled` must not emit a payload the TypeScript side rejects.
	#[test]
	fn a_unit_result_serializes_as_its_tag_alone() {
		assert_eq!(
			serde_json::to_string(&DialogResult::Cancelled).unwrap(),
			r#"{"outcome":"cancelled"}"#
		);
		assert_eq!(
			serde_json::to_string(&DialogResult::Confirmed).unwrap(),
			r#"{"outcome":"confirmed"}"#
		);
	}

	/// Every result round-trips, including the optional rejection reason in both
	/// its present and absent form.
	#[test]
	fn every_dialog_result_round_trips() {
		let results = [
			DialogResult::Cancelled,
			DialogResult::Confirmed,
			DialogResult::Selected { values: vec!["a".into(), "b".into()] },
			DialogResult::Entered { value: "typed".into() },
			DialogResult::Approved { remember: true },
			DialogResult::Rejected { reason: None },
			DialogResult::Rejected { reason: Some("not this time".into()) },
		];
		for result in results {
			let json = serde_json::to_string(&result).expect("serializes");
			let back: DialogResult =
				serde_json::from_str(&json).unwrap_or_else(|e| panic!("{json}: {e}"));
			assert_eq!(back, result, "{json}");
		}
		assert_eq!(
			serde_json::to_string(&DialogResult::Rejected { reason: None }).unwrap(),
			r#"{"outcome":"rejected"}"#
		);
	}

	/// An absent `disabled` means selectable. Reading the optional as `false`
	/// would make every row of every list unpickable.
	#[test]
	fn an_absent_disabled_flag_means_selectable() {
		let option: SelectOption =
			serde_json::from_str(r#"{ "value": "a", "label": "A" }"#).expect("deserializes");
		assert!(option.selectable());

		let off: SelectOption =
			serde_json::from_str(r#"{ "value": "b", "label": "B", "disabled": true }"#)
				.expect("deserializes");
		assert!(!off.selectable());
	}

	#[test]
	fn an_overlay_deserializes_from_the_wire_shape() {
		let json = r#"{
			"id": "o1",
			"anchor": "fullscreen",
			"title": "Themes",
			"rows": ["dark", "light"],
			"interactive": true,
			"dismissable": true
		}"#;
		let overlay: OverlayViewModel = serde_json::from_str(json).expect("deserializes");
		assert_eq!(overlay.anchor, OverlayAnchor::Fullscreen);
		assert_eq!(overlay.rows, vec!["dark", "light"]);
		assert_eq!(overlay.title.as_deref(), Some("Themes"));
	}
}
