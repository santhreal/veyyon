//! `veyyon_diff_kernel`: what counts as a line, what a line's comparison key is, and whether two
//! texts differ.
//!
//! WHY THIS IS WORTH FUZZING. This crate is the one place two texts become patch text, for the
//! `diff` shell builtin and for isolation's plain-mode change capture, and both of them hand it
//! bytes they did not write. Three of its properties are load-bearing rather than cosmetic.
//!
//! The first is that splitting a text into lines LOSES NOTHING: the formatter prints a line by
//! writing its body and then restoring the terminator the split removed, so if a split could drop
//! or duplicate a byte, the patch would not describe the file. The split is hand-written, over
//! arbitrary UTF-8, using byte indices into a `str`, which is exactly the shape where an off-by-one
//! is a panic rather than a wrong answer.
//!
//! The second is that a run with NO ignore flag differs exactly when the bytes differ. The `diff`
//! builtin relies on that in the other direction as a fast path: it answers "identical" from a
//! streamed byte comparison without ever loading the files, and only reaches this crate when the
//! bytes already disagreed. If the two verdicts could diverge, `diff -s` would call two files
//! identical while `diff -u` printed a hunk for them.
//!
//! The third is that the ignore flags can only ever HIDE a difference, never invent one, and that
//! `-w` subsumes the narrower whitespace flags. Those are the composition rules the transform was
//! written to, measured one pair at a time against GNU diffutils 3.10, and they are stated here as
//! properties over every input rather than as the handful of lines a unit test can name.
//!
//! WHAT IS CHECKED, in order of strength.
//!
//! 1. Nothing panics, on arbitrary text and any of the sixty-four flag combinations.
//! 2. `split_lines` is reversible: the pieces concatenate back to the input byte for byte. Only the
//!    final piece may lack a terminator, and no piece is empty.
//! 3. With no flag set, `differs()` is exactly `old != new`. With any flag set, only the safe
//!    direction is required: equal input cannot differ, since a key is a function of its line.
//! 4. `differs()` agrees with whether anything was printed. A run that reports a difference and
//!    prints nothing, or the reverse, is the failure that makes an exit code a lie.
//! 5. The key transform is IDEMPOTENT: keying a key changes nothing. Every flag either deletes
//!    characters or rewrites them into a form it would leave alone, so a second pass that moved
//!    would mean the first had not finished.
//! 6. Each flag's own promise holds on its output: `-w` leaves no whitespace at all, `-Z` and `-b`
//!    leave none at the end, `-b` leaves no run of two, `-i` leaves nothing that lowercases to
//!    something else, and `-E` leaves no tab.
//! 7. `-w` subsumes `-b`, `-Z` and `-E`: piling the narrower flags on top of it cannot change a key.
//!    If it could, the order the transform applies them in would be observable.

#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use veyyon_diff_kernel::{Ignore, Unified, split_lines};

/// Arbitrary text plus an arbitrary flag set, so the fuzzer explores the composition rules and not
/// only one configuration.
#[derive(Arbitrary, Debug)]
struct Input {
	old:            String,
	new:            String,
	case:           bool,
	all_space:      bool,
	space_change:   bool,
	trailing_space: bool,
	tab_expansion:  bool,
	blank_lines:    bool,
	/// Clamped, because a radius wider than the input only re-tests the same hunk.
	context:        u8,
}

/// The whitespace set GNU diff folds, which is C-locale `isspace` and not Unicode.
fn is_space(ch: char) -> bool {
	matches!(ch, ' ' | '\t' | '\n' | '\u{b}' | '\u{c}' | '\r')
}

/// Property 2, on one text.
fn check_split(text: &str) {
	let lines = split_lines(text);
	assert_eq!(lines.concat(), text, "splitting {text:?} lost or duplicated bytes");
	for (index, line) in lines.iter().enumerate() {
		assert!(!line.is_empty(), "line {index} of {text:?} is empty");
		let is_last = index + 1 == lines.len();
		assert!(
			line.ends_with('\n') || is_last,
			"line {index} of {text:?} has no terminator and is not the last"
		);
		// `strip_suffix` rather than `line[..line.len() - 1]`: the last BYTE of a line
		// is not the last CHARACTER, so slicing one byte off the end panics on any
		// line ending in a multi-byte character. The fuzzer found that on its first
		// run, in this file rather than in the code under test.
		assert!(
			!line.strip_suffix('\n').unwrap_or(line).contains('\n'),
			"line {index} of {text:?} holds a terminator in its body"
		);
	}
}

/// Properties 5, 6 and 7, on one line.
fn check_key(ig: Ignore, line: &str) {
	let key = ig.key(line);

	assert_eq!(ig.key(&key), key, "keying the key of {line:?} moved under {ig:?}");

	if ig.all_space {
		assert!(!key.contains(is_space), "-w left whitespace in {key:?}");
	} else {
		if ig.space_change || ig.trailing_space {
			assert!(
				!key.ends_with(is_space),
				"trailing whitespace survived in {key:?} under {ig:?}"
			);
		}
		if ig.space_change {
			let mut previous_was_space = false;
			for ch in key.chars() {
				let space = is_space(ch);
				assert!(!(space && previous_was_space), "-b left a run of two in {key:?}");
				previous_was_space = space;
			}
		}
		if ig.tab_expansion {
			assert!(!key.contains('\t'), "-E left a tab in {key:?}");
		}
	}
	if ig.case {
		assert_eq!(key.to_lowercase(), *key, "-i left case in {key:?}");
	}

	// Property 7: the wide flag decides on its own.
	if ig.all_space {
		let wide = Ignore { all_space: true, case: ig.case, ..Ignore::default() };
		assert_eq!(wide.key(line), key, "the narrower whitespace flags changed a -w key");
	}
}

fuzz_target!(|input: Input| {
	let Input { old, new, context, .. } = &input;
	let ig = Ignore {
		case:           input.case,
		all_space:      input.all_space,
		space_change:   input.space_change,
		trailing_space: input.trailing_space,
		tab_expansion:  input.tab_expansion,
		blank_lines:    input.blank_lines,
	};

	check_split(old);
	check_split(new);
	for line in split_lines(old).iter().chain(split_lines(new).iter()) {
		check_key(ig, line);
	}

	let radius = usize::from(*context % 8);
	let diff = Unified::compute(old, new, radius, ig);

	let mut printed = Vec::new();
	diff
		.write(&mut printed, "a", "b")
		.expect("writing into a Vec cannot fail");

	// Property 4.
	assert_eq!(
		diff.differs(),
		!printed.is_empty(),
		"differs() said {} and {} bytes were printed",
		diff.differs(),
		printed.len()
	);

	// Property 3.
	if ig.any() {
		if old == new {
			assert!(!diff.differs(), "a flag turned equal input into a difference");
		}
	} else {
		assert_eq!(
			diff.differs(),
			old != new,
			"with no flag set the verdict must be byte equality"
		);
	}

	// A hunk exists only where the two sides disagree, so an empty pair never has one, whatever the
	// flags say.
	if old.is_empty() && new.is_empty() {
		assert!(!diff.differs(), "two empty texts differ");
	}
});
