//! Shared machinery for the fuzz targets in `fuzz_targets/`.
//!
//! Two things live here, and nothing else should: the property checkers that
//! more than one target asserts, and the input generators that steer the fuzzer
//! toward inputs the code under test actually distinguishes between.
//!
//! WHY THE GENERATORS MATTER MORE THAN THE FUZZER. A libFuzzer target handed
//! `&[u8]` and a `String::from_utf8_lossy` will spend its entire run in a
//! region of the input space the code treats identically. The path comparator
//! in `veyyon-walker` breaks on the triple `"a"`, `"a/b"`, `"a!"`, and the only
//! reason a fuzzer reaches that is an alphabet that makes `/` and the bytes
//! either side of it common. Every generator below exists to make some specific
//! distinction cheap to hit, and each one says which.

#![allow(clippy::module_name_repetitions)]

use std::{cmp::Ordering, fmt::Debug};

use arbitrary::{Arbitrary, Result, Unstructured};

/// Bytes that a path comparator is most likely to get wrong, plus ordinary
/// ones.
///
/// The separator-adjacent characters are the whole point. `/` is `0x2F`, so a
/// comparator that special-cases the separator disagrees with byte order for
/// every sibling name whose next character sorts below it (`!"#$%&'()*+,-.`,
/// and space) or above it (`0`-`9`, `:`, `;`). A uniformly random alphabet
/// makes those collisions vanishingly rare; this one makes them the common
/// case.
const PATH_ALPHABET: &[u8] = b"ab/.-_ !#0:~\x20\xc3\xa9"; // ascii, both sides of `/`, a space, and a 2-byte UTF-8 lead

/// Shell and lint output is line-oriented, so the interesting inputs are the
/// ones that stress line boundaries and the punctuation filters key off.
const TEXT_ALPHABET: &[u8] = b"\n\r\t x:0-|/ +[]()\x1b";

/// A path-shaped string drawn from [`PATH_ALPHABET`].
///
/// Newtyped rather than generated inline in each target so the alphabet has one
/// definitional home. A target that wants raw bytes should say so explicitly.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PathLike(pub String);

impl<'a> Arbitrary<'a> for PathLike {
	fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
		Ok(Self(string_from_alphabet(u, PATH_ALPHABET, 12)?))
	}
}

/// Glob metacharacters plus enough ordinary characters to build a plausible
/// pattern.
///
/// The braces and the comma are over-represented on purpose. `build_glob_pattern`
/// counts `{` against `}` and appends the difference, and `classify_fast_path`
/// reads the contents of a brace group to decide whether it can answer without
/// the glob engine, so a generator that rarely produces an unbalanced or nested
/// group never reaches either. `.` and `/` matter for the same reason they do in
/// [`PATH_ALPHABET`]: the extension and basename fast paths are chosen by
/// looking for them.
const GLOB_ALPHABET: &[u8] = b"*?{},.[]/ab!-\\";

/// A glob pattern drawn from [`GLOB_ALPHABET`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobLike(pub String);

impl<'a> Arbitrary<'a> for GlobLike {
	fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
		Ok(Self(string_from_alphabet(u, GLOB_ALPHABET, 16)?))
	}
}

/// Source-code shaped characters: block delimiters, string quotes, comment
/// starters, and enough letters to form identifiers.
///
/// Weighted toward the characters that open and close a syntactic block,
/// because every property worth checking about a block resolver is about where
/// a node starts and ends. Newlines and spaces are frequent for the same reason:
/// the resolver works in lines and columns, and indentation decides the answer
/// outright in Python.
const CODE_ALPHABET: &[u8] = b"{}()[]\n \t;,.\"'#/*abfxy1=:-\\";

/// A source file drawn from [`CODE_ALPHABET`].
///
/// Longer than the other generators because a block resolver needs several
/// lines before it has anything to resolve.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeLike(pub String);

impl<'a> Arbitrary<'a> for CodeLike {
	fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
		Ok(Self(string_from_alphabet(u, CODE_ALPHABET, 200)?))
	}
}

/// A line-oriented blob of program output drawn from [`TEXT_ALPHABET`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputLike(pub String);

impl<'a> Arbitrary<'a> for OutputLike {
	fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
		Ok(Self(string_from_alphabet(u, TEXT_ALPHABET, 160)?))
	}
}

