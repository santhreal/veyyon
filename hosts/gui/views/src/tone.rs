//! Where a tone becomes an appearance.
//!
//! One place per crate. A tone matched at each call site drifts: the same
//! `Tone::Warn` gets the warning role in one kind and the accent role in
//! another, and nothing about either looks wrong on its own.

use veyyon_gui_contract::view::Tone;
use veyyon_gui_kit::Level;
use veyyon_gui_theme::Role;

/// The text role a tone reads in.
///
/// [`None`] is the reading colour. That is the whole reason the contract
/// carries `Option<Tone>` rather than a neutral member: a value with no verdict
/// is not a fifth verdict.
pub fn role(tone: Option<Tone>) -> Role {
	match tone {
		None => Role::TextPrimary,
		Some(Tone::Accent) => Role::TextAccent,
		Some(Tone::Ok) => Role::StateSuccess,
		Some(Tone::Warn) => Role::StateWarning,
		Some(Tone::Err) => Role::StateError,
	}
}

/// The role a tone's ground is tinted from.
///
/// A tinted ground is that role's own colour at low alpha, through
/// `veyyon_gui_kit::chrome::wash`, so a tone needs no second colour to be
/// filled. A tone with no verdict has no tint, which is why this returns
/// [`Option`] rather than a role that happens to be invisible.
pub fn ground(tone: Option<Tone>) -> Option<Role> {
	tone.map(|tone| role(Some(tone)))
}

/// The marker that precedes a toned line, so the verdict survives a monochrome
/// terminal, a screenshot in grayscale, and a reader who cannot distinguish the
/// two state colours.
pub fn marker(tone: Option<Tone>) -> &'static str {
	match tone {
		None => "·",
		Some(Tone::Accent) => "▸",
		Some(Tone::Ok) => "✓",
		Some(Tone::Warn) => "!",
		Some(Tone::Err) => "✗",
	}
}

/// The level a block carrying `tone` is drawn on.
///
/// Only a failure gets a ground of its own. A warning on its own ground reads
/// as a second kind of error, and every block having one turns a transcript
/// into a stack of boxes with no hierarchy left.
pub fn level(tone: Option<Tone>) -> Level {
	match tone {
		Some(Tone::Err) => Level::Sunken,
		_ => Level::Raised,
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! Two tones that resolve to one appearance is the defect this module
	//! exists to prevent, and it is invisible in review: a failure that reads as
	//! a warning still looks deliberate. The compiler covers a missing arm and
	//! covers nothing about two arms agreeing.
	//!
	//! It also pins the deliberate collapses by exact equality, so a future
	//! reader cannot mistake one for an oversight, and adding a `Tone` member
	//! turns every sweep here red rather than inheriting a wildcard.
	//!
	//! WHAT IT DOES NOT CATCH. Whether the two state colours are far enough
	//! apart in a given theme. `veyyon-gui-kit` asserts palette separation.

	use super::*;

	/// Every tone, plus the absence of one. The array is what each sweep walks,
	/// so a new member is a compile error here before it is a silent collapse.
	const ALL: [Option<Tone>; 5] =
		[None, Some(Tone::Accent), Some(Tone::Ok), Some(Tone::Warn), Some(Tone::Err)];

	#[test]
	fn no_two_tones_read_in_the_same_role() {
		let mut roles: Vec<Role> = ALL.into_iter().map(role).collect();
		let count = roles.len();
		roles.sort_by_key(|role| format!("{role:?}"));
		roles.dedup();
		assert_eq!(roles.len(), count, "two tones share a text role");
	}

	#[test]
	fn no_two_tones_share_a_marker() {
		let mut markers: Vec<&str> = ALL.into_iter().map(marker).collect();
		let count = markers.len();
		markers.sort_unstable();
		markers.dedup();
		assert_eq!(markers.len(), count, "two tones share a marker");
	}

	#[test]
	fn a_failure_never_reads_as_a_success() {
		assert_eq!(role(Some(Tone::Ok)), Role::StateSuccess);
		assert_eq!(role(Some(Tone::Err)), Role::StateError);
		assert_ne!(role(Some(Tone::Warn)), role(Some(Tone::Err)));
	}

	#[test]
	fn only_a_failure_gets_a_ground_of_its_own() {
		assert_eq!(level(Some(Tone::Err)), Level::Sunken);
		for tone in [None, Some(Tone::Accent), Some(Tone::Ok), Some(Tone::Warn)] {
			assert_eq!(level(tone), Level::Raised, "{tone:?} took a ground of its own");
		}
	}

	#[test]
	fn a_value_with_no_verdict_has_no_tint() {
		assert_eq!(ground(None), None);
		for tone in [Tone::Accent, Tone::Ok, Tone::Warn, Tone::Err] {
			assert_eq!(ground(Some(tone)), Some(role(Some(tone))));
		}
	}
}
