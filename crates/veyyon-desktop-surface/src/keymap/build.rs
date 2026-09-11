//! An action name from the keymap table, or from a menu entry, becomes a
//! gpui action here (§5.14).
//!
//! The one place that mapping exists, so a keystroke and a menu item
//! dispatch the same thing rather than two implementations of one verb.

use std::sync::Arc;

use veyyon_gpui::Action;

use crate::keymap::{
	KeymapError,
	actions::{
		AbortTurn, AttachFile, CloseTabOrPark, CloseWindow, CopySelection, Dismiss, FilterQueue,
		FindInTranscript, FocusLive, ModelPicker, MoveSelection, NewSession, Newline, NextSession,
		NextTab, NextTurn, OpenMenu, OpenPalette, OpenSelectedSession, OpenSettings, PreviousSession,
		PreviousTab, PreviousTurn, Primary, Quit, Scroll, ScrollBy, SelectEntryText, SelectOption,
		SplitHalf, TakeBackQueuedPrompt, ThinkingLevel, ToggleBlock, ToggleDeferSelected,
		ToggleDiffMode, ToggleDrawer, TogglePanel, ToggleParkSelected, TogglePinSelected,
		ToggleQueue, ToggleQueueMode,
	},
};

/// Instantiates the GPUI `Action` trait object for a named action and optional
/// argument.
///
/// The one place an action name becomes an action, so a keystroke from the
/// table and a menu entry the pointer pressed dispatch the same thing. A verb
/// that reads an argument off its chord cannot be built without one, which is
/// why the menu table holds no such verb.
pub fn build_action(
	action_name: &str,
	arg: Option<&serde_json::Value>,
) -> Result<Arc<dyn Action>, KeymapError> {
	match action_name {
		"OpenPalette" => Ok(Arc::new(OpenPalette)),
		"NewSession" => Ok(Arc::new(NewSession)),
		"OpenSettings" => Ok(Arc::new(OpenSettings)),
		"ToggleQueue" => Ok(Arc::new(ToggleQueue)),
		"ToggleDrawer" => Ok(Arc::new(ToggleDrawer)),
		"TogglePanel" => Ok(Arc::new(TogglePanel)),
		"FocusLive" => {
			let index = arg
				.and_then(|v| v.get("index"))
				.and_then(serde_json::Value::as_u64)
				.map(|idx| idx as u8)
				.ok_or_else(|| KeymapError::InvalidArgument {
					action:  action_name.to_string(),
					message: "expected { index: u8 }".to_string(),
				})?;
			Ok(Arc::new(FocusLive { index }))
		},
		"PreviousSession" => Ok(Arc::new(PreviousSession)),
		"NextSession" => Ok(Arc::new(NextSession)),
		"CloseTabOrPark" => Ok(Arc::new(CloseTabOrPark)),
		"MoveSelection" | "MoveQueueSelection" => {
			let delta = arg
				.and_then(|v| v.get("delta"))
				.and_then(serde_json::Value::as_i64)
				.map(|d| d as i32)
				.ok_or_else(|| KeymapError::InvalidArgument {
					action:  action_name.to_string(),
					message: "expected { delta: i32 }".to_string(),
				})?;
			Ok(Arc::new(MoveSelection { delta }))
		},
		"OpenSelectedSession" | "OpenSession" => Ok(Arc::new(OpenSelectedSession)),
		"TogglePinSelected" | "PinSession" => Ok(Arc::new(TogglePinSelected)),
		"ToggleDeferSelected" | "DeferSession" => Ok(Arc::new(ToggleDeferSelected)),
		"ToggleParkSelected" | "ParkSession" => Ok(Arc::new(ToggleParkSelected)),
		"FilterQueue" | "FocusFilter" => Ok(Arc::new(FilterQueue)),
		"Scroll" | "ScrollTranscript" => {
			let by = if let Some(arg) = arg {
				if let Some(by_str) = arg.get("by").and_then(serde_json::Value::as_str) {
					match by_str {
						"page-up" | "PageUp" => ScrollBy::PageUp,
						"page-down" | "PageDown" => ScrollBy::PageDown,
						"top" | "Top" => ScrollBy::Top,
						"bottom" | "Bottom" => ScrollBy::Bottom,
						other => {
							return Err(KeymapError::InvalidArgument {
								action:  action_name.to_string(),
								message: format!("unknown scroll target '{other}'"),
							});
						},
					}
				} else {
					ScrollBy::PageDown
				}
			} else {
				ScrollBy::PageDown
			};
			Ok(Arc::new(Scroll { by }))
		},
		"FindInTranscript" => Ok(Arc::new(FindInTranscript)),
		"PreviousTurn" => Ok(Arc::new(PreviousTurn)),
		"NextTurn" => Ok(Arc::new(NextTurn)),
		"ToggleBlock" => Ok(Arc::new(ToggleBlock)),
		"CopySelection" => Ok(Arc::new(CopySelection)),
		"SelectEntryText" => Ok(Arc::new(SelectEntryText)),
		"Primary" => Ok(Arc::new(Primary)),
		"Newline" => Ok(Arc::new(Newline)),
		"SplitHalf" => Ok(Arc::new(SplitHalf)),
		"Dismiss" => Ok(Arc::new(Dismiss)),
		"AbortTurn" => Ok(Arc::new(AbortTurn)),
		"ToggleQueueMode" => Ok(Arc::new(ToggleQueueMode)),
		"SelectOption" => {
			let index = arg
				.and_then(|v| v.get("index"))
				.and_then(serde_json::Value::as_u64)
				.map(|idx| idx as u8)
				.ok_or_else(|| KeymapError::InvalidArgument {
					action:  action_name.to_string(),
					message: "expected { index: u8 }".to_string(),
				})?;
			Ok(Arc::new(SelectOption { index }))
		},
		"ModelPicker" => Ok(Arc::new(ModelPicker)),
		"ThinkingLevel" => Ok(Arc::new(ThinkingLevel)),
		"AttachFile" => Ok(Arc::new(AttachFile)),
		"TakeBackQueuedPrompt" => Ok(Arc::new(TakeBackQueuedPrompt)),
		"PreviousTab" => Ok(Arc::new(PreviousTab)),
		"NextTab" => Ok(Arc::new(NextTab)),
		"ToggleDiffMode" => Ok(Arc::new(ToggleDiffMode)),
		"CloseWindow" => Ok(Arc::new(CloseWindow)),
		"Quit" => Ok(Arc::new(Quit)),
		"OpenMenu" => Ok(Arc::new(OpenMenu)),
		unknown => {
			Err(KeymapError::UnknownAction { scope: String::new(), action: unknown.to_string() })
		},
	}
}