/// Bytes that make an ANSI-aware width scanner take every branch it has.
///
/// The escape byte has to be common or the parser under test never leaves its
/// ASCII fast path, and the bytes that follow it have to be the ones that
/// complete a sequence (`[`, `m`, `;`, digits) or the scanner treats every
/// escape as an unterminated one and the SGR handling is never exercised. The
/// wide and combining characters are there because the width arithmetic is
/// wrong in different ways for a two-cell grapheme, a zero-width joiner, and a
/// variation selector, and none of those appear by chance.
const ANSI_ALPHABET: &[u8] = concat!(
	"\u{1b}[m;0139abc \t\n",  // escapes, the CSI/SGR body, and ordinary text
	"\u{6f22}",              // a two-cell CJK ideograph
	"\u{200d}\u{fe0f}",      // zero-width joiner and variation selector 16
	"\u{3131}",              // a Hangul compatibility jamo, whose width is host-configurable
	"\u{7}\u{9c}",           // BEL and ST, the two string terminators
)
.as_bytes();

/// Terminal-shaped text: escape sequences, wide graphemes, and plain runs.
///
/// Newtyped so the alphabet above has one definitional home, and capped at 120
/// characters because the measurement functions are quadratic in nothing but
/// still get run four ways per input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnsiLike(pub String);

impl<'a> Arbitrary<'a> for AnsiLike {
	fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
		Ok(Self(string_from_alphabet(u, ANSI_ALPHABET, 120)?))
	}
}

/// Bytes that make an argument parser take a different branch.
///
/// The two dashes have to be common or almost every generated argument is a
/// positional operand and the flag table is never reached. `=` is here because
/// a `require_equals` option is a separate code path from the same option
/// spelled with a space, and a lone `-` and a lone `--` mean specific things to
/// every CLI (stdin, and end-of-options). The digits reach the options that
/// parse a number, and the high byte is deliberately not valid UTF-8: an
/// argument on Unix is bytes, not text, and the handling of one that cannot be
/// decoded is a path nobody types by hand.
const ARGV_ALPHABET: &[u8] = b"-=uUqrNc0123abo. /\xff";

/// One command-line argument, as raw bytes rather than a string.
///
/// Bytes rather than `String` on purpose. `run(argv)` takes `Vec<OsString>`, so
/// a target that generated `String`s would be fuzzing a strictly narrower input
/// than the real entry point accepts, and would never reach the error path a
/// non-UTF-8 filename takes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArgLike(pub Vec<u8>);

impl<'a> Arbitrary<'a> for ArgLike {
	fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
		let len = usize::from(u8::arbitrary(u)?) % (MAX_ARG_BYTES + 1);
		let mut bytes = Vec::with_capacity(len);
		for _ in 0..len {
			let index = usize::from(u8::arbitrary(u)?) % ARGV_ALPHABET.len();
			bytes.push(ARGV_ALPHABET[index]);
		}
		Ok(Self(bytes))
	}
}

impl ArgLike {
	/// The argument as the platform string type an entry point actually takes.
	///
	/// Non-UTF-8 bytes survive this on Unix, which is the point. On Windows
	/// there is no byte-oriented `OsString` constructor, so the bytes are
	/// decoded lossily and the non-UTF-8 case is simply not reachable there;
	/// that is a property of the platform rather than something to work around.
	#[must_use]
	pub fn to_os_string(&self) -> std::ffi::OsString {
		#[cfg(unix)]
		{
			use std::os::unix::ffi::OsStringExt;
			std::ffi::OsString::from_vec(self.0.clone())
		}
		#[cfg(not(unix))]
		{
			std::ffi::OsString::from(String::from_utf8_lossy(&self.0).into_owned())
		}
	}
}

/// Cap on one generated argument's length.
///
/// Short on purpose: argument parsing branches on the first few bytes of an
/// argument, so a long one costs entropy without reaching anything new.
pub const MAX_ARG_BYTES: usize = 16;

/// Cap on how many arguments one input may contain.
///
/// A parser is linear in the argument count, so this is not about complexity.
/// It is about keeping the generated argv in the range a command is actually
/// invoked with, where the interaction between a flag and the operands after it
/// is what a parser gets wrong.
pub const MAX_ARGV_LEN: usize = 12;

