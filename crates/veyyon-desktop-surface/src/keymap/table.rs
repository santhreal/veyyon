//! Keymap table parsing, chord resolution and GPUI keybinding derivation
//! (§5.14).
//!
//! Loads `keymap.toml` into a structured table, validates chords against GPUI's
//! keystroke grammar, rejects duplicate chords within the same scope, and
//! produces GPUI `KeyBinding` records with context predicates matching the
//! region tree.

use std::{collections::HashSet, sync::Arc};

use serde::Deserialize;
use thiserror::Error;
use veyyon_gpui::{
	Action, DummyKeyboardMapper, InvalidKeystrokeError, KeyBinding, KeyBindingContextPredicate,
	Keystroke,
};

use crate::keymap::actions::{
	AbortTurn, AttachFile, CloseTabOrPark, Command, Dismiss, FilterQueue, FindInTranscript,
	FocusLive, ModelPicker, MoveSelection, NewSession, Newline, NextSession, NextTab, NextTurn,
	OpenPalette, OpenSelectedSession, OpenSettings, PreviousSession, PreviousTab, PreviousTurn,
	Primary, Scope, Scroll, ScrollBy, SelectOption, SplitHalf, ThinkingLevel, ToggleBlock,
	ToggleDeferSelected, ToggleDiffMode, ToggleDrawer, TogglePanel, ToggleParkSelected,
	TogglePinSelected, ToggleQueue, ToggleQueueMode,
};

/// Default embedded keymap configuration table.
pub const DEFAULT_KEYMAP_TOML: &str = include_str!("../../keymap.toml");

/// Typed errors emitted when loading or validating keybindings.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum KeymapError {
	/// The TOML document was malformed or failed syntax validation.
	#[error("failed to parse TOML keymap: {message}")]
	ParseToml { message: String },
	/// The declared scope is not one of the five valid regions.
	#[error("unknown scope '{scope}' for chord '{chord}'")]
	UnknownScope { scope: String, chord: String },
	/// The action name does not correspond to any known command.
	#[error("unknown action '{action}' in scope '{scope}'")]
	UnknownAction { scope: String, action: String },
	/// The chord failed GPUI's keystroke parser grammar.
	#[error("invalid chord '{chord}': {message}")]
	InvalidChord { chord: String, message: String },
	/// A chord was declared more than once in the same region scope.
	#[error("duplicate chord '{chord}' in scope '{scope}'")]
	DuplicateChord { scope: String, chord: String },
	/// Parameterized action argument structure was invalid.
	#[error("invalid argument for action '{action}': {message}")]
	InvalidArgument { action: String, message: String },
}

#[derive(Debug, Deserialize)]
struct RawKeymapFile {
	#[serde(default)]
	binding: Vec<RawBinding>,
}

#[derive(Debug, Deserialize)]
struct RawBinding {
	scope:  String,
	chord:  String,
	action: String,
	arg:    Option<serde_json::Value>,
}

/// A resolved row for presentation in settings and command palettes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeymapRow {
	/// Region scope where the binding is active.
	pub scope:      Scope,
	/// Keyboard chord in canonical string representation.
	pub chord:      String,
	/// The target command.
	pub command:    Command,
	/// Human-readable description of the command.
	pub label:      String,
	/// Whether this binding was supplied by an operator override.
	pub overridden: bool,
	/// Name of the default action or chord shadowed by this override, if any.
	pub shadows:    Option<String>,
}

/// An internal representation of a validated binding.
#[derive(Clone)]
pub(crate) struct ResolvedBinding {
	pub scope:          Scope,
	pub raw_chord:      String,
	pub resolved_chord: String,
	pub action_name:    String,
	pub command:        Command,
	pub action:         Arc<dyn Action>,
	pub shadows:        Option<String>,
}

/// Resolved keyboard configuration table and active overrides (§5.14).
#[derive(Clone)]
pub struct Keymap {
	pub(crate) defaults:  Vec<ResolvedBinding>,
	pub(crate) overrides: Vec<ResolvedBinding>,
}

impl std::fmt::Debug for Keymap {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Keymap")
			.field("defaults_count", &self.defaults.len())
			.field("overrides_count", &self.overrides.len())
			.finish()
	}
}

impl Default for Keymap {
	fn default() -> Self {
		Self::load_default().expect("shipped keymap.toml must be valid")
	}
}

/// Resolves platform-specific modifiers like `primary` to `cmd` (macOS) or
/// `ctrl` (other).
#[must_use]
pub fn resolve_chord(chord: &str) -> String {
	let platform_mod = if cfg!(target_os = "macos") {
		"cmd"
	} else {
		"ctrl"
	};
	chord
		.split('-')
		.map(|part| {
			if part.eq_ignore_ascii_case("primary") {
				platform_mod
			} else {
				part
			}
		})
		.collect::<Vec<_>>()
		.join("-")
}

