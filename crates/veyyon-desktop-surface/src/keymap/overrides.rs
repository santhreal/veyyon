//! Operator keybinding override ingestion and shadowing validation (§5.14).
//!
//! Applies operator-supplied keybinding overrides against the default table,
//! tracks shadowed default bindings, detects duplicate chords within a scope,
//! and reports bindings that shadow no default action or chord.

use std::collections::HashSet;

use veyyon_desktop_model::KeybindingView;
use veyyon_gpui::{InvalidKeystrokeError, Keystroke};

use crate::keymap::{
	actions::Command,
	table::{Keymap, ResolvedBinding, build_action, resolve_chord},
};

/// The outcome of applying an individual keybinding override (§5.14).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverrideReport {
	/// Override successfully applied, shadowing a default binding.
	Applied { chord: String, action: String, shadows: Option<String> },
	/// Override was accepted but does not replace any default action or chord.
	ShadowsNothing { chord: String, action: String },
	/// Override chord was specified more than once in the same region scope.
	Duplicate { chord: String, action: String },
	/// Override chord failed keystroke grammar parsing.
	InvalidChord { chord: String, message: String },
	/// Override action name does not match any known command.
	UnknownAction { action: String },
}

impl Keymap {
	/// Applies a slice of domain keybinding views onto this table.
	///
	/// Returns a report for every processed binding. Overrides that shadow no
	/// default binding are reported as `ShadowsNothing`.
	pub fn apply_overrides(&mut self, views: &[KeybindingView]) -> Vec<OverrideReport> {
		let mut reports = Vec::new();
		let mut seen_in_batch = HashSet::new();

		for view in views {
			let Some(command) = Command::from_name(&view.action) else {
				reports.push(OverrideReport::UnknownAction { action: view.action.clone() });
				continue;
			};

			let scope = command.scope();

			for key in &view.keys {
				let resolved = resolve_chord(key);
				if let Err(err) = Keystroke::parse(&resolved) as Result<_, InvalidKeystrokeError> {
					reports.push(OverrideReport::InvalidChord {
						chord:   key.clone(),
						message: err.to_string(),
					});
					continue;
				}

				if !seen_in_batch.insert((scope, resolved.clone())) {
					reports.push(OverrideReport::Duplicate {
						chord:  key.clone(),
						action: view.action.clone(),
					});
					continue;
				}

				let default_match = self.defaults.iter().find(|b| {
					b.scope == scope && (b.resolved_chord == resolved || b.action_name == view.action)
				});

				let shadows = default_match.map(|b| {
					if b.resolved_chord == resolved {
						b.action_name.clone()
					} else {
						b.raw_chord.clone()
					}
				});

				let Ok(action) = build_action(&view.action, None) else {
					reports.push(OverrideReport::UnknownAction { action: view.action.clone() });
					continue;
				};

				let is_shadow = shadows.is_some();

				self.overrides.retain(|o| {
					!(o.scope == scope && (o.resolved_chord == resolved || o.action_name == view.action))
				});

				self.overrides.push(ResolvedBinding {
					scope,
					raw_chord: key.clone(),
					resolved_chord: resolved,
					action_name: view.action.clone(),
					command,
					action,
					shadows: shadows.clone(),
				});

				if is_shadow {
					reports.push(OverrideReport::Applied {
						chord: key.clone(),
						action: view.action.clone(),
						shadows,
					});
				} else {
					reports.push(OverrideReport::ShadowsNothing {
						chord:  key.clone(),
						action: view.action.clone(),
					});
				}
			}
		}

		reports
	}
}