/// Build a string of at most `max_len` characters by indexing into `alphabet`.
///
/// Draws one byte of entropy per character and uses it modulo the alphabet
/// length, which keeps the mapping from input bytes to output string simple
/// enough that libFuzzer's mutations stay meaningful: flipping one input byte
/// changes one character rather than resynchronizing the whole string. That is
/// also what lets the shrinker produce a minimal reproducer instead of a
/// slightly shorter random blob.
///
/// The alphabet is bytes rather than chars so it can carry UTF-8 continuation
/// bytes, and the result is assembled with `from_utf8_lossy` so a truncated
/// multi-byte sequence becomes a replacement character rather than an error. A
/// generator that can fail on its own output would starve the target.
fn string_from_alphabet(
	u: &mut Unstructured<'_>,
	alphabet: &[u8],
	max_len: usize,
) -> Result<String> {
	let len = usize::from(u8::arbitrary(u)?) % (max_len + 1);
	let mut bytes = Vec::with_capacity(len);
	for _ in 0..len {
		let index = usize::from(u8::arbitrary(u)?) % alphabet.len();
		bytes.push(alphabet[index]);
	}
	Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// The comparator axiom that a total order violates most quietly.
///
/// WHY THIS IS WORTH ITS OWN CHECK. Rust's `sort_unstable_by` documents that an
/// inconsistent comparator may panic, return a garbage order, or (before the
/// 1.81 driftsort/ipnsort rewrite) read out of bounds. None of those is
/// reliable: a broken comparator usually sorts a small slice fine and only
/// misbehaves once the input is long enough to take a different merge path. So
/// asserting the axioms directly on triples finds the bug at length three
/// instead of waiting for a sort to happen to trip on it.
///
/// Returns the offending triple rather than panicking, so the caller can print
/// it. A fuzz target's failure message is the whole artifact.
pub fn find_transitivity_violation<T, F>(items: &[T], compare: F) -> Option<(usize, usize, usize)>
where
	T: Debug,
	F: Fn(&T, &T) -> Ordering,
{
	for (i, a) in items.iter().enumerate() {
		for (j, b) in items.iter().enumerate() {
			if compare(a, b) != Ordering::Greater {
				continue;
			}
			for (k, c) in items.iter().enumerate() {
				// a > b and b > c, so a > c must hold.
				if compare(b, c) == Ordering::Greater && compare(a, c) != Ordering::Greater {
					return Some((i, j, k));
				}
			}
		}
	}
	None
}

/// Antisymmetry: `compare(a, b)` and `compare(b, a)` must be exact opposites.
///
/// A comparator built from a chain of `if` arms typically gets this right for
/// the arms it wrote and wrong for the fallthrough, so it is cheap to check and
/// occasionally the first thing to fire.
pub fn find_antisymmetry_violation<T, F>(items: &[T], compare: F) -> Option<(usize, usize)>
where
	T: Debug,
	F: Fn(&T, &T) -> Ordering,
{
	for (i, a) in items.iter().enumerate() {
		for (j, b) in items.iter().enumerate() {
			if compare(a, b) != compare(b, a).reverse() {
				return Some((i, j));
			}
		}
	}
	None
}

/// Reflexivity: every element compares `Equal` to itself.
pub fn find_irreflexive<T, F>(items: &[T], compare: F) -> Option<usize>
where
	T: Debug,
	F: Fn(&T, &T) -> Ordering,
{
	items
		.iter()
		.position(|item| compare(item, item) != Ordering::Equal)
}

/// Cap how much work one input may cause.
///
/// The axiom checks above are cubic in the number of items, so an unbounded
/// input list turns a fuzz target into a timeout detector for the fuzz target
/// rather than a bug detector for the code under test. libFuzzer reports a
/// timeout as a finding, which then buries the real ones.
///
/// 24 keeps the triple loop under 14k comparisons, well inside libFuzzer's
/// default one-second budget per input, and is still far more elements than any
/// known comparator bug needs (the walker one needs three).
pub const MAX_ORDER_ITEMS: usize = 24;

/// Cap on generated text length, for the same reason as [`MAX_ORDER_ITEMS`].
///
/// Output filters are linear in input size, so this is looser. It exists to
/// keep a pathological input from being reported as a timeout when the filter
/// is merely being asked to process a megabyte.
pub const MAX_TEXT_BYTES: usize = 64 * 1024;