/// Instantiates the GPUI `Action` trait object for a named action and optional
/// argument.
pub(crate) fn build_action(
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
		"PreviousTab" => Ok(Arc::new(PreviousTab)),
		"NextTab" => Ok(Arc::new(NextTab)),
		"ToggleDiffMode" => Ok(Arc::new(ToggleDiffMode)),
		unknown => {
			Err(KeymapError::UnknownAction { scope: String::new(), action: unknown.to_string() })
		},
	}
}

impl Keymap {
	/// Loads and validates a keymap table from a TOML string.
	pub fn load(toml_str: &str) -> Result<Self, KeymapError> {
		let raw: RawKeymapFile = toml::from_str(toml_str)
			.map_err(|err| KeymapError::ParseToml { message: err.to_string() })?;

		let mut bindings = Vec::with_capacity(raw.binding.len());
		let mut seen = HashSet::new();

		for b in raw.binding {
			let scope = Scope::from_name(&b.scope).ok_or_else(|| KeymapError::UnknownScope {
				scope: b.scope.clone(),
				chord: b.chord.clone(),
			})?;

			let resolved_chord = resolve_chord(&b.chord);
			Keystroke::parse(&resolved_chord).map_err(|err: InvalidKeystrokeError| {
				KeymapError::InvalidChord { chord: b.chord.clone(), message: err.to_string() }
			})?;

			if !seen.insert((scope, resolved_chord.clone())) {
				return Err(KeymapError::DuplicateChord {
					scope: scope.as_str().to_string(),
					chord: b.chord,
				});
			}

			let command = Command::from_name(&b.action).ok_or_else(|| KeymapError::UnknownAction {
				scope:  scope.as_str().to_string(),
				action: b.action.clone(),
			})?;

			let action = build_action(&b.action, b.arg.as_ref())?;

			bindings.push(ResolvedBinding {
				scope,
				raw_chord: b.chord,
				resolved_chord,
				action_name: b.action,
				command,
				action,
				shadows: None,
			});
		}

		Ok(Self { defaults: bindings, overrides: Vec::new() })
	}

	/// Loads the default embedded keymap configuration.
	pub fn load_default() -> Result<Self, KeymapError> {
		Self::load(DEFAULT_KEYMAP_TOML)
	}

	/// Returns all active keymap rows reflecting defaults and overrides.
	#[must_use]
	pub fn rows(&self) -> Vec<KeymapRow> {
		let mut result = Vec::new();
		let overridden_default_chords: HashSet<(Scope, &str)> = self
			.overrides
			.iter()
			.map(|o| (o.scope, o.resolved_chord.as_str()))
			.collect();

		for b in &self.defaults {
			let is_overridden = overridden_default_chords.contains(&(b.scope, &b.resolved_chord));
			if !is_overridden {
				result.push(KeymapRow {
					scope:      b.scope,
					chord:      b.raw_chord.clone(),
					command:    b.command,
					label:      b.command.label().to_string(),
					overridden: false,
					shadows:    None,
				});
			}
		}

		for o in &self.overrides {
			result.push(KeymapRow {
				scope:      o.scope,
				chord:      o.raw_chord.clone(),
				command:    o.command,
				label:      o.command.label().to_string(),
				overridden: true,
				shadows:    o.shadows.clone(),
			});
		}

		result
	}

	/// Derives GPUI keybindings for all active bindings.
	#[must_use]
	pub fn bindings(&self) -> Vec<KeyBinding> {
		let mut result = Vec::new();
		let overridden_default_chords: HashSet<(Scope, &str)> = self
			.overrides
			.iter()
			.map(|o| (o.scope, o.resolved_chord.as_str()))
			.collect();

		for b in &self.defaults {
			if !overridden_default_chords.contains(&(b.scope, &b.resolved_chord)) {
				let context_predicate = match b.scope {
					Scope::Global => None,
					Scope::Queue | Scope::Transcript | Scope::Composer | Scope::Panel => {
						KeyBindingContextPredicate::parse(b.scope.context_name())
							.ok()
							.map(std::rc::Rc::new)
					},
				};
				if let Ok(binding) = KeyBinding::load(
					&b.resolved_chord,
					b.action.boxed_clone(),
					context_predicate,
					false,
					None,
					&DummyKeyboardMapper,
				) {
					result.push(binding);
				}
			}
		}

		for o in &self.overrides {
			let context_predicate = match o.scope {
				Scope::Global => None,
				Scope::Queue | Scope::Transcript | Scope::Composer | Scope::Panel => {
					KeyBindingContextPredicate::parse(o.scope.context_name())
						.ok()
						.map(std::rc::Rc::new)
				},
			};
			if let Ok(binding) = KeyBinding::load(
				&o.resolved_chord,
				o.action.boxed_clone(),
				context_predicate,
				false,
				None,
				&DummyKeyboardMapper,
			) {
				result.push(binding);
			}
		}

		result
	}
}
