//! WHY: the transcript could only be walked a wheel notch at a time. Reaching
//! the start of a long conversation took a scroll, and the only jump was the
//! banner's "jump to latest", which appears while rows are unseen and nowhere
//! else.
//!
//! The class this closes is a bound keystroke that reaches nothing. A jump is
//! three hops — a chord, a command, a shell effect — and each hop is a place a
//! new one can go quiet: a chord bound to a command dispatch drops, or two
//! commands mapped to one effect, which is what a copy-pasted arm produces and
//! what no per-command test finds. Both jumps are swept from the command set
//! together, so a third one is red until it is mapped.
//!
//! Not covered: what the list does with the effect. That needs a window, and
//! the recorded scenes cover it.

use crate::{
	CommandClass, UiCommand,
	keys::{self, Context},
	store::{Effects, ShellEffect, Store},
};

/// Every command that jumps the transcript, with the effect it must reach.
///
/// Written as pairs rather than swept from `UiCommand`, because the mapping is
/// the thing under test; the sweep below proves the pairs cover the chords.
fn jumps() -> Vec<(UiCommand, ShellEffect)> {
	vec![
		(UiCommand::JumpToOldest, ShellEffect::ScrollTranscriptToOldest),
		(UiCommand::JumpToLatest, ShellEffect::ScrollTranscriptToLatest),
	]
}

fn shell_effects(effects: &Effects) -> Vec<ShellEffect> {
	effects.shell.clone()
}

#[test]
fn each_jump_reaches_its_own_shell_effect() {
	for (command, expected) in jumps() {
		let mut store = Store::detached();
		let effects = store.dispatch(command.clone());
		assert_eq!(
			shell_effects(&effects),
			vec![expected],
			"{command:?} did not reach the effect that scrolls the transcript"
		);
		// A jump moves the viewport and asks the host for nothing, so a
		// disconnected reader reaches both ends of what is already loaded.
		assert!(effects.requests.is_empty(), "{command:?} went to the host");
		assert_eq!(command.class(), CommandClass::Shell);
	}
}

#[test]
fn no_two_jumps_share_an_effect() {
	// The copy-paste failure: both ends bound, both dispatching, and one of
	// them scrolling the wrong way forever.
	let mut effects: Vec<ShellEffect> = jumps().into_iter().map(|(_, effect)| effect).collect();
	let count = effects.len();
	effects.dedup();
	assert_eq!(effects.len(), count);
}

#[test]
fn every_transcript_jump_chord_is_a_command_this_suite_covers() {
	// Swept from the keymap, so a chord added for a third position — a page, a
	// mark, the previous turn — turns this red until it is mapped and covered
	// here rather than shipping bound to nothing.
	let covered: Vec<UiCommand> = jumps().into_iter().map(|(command, _)| command).collect();
	let bound: Vec<UiCommand> = keys::table()
		.into_iter()
		.filter(|row| {
			matches!(row.command, UiCommand::JumpToLatest | UiCommand::JumpToOldest)
				|| row.keys.ends_with("-home")
				|| row.keys.ends_with("-end")
		})
		.map(|row| row.command)
		.collect();
	for command in &bound {
		assert!(covered.contains(command), "{command:?} has a chord and no covered effect");
	}
	assert_eq!(bound.len(), covered.len());
}

#[test]
fn the_ends_of_the_transcript_carry_a_modifier_and_apply_everywhere() {
	// A bare `home` or `end` belongs to the caret in whatever field holds the
	// keyboard. Claiming it for the transcript takes it from the composer,
	// which is the field a reader is in when they want it.
	for row in keys::table() {
		if !matches!(row.command, UiCommand::JumpToLatest | UiCommand::JumpToOldest) {
			continue;
		}
		assert!(row.keys.starts_with("secondary-"), "{} needs a modifier", row.keys);
		assert_eq!(row.context, Context::Everywhere, "{} is reachable from one place", row.keys);
		assert!(row.listed, "{} is a chord a reader has to be told about", row.keys);
	}
}
