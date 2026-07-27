//! One owner for turning two texts into unified-diff text.
//!
//! Two crates in this workspace produce patches: the `diff` shell builtin in
//! `veyyon_uu_diff`, and plain-mode change capture in `veyyon-iso`. They print
//! different headers around the body and they read their inputs differently,
//! but the body itself, the rule for what counts as a line, and the rule for
//! what counts as binary are the same question and now have the same answer.
//! They did not before, and the drift was already real: the two crates split
//! lines differently and disagreed about how far into a file a NUL still means
//! binary, so the same pair of files could get a patch from one and a refusal
//! from the other.
//!
//! [`Unified`] is the body. It exists rather than a call to `similar`'s
//! `UnifiedDiff` because of the GNU flags that change how two lines COMPARE
//! without changing what is PRINTED: `diff -u -w` on `trail ` against `trail`
//! reports no difference, and when such a line appears as context it is printed
//! with its trailing space intact, because the transform decides equality only.
//! `similar` offers no comparator hook, since `TextDiff::from_lines` compares
//! the strings it is given and prints the strings it compared, so getting one
//! without the other means diffing key vectors yourself and formatting the
//! result.
//!
//! The format is pinned byte for byte by both consumers, against the `similar`
//! formatter this replaced: `the_unified_format_is_pinned_byte_for_byte` in
//! `veyyon_uu_diff` and `the_patch_text_is_pinned_byte_for_byte` in
//! `veyyon-iso`.

use std::{
	borrow::Cow,
	collections::HashMap,
	io::{self, Write},
};

use similar::{DiffOp, DiffTag};

/// The column a tab advances to when `-E` expands one.
///
/// GNU diff assumes stops every 8 columns and expands to the NEXT stop, which
/// is why `a\tb` and `a` followed by 7 spaces compare equal under `-E` while
/// the same line with 8 spaces does not: the tab sits at column 1 and only has
/// 7 columns left to fill. Measured against GNU diffutils 3.10.
const TAB_STOP: usize = 8;

/// The bytes GNU diff treats as whitespace, which is C-locale `isspace`.
///
/// Spelled out rather than deferred to `char::is_whitespace`, which is Unicode
/// and would fold characters GNU leaves alone, or to
/// `char::is_ascii_whitespace`, which omits the vertical tab that GNU does
/// fold. Verified against GNU diffutils 3.10: `a\vb` and `ab` compare equal
/// under `-w`.
const fn is_space(ch: char) -> bool {
	matches!(ch, ' ' | '\t' | '\n' | '\u{b}' | '\u{c}' | '\r')
}

/// Which of the comparison flags are in force.
///
/// One owner for all six, because they compose and the composition is where the
/// semantics are easy to get wrong: `-w` subsumes `-b`, `-Z` and `-E`, since a
/// key with no whitespace left in it cannot be affected by how much whitespace
/// there was or how a tab expanded.
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct Ignore {
	/// `-i`: fold case.
	pub case:           bool,
	/// `-w`: drop every whitespace character.
	pub all_space:      bool,
	/// `-b`: drop trailing whitespace and treat any run of whitespace as one
	/// space, so a run may not appear or disappear but may change length.
	pub space_change:   bool,
	/// `-Z`: drop trailing whitespace only.
	pub trailing_space: bool,
	/// `-E`: expand tabs before comparing.
	pub tab_expansion:  bool,
	/// `-B`: a change whose lines are all blank is not a difference.
	pub blank_lines:    bool,
}

impl Ignore {
	/// Whether any flag is set at all.
	///
	/// This is what decides whether the cheap byte comparison can answer the
	/// whole question. With no flag set, two files are equal exactly when their
	/// bytes are, so the comparison never has to load them.
	pub const fn any(self) -> bool {
		self.rewrites_lines() || self.blank_lines
	}

	/// Whether a line's key can differ from the line itself.
	///
	/// `-B` is excluded on purpose: it does not rewrite a line, it decides
	/// whether a change made only of blank lines counts.
	const fn rewrites_lines(self) -> bool {
		self.case || self.all_space || self.space_change || self.trailing_space || self.tab_expansion
	}

	/// The key `line` is compared by. Never printed.
	///
	/// The line arrives WITH its terminator and the key KEEPS it, which is what
	/// makes a missing final newline a difference: `a\nb` and `a\nb\n` differ in
	/// their last line's key, and GNU reports them as differing. The whitespace
	/// flags then fold the terminator away as trailing whitespace, which is why
	/// the same pair compares EQUAL under `-Z`, `-b` or `-w` and not under `-i`
	/// or `-E`. Both halves verified against GNU 3.10.
	pub fn key(self, line: &str) -> Cow<'_, str> {
		if !self.rewrites_lines() {
			return Cow::Borrowed(line);
		}
		let mut buf = if self.tab_expansion && !self.all_space {
			expand_tabs(line)
		} else {
			line.to_string()
		};
		if self.all_space {
			buf.retain(|ch| !is_space(ch));
		} else if self.space_change {
			buf = collapse_space_runs(trim_end_space(&buf));
		} else if self.trailing_space {
			buf.truncate(trim_end_space(&buf).len());
		}
		if self.case {
			buf = buf.to_lowercase();
		}
		Cow::Owned(buf)
	}
}

/// `line` without its trailing whitespace, using GNU's whitespace set.
fn trim_end_space(line: &str) -> &str {
	line.trim_end_matches(is_space)
}

/// Expand tabs to the next [`TAB_STOP`] boundary.
fn expand_tabs(line: &str) -> String {
	let mut out = String::with_capacity(line.len());
	let mut column = 0usize;
	for ch in line.chars() {
		if ch == '\t' {
			let width = TAB_STOP - column % TAB_STOP;
			out.extend(std::iter::repeat_n(' ', width));
			column += width;
		} else {
			out.push(ch);
			column += 1;
		}
	}
	out
}

/// Replace every run of whitespace with a single space, keeping whether there
/// was a run at all. That distinction is the whole of `-b`: `  a` equals `   a`
/// and neither equals `a`.
fn collapse_space_runs(line: &str) -> String {
	let mut out = String::with_capacity(line.len());
	let mut in_run = false;
	for ch in line.chars() {
		if is_space(ch) {
			if !in_run {
				out.push(' ');
				in_run = true;
			}
		} else {
			out.push(ch);
			in_run = false;
		}
	}
	out
}

/// How far into a file a NUL still means "binary".
///
/// MEASURED AGAINST GNU DIFF 3.10 rather than assumed. GNU sniffs whatever its
/// FIRST READ returned, which is the filesystem block size, so on a 4 KiB-block
/// filesystem a NUL at offset 4095 makes a file binary and one at 4096 does
/// not. That boundary is an artifact of GNU's buffering, not a designed
/// contract, and copying it would make the verdict depend on the filesystem the
/// input happens to live on. So the window is FIXED, and set to the same 4 KiB
/// that every mainstream Linux and macOS filesystem uses.
///
/// It was 8 KiB in BOTH consumers, and 8 KiB errs in the direction that costs
/// the user something: a file with a NUL between 4 KiB and 8 KiB in was called
/// binary here and diffed by GNU, so the patch was REFUSED rather than merely
/// formatted differently. One of the two copies was corrected without the
/// other, which is the whole argument for this constant living in one place.
pub const BINARY_SNIFF_WINDOW: usize = 4096;

/// Whether `bytes` should be treated as binary rather than diffed.
///
/// A NUL inside [`BINARY_SNIFF_WINDOW`] is the only signal. Callers that offer
/// a "treat it as text anyway" flag consult this and then override it, rather
/// than skipping it, because the answer also decides the wording they print.
pub fn looks_binary(bytes: &[u8]) -> bool {
	bytes
		.iter()
		.take(BINARY_SNIFF_WINDOW)
		.any(|&byte| byte == 0)
}

/// Split on `\n` ONLY, keeping the terminator on the line it ends.
///
/// GNU diff splits on `\n` and nothing else, so a lone `\r` is an ordinary
/// character in the middle of a line and `a\rb` is one line. `similar`'s line
/// tokenizer treats a bare `\r` as a break, which made such a file print a
/// two-line hunk GNU never produces. A final line without a terminator is
/// returned without one, which is how the `\ No newline at end of file` marker
/// is decided.
pub fn split_lines(text: &str) -> Vec<&str> {
	let mut lines = Vec::new();
	let mut start = 0;
	for (idx, _) in text.match_indices('\n') {
		lines.push(&text[start..=idx]);
		start = idx + 1;
	}
	if start < text.len() {
		lines.push(&text[start..]);
	}
	lines
}

/// Align two line-key sequences the way GNU diff aligns them.
///
/// Three passes, in GNU's order, and each one is GNU's:
///
/// 1. [`discard_unmatched`], GNU's `discard_confusing_lines`, drops every line
///    whose class does not occur in the other file and marks it changed. It
///    cannot change the COST, since such a line is in no common subsequence,
///    and it changes what the search sees as adjacent, which is what decides
///    which of two identical lines stays unchanged.
/// 2. [`compareseq`] finds a shortest edit script over what is left and records
///    it as a changed flag per line. Its bidirectional diagonal search order IS
///    GNU's tie preference, which is the only way to reach it: where several
///    alignments cost the same they can pair the unchanged lines with DIFFERENT
///    lines, and no rule applied afterwards turns one pairing into the other.
/// 3. [`shift_one_side`], GNU's `shift_boundaries`, slides each run of changed
///    lines as far as it will go, so a change reads at the earliest place it
///    can and against the other side's change rather than beside it. One side
///    at a time, in GNU's order: shifting the old side reads the new side's
///    flags as they are, and shifting the new side then reads the old side's
///    ALREADY shifted flags. Doing both from the original flags is a different
///    pass and does not converge to GNU's answer.
///
/// `tests/gnu_unified_differential.rs` measures the whole thing against GNU
/// diff 3.10 over 784 pair-and-flag combinations, and it agrees on ALL of them.
/// The history is the argument for each pass, because each was measured before
/// it was kept, and two passes that measured well on a narrower corpus were
/// REMOVED when it widened. Over the original 464 cases: `similar`'s Myers with
/// no normalization disagreed on 72; computing the alignment on `(new, old)`
/// and mirroring every op back took it to 33; adding the boundary shift took it
/// to 16; adding a `pull_unchanged_lines_back` normalization took it to 8;
/// replacing `similar`'s Myers with `compareseq` closed the last 8 at once.
/// Measured alternatives over those 464, all worse: `Algorithm::Lcs` 72,
/// `Algorithm::Patience` 40, normalizing without the mirror 89.
///
/// Both crutches are gone, and that is the point rather than an omission. The
/// mirror existed to bend a foreign tie preference toward GNU's, and GNU's own
/// search does not need bending. The pull was an invented approximation of pass
/// 1: on the widened corpus it cost 29 disagreements to buy 10, and porting the
/// pass it was imitating closed those 10 outright.
fn aligned_ops(old_keys: &[Cow<'_, str>], new_keys: &[Cow<'_, str>]) -> Vec<DiffOp> {
	let (old_equivs, new_equivs) = equivalence_classes(old_keys, new_keys);
	let classes = old_equivs.len() + new_equivs.len();
	let (old_kept, old_lines) = discard_unmatched(&old_equivs, &new_equivs, classes);
	let (new_kept, new_lines) = discard_unmatched(&new_equivs, &old_equivs, classes);
	let (reduced_old, reduced_new) = compareseq(&old_kept, &new_kept);
	let mut old_changed = restore_discarded(&reduced_old, &old_lines, old_equivs.len());
	let mut new_changed = restore_discarded(&reduced_new, &new_lines, new_equivs.len());
	// One side at a time, in GNU's order: shifting the old side reads the new
	// side's flags as they are, and shifting the new side then reads the old
	// side's ALREADY shifted flags. Doing both from the original flags is a
	// different pass and does not converge to GNU's answer.
	shift_one_side(&mut old_changed, &new_changed, &old_equivs);
	let frozen_old = old_changed.clone();
	shift_one_side(&mut new_changed, &frozen_old, &new_equivs);
	ops_from_changed(&old_changed, &new_changed)
}

/// One number per line, equal exactly when two lines compare equal.
///
/// `shift_boundaries` asks whether the line before a change group equals the
/// last line inside it, over and over, so the keys are reduced to integers once
/// rather than compared as strings at every step. The classes are shared by
/// both sides, which costs nothing and keeps one map.
fn equivalence_classes<'a>(
	old_keys: &'a [Cow<'a, str>],
	new_keys: &'a [Cow<'a, str>],
) -> (Vec<usize>, Vec<usize>) {
	let mut classes: HashMap<&str, usize> = HashMap::with_capacity(old_keys.len() + new_keys.len());
	let mut number = |keys: &'a [Cow<'a, str>]| -> Vec<usize> {
		keys
			.iter()
			.map(|key| {
				let next = classes.len();
				*classes.entry(key.as_ref()).or_insert(next)
			})
			.collect()
	};
	let old = number(old_keys);
	let new = number(new_keys);
	(old, new)
}

/// Where [`diag`] found the two halves of a problem meet.
struct Partition {
	xmid: usize,
	ymid: usize,
}

/// GNU diff's `diag`: the midpoint of a shortest edit script for one region.
///
/// A bidirectional Myers search. The forward search advances from `(xoff,
/// yoff)` and the backward search retreats from `(xlim, ylim)`, one edit step
/// per pass, and the first diagonal where the two meet is the midpoint the
/// caller splits on. `fd[d]` is the furthest `x` the forward search has reached
/// on diagonal `d = x - y`, `bd[d]` the furthest back the backward search has,
/// and the two arrays are indexed by a diagonal that runs negative, which is
/// what `offset` is for.
///
/// WHY THIS RATHER THAN A LIBRARY MYERS. Both find a shortest script, so where
/// the shortest one is unique any implementation agrees. Where several cost the
/// same the answer is decided by which diagonal is examined first, and that
/// order IS GNU's preference: the loops run from `fmax` down to `fmin`, so the
/// largest diagonal wins a tie, and `odd` decides whether a forward or a
/// backward meeting counts. No post-hoc rule reproduces that, because two
/// equal-cost alignments can pair the unchanged lines with DIFFERENT lines, and
/// no amount of sliding a change group turns one pairing into the other.
///
/// GNU's heuristics are deliberately absent. They are what `diff --minimal`
/// turns off, and they trade exactness for time on large inputs by giving up on
/// a diagonal that has run too long; running without them is running GNU with
/// `--minimal`, whose answer is the one this kernel reproduces.
// Clippy reads `xv[x] == yv[y]` as a typo and suggests `xv[x] == yv[x]`, which
// would compare a line against itself and break the search: the two sequences are
// walked on SEPARATE cursors, and that is the whole point of a diagonal.
#[allow(clippy::suspicious_operation_groupings, reason = "the suggested fix is the bug")]
fn diag(
	xoff: usize,
	xlim: usize,
	yoff: usize,
	ylim: usize,
	xv: &[usize],
	yv: &[usize],
	fd: &mut [isize],
	bd: &mut [isize],
	offset: isize,
) -> Partition {
	let (xoff_i, xlim_i) = (xoff as isize, xlim as isize);
	let (yoff_i, ylim_i) = (yoff as isize, ylim as isize);
	let dmin = xoff_i - ylim_i;
	let dmax = xlim_i - yoff_i;
	let fmid = xoff_i - yoff_i;
	let bmid = xlim_i - ylim_i;
	let (mut fmin, mut fmax) = (fmid, fmid);
	let (mut bmin, mut bmax) = (bmid, bmid);
	// True when the far corner sits on an odd diagonal relative to the near one,
	// which is what decides whether the FORWARD or the BACKWARD search is the one
	// allowed to declare the meeting point.
	let odd = (fmid - bmid) & 1 != 0;
	let at = |d: isize| -> usize {
		usize::try_from(d + offset).expect("every diagonal is inside the allocated band")
	};

	fd[at(fmid)] = xoff_i;
	bd[at(bmid)] = xlim_i;
	loop {
		// Widen the forward band, seeding the new edge with a value no real reach
		// can equal so the pick below always chooses the other neighbour.
		if fmin > dmin {
			fmin -= 1;
			fd[at(fmin - 1)] = -1;
		} else {
			fmin += 1;
		}
		if fmax < dmax {
			fmax += 1;
			fd[at(fmax + 1)] = -1;
		} else {
			fmax -= 1;
		}
		let mut d = fmax;
		while d >= fmin {
			let (below, above) = (fd[at(d - 1)], fd[at(d + 1)]);
			let mut x = if below >= above { below + 1 } else { above };
			let mut y = x - d;
			while x < xlim_i
				&& y < ylim_i
				&& xv[usize::try_from(x).expect("x is a line index")]
					== yv[usize::try_from(y).expect("y is a line index")]
			{
				x += 1;
				y += 1;
			}
			fd[at(d)] = x;
			if odd && bmin <= d && d <= bmax && bd[at(d)] <= x {
				return Partition {
					xmid: usize::try_from(x).expect("x is a line index"),
					ymid: usize::try_from(y).expect("y is a line index"),
				};
			}
			d -= 2;
		}

		// The same widening for the backward band. Its sentinel is the largest
		// value instead of the smallest, because this search picks the SMALLER
		// neighbour; the sentinel is therefore never chosen and never used as an
		// index, which is why an unrepresentable `x` cannot escape from here.
		if bmin > dmin {
			bmin -= 1;
			bd[at(bmin - 1)] = isize::MAX;
		} else {
			bmin += 1;
		}
		if bmax < dmax {
			bmax += 1;
			bd[at(bmax + 1)] = isize::MAX;
		} else {
			bmax -= 1;
		}
		let mut d = bmax;
		while d >= bmin {
			let (below, above) = (bd[at(d - 1)], bd[at(d + 1)]);
			let mut x = if below < above { below } else { above - 1 };
			let mut y = x - d;
			while xoff_i < x
				&& yoff_i < y
				&& xv[usize::try_from(x - 1).expect("x is a line index")]
					== yv[usize::try_from(y - 1).expect("y is a line index")]
			{
				x -= 1;
				y -= 1;
			}
			bd[at(d)] = x;
			if !odd && fmin <= d && d <= fmax && x <= fd[at(d)] {
				return Partition {
					xmid: usize::try_from(x).expect("x is a line index"),
					ymid: usize::try_from(y).expect("y is a line index"),
				};
			}
			d -= 2;
		}
	}
}

/// Drop the lines whose equivalence class does not occur in the other file at
/// all, returning the classes that remain and the line each one came from.
///
/// This is the exact half of GNU's `discard_confusing_lines`, and it is not an
/// optimization: it decides WHICH of two identical lines stays unchanged, which
/// is user-visible. A line with no counterpart cannot appear in any common
/// subsequence, so removing it before the search cannot change the cost, and
/// removing it changes what the search sees as adjacent. `c \n` against
/// `A\nc \n\nc \nA\n` is the shortest case: reduced to the two `c ` lines, the
/// head slide inside `compareseq` pairs the old line with the FIRST of them and
/// the rest of the file is one insertion, which is what GNU prints. Searching
/// the full sequences instead reaches the second copy just as cheaply, and the
/// two answers differ by which line the hunk calls context.
///
/// GNU's pass has a second, INEXACT half that also discards lines which do
/// occur in the other file but occur so often that pairing them is likely to be
/// noise. That half is a heuristic, it changes the cost, and it needs a file
/// large enough to reach GNU's `many_lines` threshold, so it is deliberately
/// not ported: this crate matches `diff --minimal`, and the differential corpus
/// measures the difference at 774 of 784 cases against a GNU run with the
/// heuristic enabled.
fn discard_unmatched(mine: &[usize], theirs: &[usize], classes: usize) -> (Vec<usize>, Vec<usize>) {
	let mut present = vec![false; classes];
	for class in theirs {
		present[*class] = true;
	}
	let mut kept = Vec::with_capacity(mine.len());
	let mut lines = Vec::with_capacity(mine.len());
	for (line, class) in mine.iter().enumerate() {
		if present[*class] {
			kept.push(*class);
			lines.push(line);
		}
	}
	(kept, lines)
}

/// Spread a reduced side's changed flags back over the real lines, marking
/// every discarded line changed.
///
/// A discarded line has no counterpart anywhere in the other file, so it is
/// changed by definition: an insertion if it is on the new side, a deletion if
/// it is on the old one. The flags come back on the real line numbers, which is
/// what [`shift_one_side`] and [`ops_from_changed`] work in.
fn restore_discarded(reduced: &[bool], lines: &[usize], total: usize) -> Vec<bool> {
	let mut changed = vec![true; total];
	for (index, line) in lines.iter().enumerate() {
		changed[*line] = reduced[index];
	}
	changed
}

/// GNU diff's `compareseq`: which lines of each side are changed.
///
/// Trim the matching head and tail of the region, then either the region is
/// empty on one side, which makes every remaining line on the other side
/// changed, or [`diag`] splits it in two and both halves are handled the same
/// way.
///
/// GNU recurses; this keeps an explicit stack. The two halves are disjoint, so
/// the order they come off it cannot change the result, and a file whose edit
/// script is as long as the file itself cannot exhaust the process stack.
// Clippy reads `xv[x] == yv[y]` as a typo and suggests `xv[x] == yv[x]`, which
// would compare a line against itself and break the search: the two sequences are
// walked on SEPARATE cursors, and that is the whole point of a diagonal.
#[allow(clippy::suspicious_operation_groupings, reason = "the suggested fix is the bug")]
fn compareseq(xv: &[usize], yv: &[usize]) -> (Vec<bool>, Vec<bool>) {
	let mut old_changed = vec![false; xv.len()];
	let mut new_changed = vec![false; yv.len()];
	// One band per direction, wide enough for every diagonal from `-yv.len()` to
	// `xv.len()`, plus the two sentinel edges. Allocated once for the whole run
	// rather than per split, which is what GNU does and what keeps a deep split
	// tree from allocating at every node.
	let diagonals = xv.len() + yv.len() + 3;
	let offset = isize::try_from(yv.len() + 1).expect("a line count fits in isize");
	let mut fd = vec![0isize; diagonals];
	let mut bd = vec![0isize; diagonals];
	let mut regions = vec![(0, xv.len(), 0, yv.len())];
	while let Some((mut xoff, mut xlim, mut yoff, mut ylim)) = regions.pop() {
		while xoff < xlim && yoff < ylim && xv[xoff] == yv[yoff] {
			xoff += 1;
			yoff += 1;
		}
		while xlim > xoff && ylim > yoff && xv[xlim - 1] == yv[ylim - 1] {
			xlim -= 1;
			ylim -= 1;
		}
		if xoff == xlim {
			for flag in &mut new_changed[yoff..ylim] {
				*flag = true;
			}
		} else if yoff == ylim {
			for flag in &mut old_changed[xoff..xlim] {
				*flag = true;
			}
		} else {
			let part = diag(xoff, xlim, yoff, ylim, xv, yv, &mut fd, &mut bd, offset);
			regions.push((part.xmid, xlim, part.ymid, ylim));
			regions.push((xoff, part.xmid, yoff, part.ymid));
		}
	}
	(old_changed, new_changed)
}

/// GNU diff's `shift_boundaries`, for one side.
///
/// This is the normalization that makes two equal-cost alignments collapse to
/// one answer, and it is the reason GNU's output is reproducible across
/// implementations at all. For each run of changed lines it does three things,
/// repeated until the run stops growing. It slides the run BACKWARD while the
/// unchanged line just before it equals the last changed line in it, which
/// merges the run with an earlier one when they meet. It then slides the run
/// FORWARD while the first changed line in it equals the unchanged line just
/// after, remembering the furthest point at which the run still lines up with a
/// changed run on the other side. Finally, if such a point exists behind where
/// the run ended up, the whole merged run moves back to it, so a change reads
/// against the other side's change rather than beside it.
///
/// The forward pass runs second on purpose: when nothing merges, the run ends
/// as far forward as it can go, which is what makes `a\nb\nc\n` against
/// `a\nb\nb\nc\n` report the SECOND `b` as inserted rather than the first.
///
/// `other_changed` is read and never written, which is why the caller shifts
/// one side at a time. Indices are signed because GNU reads one position before
/// the start and one past the end of both flag arrays and relies on those reads
/// answering "not changed"; the accessor below answers that for any index,
/// which is the same thing GNU gets from its zero-filled guard elements.
fn shift_one_side(changed: &mut [bool], other_changed: &[bool], equivs: &[usize]) {
	fn flag(flags: &[bool], index: isize) -> bool {
		index >= 0 && (index as usize) < flags.len() && flags[index as usize]
	}

	let i_end = changed.len() as isize;
	// `i` walks this side, `j` walks the other side, and the two stay in step
	// because every unchanged line on one side pairs with an unchanged line on the
	// other.
	let mut i: isize = 0;
	let mut j: isize = 0;
	loop {
		// Find the next run of changes, keeping the other side's cursor level with
		// it: skip that side's changed lines, then the one unchanged line that
		// pairs with this one.
		while i < i_end && !flag(changed, i) {
			while flag(other_changed, j) {
				j += 1;
			}
			j += 1;
			i += 1;
		}
		if i == i_end {
			break;
		}
		let mut start = i;
		i += 1;
		while flag(changed, i) {
			i += 1;
		}
		while flag(other_changed, j) {
			j += 1;
		}
		let mut corresponding;
		loop {
			// Remember the run's length, so the loop can tell whether a merge grew
			// it and the sliding has to be tried again.
			let runlength = i - start;
			while start > 0 && equivs[(start - 1) as usize] == equivs[(i - 1) as usize] {
				start -= 1;
				changed[start as usize] = true;
				i -= 1;
				changed[i as usize] = false;
				while flag(changed, start - 1) {
					start -= 1;
				}
				loop {
					j -= 1;
					if !flag(other_changed, j) {
						break;
					}
				}
			}
			corresponding = if flag(other_changed, j - 1) { i } else { i_end };
			while i != i_end && equivs[start as usize] == equivs[i as usize] {
				changed[start as usize] = false;
				start += 1;
				changed[i as usize] = true;
				i += 1;
				while flag(changed, i) {
					i += 1;
				}
				loop {
					j += 1;
					if flag(other_changed, j) {
						corresponding = i;
					} else {
						break;
					}
				}
			}
			if runlength == i - start {
				break;
			}
		}
		// Move the fully merged run back to the last place it lined up with a
		// changed run on the other side.
		while corresponding < i {
			start -= 1;
			changed[start as usize] = true;
			i -= 1;
			changed[i as usize] = false;
			loop {
				j -= 1;
				if !flag(other_changed, j) {
					break;
				}
			}
		}
	}
}

/// Turn the flag arrays back into the op list the printer and the grouper read.
///
/// A line neither side calls changed is one equal pair, and unchanged lines
/// pair up in order, so walking both arrays together is enough: while both
/// cursors sit on unchanged lines the run is `Equal`, and where either is
/// changed the run is the deletion and the insertion that face each other.
fn ops_from_changed(old_changed: &[bool], new_changed: &[bool]) -> Vec<DiffOp> {
	let mut ops = Vec::new();
	let mut old_index = 0;
	let mut new_index = 0;
	while old_index < old_changed.len() || new_index < new_changed.len() {
		let old_is_changed = old_changed.get(old_index).copied().unwrap_or(false);
		let new_is_changed = new_changed.get(new_index).copied().unwrap_or(false);
		if !old_is_changed
			&& !new_is_changed
			&& old_index < old_changed.len()
			&& new_index < new_changed.len()
		{
			let old_start = old_index;
			let new_start = new_index;
			while old_index < old_changed.len()
				&& new_index < new_changed.len()
				&& !old_changed[old_index]
				&& !new_changed[new_index]
			{
				old_index += 1;
				new_index += 1;
			}
			ops.push(DiffOp::Equal {
				old_index: old_start,
				new_index: new_start,
				len:       old_index - old_start,
			});
			continue;
		}
		let old_start = old_index;
		let new_start = new_index;
		while old_index < old_changed.len() && old_changed[old_index] {
			old_index += 1;
		}
		while new_index < new_changed.len() && new_changed[new_index] {
			new_index += 1;
		}
		let old_len = old_index - old_start;
		let new_len = new_index - new_start;
		match (old_len, new_len) {
			(0, 0) => {
				unreachable!("a position neither side calls changed is an equal pair, handled above")
			},
			(0, _) => ops.push(DiffOp::Insert { old_index: old_start, new_index: new_start, new_len }),
			(_, 0) => ops.push(DiffOp::Delete { old_index: old_start, old_len, new_index: new_start }),
			(..) => ops.push(DiffOp::Replace {
				old_index: old_start,
				old_len,
				new_index: new_start,
				new_len,
			}),
		}
	}
	ops
}

/// A computed unified diff: the lines of both sides and the hunks that survived
/// grouping and, under `-B`, filtering.
///
/// Computing and printing are separate because the caller has to know whether
/// anything differs BEFORE it writes: `-s` prints a sentence when nothing does,
/// `-q` prints a different one when something does, and directory mode prints
/// the `diff -r A/x B/x` line only ahead of a hunk that is actually coming.
pub struct Unified<'a> {
	old:    Vec<&'a str>,
	new:    Vec<&'a str>,
	groups: Vec<Vec<DiffOp>>,
}

impl<'a> Unified<'a> {
	/// Diff `old` against `new` by comparison key and group the result into
	/// hunks of `context` surrounding lines.
	pub fn compute(old: &'a str, new: &'a str, context: usize, ig: Ignore) -> Self {
		let old_lines = split_lines(old);
		let new_lines = split_lines(new);
		let old_keys: Vec<Cow<'a, str>> = old_lines.iter().map(|line| ig.key(line)).collect();
		let new_keys: Vec<Cow<'a, str>> = new_lines.iter().map(|line| ig.key(line)).collect();
		let ops = aligned_ops(&old_keys, &new_keys);
		let ignorable = |op: DiffOp| ig.blank_lines && change_is_all_blank(op, &old_keys, &new_keys);
		let mut groups = group_ops(&ops, context, &ignorable);
		// A hunk survives when it changes something `-B` does not ignore. With `-B`
		// off nothing is ignorable, so nothing is dropped.
		groups.retain(|group| {
			group
				.iter()
				.any(|op| !matches!(op.as_tag_tuple().0, DiffTag::Equal) && !ignorable(*op))
		});
		Unified { old: old_lines, new: new_lines, groups }
	}

	/// Whether any hunk survived, which is the exit status and also the answer
	/// `-q` and `-s` report.
	///
	/// Under `-B` this is NOT the same as "the keys differ": two files whose
	/// only difference is a blank line have differing keys and no surviving
	/// hunk, and GNU calls them identical.
	pub const fn differs(&self) -> bool {
		!self.groups.is_empty()
	}

	/// Write the hunks. The `---`/`+++` header is written once, ahead of the
	/// first one, and not at all when there are none.
	pub fn write<W: Write>(&self, out: &mut W, label_a: &str, label_b: &str) -> io::Result<()> {
		let mut wrote_header = false;
		for group in &self.groups {
			if !wrote_header {
				writeln!(out, "--- {label_a}")?;
				writeln!(out, "+++ {label_b}")?;
				wrote_header = true;
			}
			let first = group[0];
			let last = group[group.len() - 1];
			writeln!(
				out,
				"@@ -{} +{} @@",
				range_spec(first.old_range().start, last.old_range().end),
				range_spec(first.new_range().start, last.new_range().end)
			)?;
			for op in group {
				let (tag, old_range, new_range) = op.as_tag_tuple();
				match tag {
					DiffTag::Equal => write_lines(out, ' ', &self.old[old_range])?,
					DiffTag::Delete => write_lines(out, '-', &self.old[old_range])?,
					DiffTag::Insert => write_lines(out, '+', &self.new[new_range])?,
					// Every deletion first, then every insertion, which is the order
					// `similar`'s own change iterator yields for a replaced run.
					DiffTag::Replace => {
						write_lines(out, '-', &self.old[old_range])?;
						write_lines(out, '+', &self.new[new_range])?;
					},
				}
			}
		}
		Ok(())
	}
}

/// Whether every line this ONE change touches has an empty key: GNU's test for
/// whether a change is IGNORABLE under `-B`.
///
/// The unit is the change RUN and not the hunk, because a run is what GNU
/// marks: [`group_ops`] shortens the distance over which an ignorable run joins
/// its neighbour, and [`Unified::compute`] drops a hunk in which every change
/// is ignorable. Measured against GNU diff 3.10 on four shapes:
///
/// * deleting only blank lines, or inserting only blank lines, is no difference
///   at all and exits 0;
/// * a run that replaces blank lines with blank lines is no difference either,
///   even when the COUNT changes (one blank against two);
/// * a run that replaces blank lines with real ones, or the reverse, is printed
///   WHOLE, both sides, because the run is not all blank;
/// * an ignorable run still prints when a hunk holds it together with a real
///   change: `\n b\n old\n` against `b\n new\n` prints the deleted blank.
///
/// The test is on the key and not on the raw line, so it composes: with `-B`
/// alone only a truly empty line is blank, while `-B -w` also treats a line of
/// spaces as blank because `-w` empties it. GNU reports a difference for a
/// deleted whitespace-only line under `-B` and none under `-B -w`.
fn change_is_all_blank(op: DiffOp, old_keys: &[Cow<'_, str>], new_keys: &[Cow<'_, str>]) -> bool {
	let blank = |keys: &[Cow<'_, str>]| keys.iter().all(|key| key_is_blank(key));
	match op.as_tag_tuple() {
		(DiffTag::Equal, ..) => false,
		(DiffTag::Delete, old_range, _) => blank(&old_keys[old_range]),
		(DiffTag::Insert, _, new_range) => blank(&new_keys[new_range]),
		(DiffTag::Replace, old_range, new_range) => {
			blank(&old_keys[old_range]) && blank(&new_keys[new_range])
		},
	}
}

/// Group the changes into hunks carrying at most `context` unchanged lines on
/// each side, the way GNU diff groups unified output.
///
/// This is ours rather than [`similar::group_diff_ops`] because that function
/// splits on a fixed distance and GNU's distance depends on the NEXT change:
///
/// * two changes join while fewer than `2 * context + 1` unchanged lines
///   separate them, which is the ordinary rule and the only rule without `-B`;
/// * when the next change is IGNORABLE the distance shrinks to `context`, so an
///   ignorable run joins a hunk only when it is close enough to be printed
///   inside it, and otherwise becomes a hunk of its own that
///   [`Unified::compute`] then drops.
///
/// The asymmetry is measured, not reasoned, and it is genuinely one-sided: with
/// `context` 3, a real change followed by a blank-only deletion splits once 3
/// unchanged lines separate them, while a blank-only deletion followed by a
/// real change joins across 6 and splits at 7. Both directions were scanned
/// over gaps 0 to 8 at `context` 3 and again at `context` 1 against GNU diff
/// 3.10, and the same numbers came back: the threshold reads the ignorability
/// of the change it is about to reach and nothing else. Leading and trailing
/// runs are trimmed to `context` lines.
fn group_ops(
	ops: &[DiffOp],
	context: usize,
	ignorable: &impl Fn(DiffOp) -> bool,
) -> Vec<Vec<DiffOp>> {
	let mut groups: Vec<Vec<DiffOp>> = Vec::new();
	let mut group: Vec<DiffOp> = Vec::new();
	let mut run: Vec<DiffOp> = Vec::new();
	for op in ops.iter().copied() {
		if matches!(op.as_tag_tuple().0, DiffTag::Equal) {
			run.push(op);
			continue;
		}
		let threshold = if ignorable(op) {
			context
		} else {
			context * 2 + 1
		};
		if group.is_empty() {
			group.extend(run_tail(&run, context));
		} else if run_len(&run) >= threshold {
			group.extend(run_head(&run, context));
			groups.push(std::mem::take(&mut group));
			group.extend(run_tail(&run, context));
		} else {
			group.extend(run.iter().copied());
		}
		run.clear();
		group.push(op);
	}
	if !group.is_empty() {
		group.extend(run_head(&run, context));
		groups.push(group);
	}
	groups
}

/// How many unchanged lines a run holds.
fn run_len(run: &[DiffOp]) -> usize {
	run.iter().map(|op| op.new_range().len()).sum()
}

/// The first `lines` unchanged lines of a run, as whole or truncated ops.
fn run_head(run: &[DiffOp], lines: usize) -> Vec<DiffOp> {
	let mut left = lines;
	let mut head = Vec::new();
	for op in run {
		if left == 0 {
			break;
		}
		let (old_range, new_range) = (op.old_range(), op.new_range());
		let keep = left.min(new_range.len());
		head.push(DiffOp::Equal {
			old_index: old_range.start,
			new_index: new_range.start,
			len:       keep,
		});
		left -= keep;
	}
	head
}

/// The last `lines` unchanged lines of a run, as whole or truncated ops.
fn run_tail(run: &[DiffOp], lines: usize) -> Vec<DiffOp> {
	let mut left = lines;
	let mut tail = Vec::new();
	for op in run.iter().rev() {
		if left == 0 {
			break;
		}
		let (old_range, new_range) = (op.old_range(), op.new_range());
		let keep = left.min(new_range.len());
		let skip = new_range.len() - keep;
		tail.push(DiffOp::Equal {
			old_index: old_range.start + skip,
			new_index: new_range.start + skip,
			len:       keep,
		});
		left -= keep;
	}
	tail.reverse();
	tail
}

/// Whether a key is a blank line: nothing on it but its terminator.
///
/// The terminator is stripped here and not in [`Ignore::key`] because the key
/// needs it (a missing final newline is a difference) and this question does
/// not (a file's last blank line is blank whether or not it ends in a newline).
fn key_is_blank(key: &str) -> bool {
	key.strip_suffix('\n').unwrap_or(key).is_empty()
}

/// One side of a hunk header.
///
/// A one-line range is written as the line number alone, with no length, and an
/// EMPTY range points at the line before it because there is no line inside it
/// to name. Both are GNU's conventions and both were `similar`'s.
fn range_spec(start: usize, end: usize) -> String {
	let len = end.saturating_sub(start);
	if len == 1 {
		return format!("{}", start + 1);
	}
	let beginning = if len == 0 { start } else { start + 1 };
	format!("{beginning},{len}")
}

/// Write `lines` under `tag`, restoring the terminator the split removed and
/// marking a line that never had one.
fn write_lines<W: Write>(out: &mut W, tag: char, lines: &[&str]) -> io::Result<()> {
	for line in lines {
		match line.strip_suffix('\n') {
			Some(body) => writeln!(out, "{tag}{body}")?,
			None => writeln!(out, "{tag}{line}\n\\ No newline at end of file")?,
		}
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	/// `count` numbered lines, `<prefix>1` through `<prefix>count`, each ending
	/// in a newline.
	///
	/// One owner for the filler every hunk-shape fixture needs: a file long
	/// enough that the context window does not reach its ends. Written as a
	/// loop rather than `map(format!).collect()` because the collect form is a
	/// lint here, and four copies of the loop would be four places to read.
	fn numbered_lines(prefix: &str, count: usize) -> String {
		let mut built = String::new();
		for index in 1..=count {
			built.push_str(prefix);
			built.push_str(&index.to_string());
			built.push('\n');
		}
		built
	}

	/// The numbered filler is what the fixtures assume: one line per number, in
	/// order, each terminated, and nothing else.
	#[test]
	fn the_numbered_filler_is_one_terminated_line_per_number() {
		assert_eq!(numbered_lines("f", 3), "f1\nf2\nf3\n");
		assert_eq!(numbered_lines("L", 1), "L1\n");
		assert_eq!(numbered_lines("f", 0), "", "a zero-line gap is empty, not a stray newline");
		assert_eq!(numbered_lines("f", 12).lines().count(), 12);
	}

	/// The key transform, tested directly rather than only through the CLI,
	/// because it is the one place all six flags meet and the composition rules
	/// were measured against GNU diffutils 3.10 one pair at a time.
	mod a_comparison_key_is_what_the_ignore_flags_change {
		use super::*;

		fn key(ig: Ignore, line: &str) -> String {
			ig.key(line).into_owned()
		}

		/// With nothing set the key is the line minus its terminator, so the
		/// comparison is byte equality and the transform costs no allocation.
		#[test]
		fn no_flag_leaves_the_line_alone_and_borrows_it() {
			let ig = Ignore::default();
			assert!(matches!(ig.key("a b \n"), Cow::Borrowed("a b \n")));
			assert!(matches!(ig.key("no terminator"), Cow::Borrowed("no terminator")));
			assert!(!ig.any(), "a default Ignore must let the byte comparison answer");
		}

		/// `-w` removes every whitespace byte, so `ab` and `a b` collide. This is
		/// the flag that makes indentation and line wrapping invisible.
		#[test]
		fn all_space_removes_every_whitespace_byte() {
			let ig = Ignore { all_space: true, ..Ignore::default() };
			assert_eq!(key(ig, "  a\tb \n"), "ab");
			assert_eq!(key(ig, "ab\n"), "ab");
			assert_eq!(key(ig, "a\u{b}b\n"), "ab", "the vertical tab is whitespace to GNU");
		}

		/// `-b` keeps WHETHER there was a run and forgets HOW LONG it was, which
		/// is exactly the distinction `-w` throws away. Trailing runs go
		/// entirely.
		#[test]
		fn space_change_collapses_runs_but_not_their_presence() {
			let ig = Ignore { space_change: true, ..Ignore::default() };
			assert_eq!(key(ig, "a  b\n"), "a b");
			assert_eq!(key(ig, "a b\n"), "a b");
			assert_eq!(key(ig, "ab\n"), "ab", "a run may not appear from nothing");
			assert_eq!(key(ig, "  a\n"), " a", "a leading run collapses, it does not vanish");
			assert_eq!(key(ig, "   a\n"), " a");
			assert_eq!(key(ig, "trail   \n"), "trail", "a trailing run vanishes entirely");
		}

		/// `-Z` touches the END of the line only, which is what separates it from
		/// `-b`: internal spacing still counts.
		#[test]
		fn trailing_space_only_touches_the_end() {
			let ig = Ignore { trailing_space: true, ..Ignore::default() };
			assert_eq!(key(ig, "trail \t\n"), "trail");
			assert_eq!(key(ig, "a  b\n"), "a  b", "internal spacing survives -Z");
			assert_eq!(key(ig, "  a\n"), "  a", "so does leading spacing");
		}

		/// A CRLF line ends in whitespace, so `-Z` folds the `\r` away and a CRLF
		/// file compares equal to the same file with LF endings. Verified against
		/// GNU 3.10.
		#[test]
		fn trailing_space_folds_a_carriage_return_away() {
			let ig = Ignore { trailing_space: true, ..Ignore::default() };
			assert_eq!(key(ig, "line\r\n"), "line");
			assert_eq!(key(ig, "line\n"), "line");
		}

		/// A missing final newline is a trailing-whitespace difference to GNU, so
		/// the last line of `a\nb` and of `a\nb\n` produce the SAME key under
		/// `-Z`.
		#[test]
		fn a_missing_terminator_is_invisible_to_the_whitespace_flags() {
			for ig in [
				Ignore { trailing_space: true, ..Ignore::default() },
				Ignore { space_change: true, ..Ignore::default() },
				Ignore { all_space: true, ..Ignore::default() },
			] {
				assert_eq!(key(ig, "b"), key(ig, "b\n"), "{ig:?}");
			}
		}

		/// `-E` expands to the next 8-column stop rather than substituting a
		/// fixed number of spaces, which is why a tab after one character is
		/// worth SEVEN spaces and a tab at the start is worth eight.
		#[test]
		fn tab_expansion_advances_to_the_next_stop() {
			let ig = Ignore { tab_expansion: true, ..Ignore::default() };
			assert_eq!(key(ig, "\ta\n"), "        a\n");
			assert_eq!(key(ig, "a\tb\n"), "a       b\n");
			assert_eq!(key(ig, "a\tb\n").len(), "a       b\n".len(), "seven spaces, not eight");
			assert_eq!(
				key(ig, "abcdefgh\tx\n"),
				"abcdefgh        x\n",
				"a full stop advances a whole one"
			);
		}

		/// `-i` folds case and nothing else, so it can be composed with a
		/// whitespace flag without either swallowing the other.
		#[test]
		fn case_folds_and_composes() {
			let folded = Ignore { case: true, ..Ignore::default() };
			assert_eq!(key(folded, "Hello  World\n"), "hello  world\n");
			let both = Ignore { case: true, all_space: true, ..Ignore::default() };
			assert_eq!(key(both, "Hello  World\n"), key(both, "hello World\n"));
		}

		/// `-w` subsumes the other whitespace flags, so setting them together
		/// cannot produce a key that differs from `-w` alone. If it could, the
		/// order the transform applies them in would be observable.
		#[test]
		fn all_space_subsumes_the_narrower_whitespace_flags() {
			let wide = Ignore { all_space: true, ..Ignore::default() };
			let piled = Ignore {
				all_space: true,
				space_change: true,
				trailing_space: true,
				tab_expansion: true,
				..Ignore::default()
			};
			for line in ["\ta  b \n", "ab\n", "  \n", "a\r\n"] {
				assert_eq!(key(wide, line), key(piled, line), "line {line:?}");
			}
		}

		/// `-B` alone does not rewrite lines, so it must not push the comparison
		/// off the cheap byte path for the wrong reason while still counting as
		/// a flag.
		#[test]
		fn blank_lines_counts_as_a_flag_without_rewriting_anything() {
			let ig = Ignore { blank_lines: true, ..Ignore::default() };
			assert!(ig.any());
			assert!(!ig.rewrites_lines());
			assert_eq!(key(ig, "  a  \n"), "  a  \n", "-B leaves the line and its terminator alone");
		}
	}

	/// Line splitting, which decides both the line count and where the
	/// `\ No newline at end of file` marker goes.
	mod lines_are_split_on_newline_only {
		use super::*;

		/// The terminator stays on the line it ends, so joining the result gives
		/// back the input byte for byte. That property is what lets the formatter
		/// print originals.
		#[test]
		fn splitting_is_reversible() {
			for text in ["", "a\n", "a\nb\n", "a\nb", "\n\n", "a\r\nb\r\n", "a\rb\n"] {
				assert_eq!(split_lines(text).concat(), text, "text {text:?}");
			}
		}

		/// A lone `\r` is not a break. GNU splits on `\n` and nothing else.
		#[test]
		fn a_lone_carriage_return_is_part_of_the_line() {
			assert_eq!(split_lines("a\rb\n"), vec!["a\rb\n"]);
			assert_eq!(split_lines("a\rb\rc\n"), vec!["a\rb\rc\n"]);
		}

		/// A `\r\n` line keeps its `\r` in the body and its `\n` as the
		/// terminator, so the line is printed back with both.
		#[test]
		fn a_crlf_line_keeps_both_bytes() {
			assert_eq!(split_lines("one\r\ntwo\r\n"), vec!["one\r\n", "two\r\n"]);
		}

		/// An empty input has no lines at all, which is what makes an empty file
		/// produce the `-0,0` range rather than a single blank line.
		#[test]
		fn an_empty_input_has_no_lines() {
			assert!(split_lines("").is_empty());
		}

		/// Only the LAST line can lack a terminator, and it does lack one, which
		/// is the marker's trigger.
		#[test]
		fn only_a_final_line_may_be_unterminated() {
			let lines = split_lines("a\nb\nc");
			assert_eq!(lines, vec!["a\n", "b\n", "c"]);
			assert!(
				lines[..lines.len() - 1]
					.iter()
					.all(|line| line.ends_with('\n'))
			);
		}

		/// A file of nothing but terminators is that many empty lines, which is
		/// the input `-B` is about.
		#[test]
		fn bare_terminators_are_empty_lines() {
			assert_eq!(split_lines("\n\n\n"), vec!["\n", "\n", "\n"]);
		}
	}

	/// The hunk-header arithmetic, which has two special cases that a plain
	/// `start,len` would get wrong.
	mod a_hunk_header_names_its_range {
		use super::*;

		/// One line is written bare, with no length.
		#[test]
		fn a_single_line_range_omits_the_length() {
			assert_eq!(range_spec(0, 1), "1");
			assert_eq!(range_spec(41, 42), "42");
		}

		/// An empty range points at the line BEFORE it, so an insertion into the
		/// top of a file reads `-0,0`.
		#[test]
		fn an_empty_range_points_at_the_line_before_it() {
			assert_eq!(range_spec(0, 0), "0,0");
			assert_eq!(range_spec(7, 7), "7,0");
		}

		/// Anything longer is the ordinary one-based start and length.
		#[test]
		fn a_longer_range_is_start_and_length() {
			assert_eq!(range_spec(0, 2), "1,2");
			assert_eq!(range_spec(121, 128), "122,7");
		}
	}

	/// `-B`'s hunk filter, which is the only flag that changes hunks rather than
	/// keys.
	mod blank_only_hunks_are_dropped {
		use super::*;

		fn diff(old: &str, new: &str, ig: Ignore) -> (bool, String) {
			let unified = Unified::compute(old, new, 3, ig);
			let mut out = Vec::new();
			unified.write(&mut out, "a", "b").unwrap();
			(unified.differs(), String::from_utf8(out).unwrap())
		}

		/// A file whose only change is blank lines has no surviving hunk, so it
		/// prints nothing and reports no difference. GNU exits 0 here.
		#[test]
		fn a_change_of_only_blank_lines_is_not_a_difference() {
			let ig = Ignore { blank_lines: true, ..Ignore::default() };
			let (differs, out) = diff("x\n\n\ny\n", "x\ny\n", ig);
			assert!(!differs);
			assert_eq!(out, "");
		}

		/// Without `-B` the same pair differs, so the filter is doing the work
		/// and the inputs are not accidentally equal.
		#[test]
		fn the_same_pair_differs_without_the_flag() {
			let (differs, out) = diff("x\n\n\ny\n", "x\ny\n", Ignore::default());
			assert!(differs);
			assert_eq!(out, "--- a\n+++ b\n@@ -1,4 +1,2 @@\n x\n-\n-\n y\n");
		}

		/// A hunk that also carries a real change is printed WHOLE, blank lines
		/// included. `-B` drops whole hunks and never edits one it keeps: which
		/// lines land in a hunk is [`group_ops`]' business, and here the blank
		/// and the changed line are one run, so there is nothing to separate.
		#[test]
		fn a_mixed_hunk_keeps_its_blank_lines() {
			let ig = Ignore { blank_lines: true, ..Ignore::default() };
			let (differs, out) = diff("x\n\nold\n", "x\nnew\n", ig);
			assert!(differs);
			assert_eq!(out, "--- a\n+++ b\n@@ -1,3 +1,2 @@\n x\n-\n-old\n+new\n");
		}

		/// Two hunks far enough apart not to merge: the blank-only one goes and
		/// the real one stays, keeping its ORIGINAL line numbers. Dropping a
		/// hunk does not renumber the file.
		#[test]
		fn a_blank_only_hunk_goes_and_a_distant_real_one_stays() {
			let ig = Ignore { blank_lines: true, ..Ignore::default() };
			let filler = numbered_lines("f", 12);
			let old: String = format!("x\n\n{filler}old\n");
			let new: String = format!("x\n{filler}new\n");
			let (differs, out) = diff(&old, &new, ig);
			assert!(differs);
			assert_eq!(
				out, "--- a\n+++ b\n@@ -12,4 +11,4 @@\n f10\n f11\n f12\n-old\n+new\n",
				"the surviving hunk still counts the blank line that was not printed"
			);
		}

		/// A blank line that did NOT change is ordinary context and is printed.
		#[test]
		fn an_unchanged_blank_line_stays_context() {
			let ig = Ignore { blank_lines: true, ..Ignore::default() };
			let (differs, out) = diff("a\n\nb\nold\n", "a\n\nb\nnew\n", ig);
			assert!(differs);
			assert_eq!(out, "--- a\n+++ b\n@@ -1,4 +1,4 @@\n a\n \n b\n-old\n+new\n");
		}

		/// A BLANK LINE THAT MOVED PAST A REAL ONE IS NOT A DIFFERENCE, because
		/// the alignment that matches the real line and changes the blanks is
		/// the one GNU picks and the one `-B` is written against.
		///
		/// This is the case the alignment tie-break exists for. `-B` drops a hunk
		/// whose changed lines are all blank, and WHICH lines a hunk changes
		/// depends on which of two equally minimal alignments was chosen.
		/// `similar`'s Myers matched the blank and changed `x`, so the hunk was
		/// not blank-only and we reported a difference GNU does not; asking it
		/// the question from the other side, as `aligned_ops` does, matches the
		/// real line and changes the blanks, so the hunk is blank-only and
		/// drops.
		///
		/// Measured: GNU diff 3.10 exits 0 on both pairs, and so do we now.
		/// Without `-B` both pairs still report, and the hunk shape is asserted
		/// too, so a fix that dropped the difference entirely would fail here.
		#[test]
		fn a_blank_line_that_moved_past_a_real_one_is_not_a_difference() {
			let ig = Ignore { blank_lines: true, ..Ignore::default() };

			assert!(!diff("\nx\n", "x\n\n", ig).0, "GNU diff 3.10 exits 0 for this pair");
			assert!(!diff("x\n\ny\n", "x\ny\n\n", ig).0, "and for this one");

			// The same pairs WITHOUT `-B`: the difference is still there and is still
			// reported, with GNU's alignment, which changes the blanks and keeps the real
			// line as context.
			let plain = Ignore::default();
			let (differs, out) = diff("\nx\n", "x\n\n", plain);
			assert!(differs, "the bytes differ, and without -B that is a difference");
			assert_eq!(out, "--- a\n+++ b\n@@ -1,2 +1,2 @@\n-\n x\n+\n");

			let (differs, out) = diff("x\n\ny\n", "x\ny\n\n", plain);
			assert!(differs);
			assert_eq!(out, "--- a\n+++ b\n@@ -1,3 +1,3 @@\n x\n-\n y\n+\n");
		}

		/// The tie-break in its plainest form: swapping two adjacent lines
		/// reports the DELETION first, which is GNU's answer (`-a`, ` b`, `+a`)
		/// and the opposite of what `similar` produces on its own (`+b`, ` a`,
		/// `-b`). Both cost two edits, and the difference is invisible until
		/// somebody compares.
		#[test]
		fn a_swap_reports_the_deletion_before_the_insertion() {
			let (differs, out) = diff("a\nb\n", "b\na\n", Ignore::default());

			assert!(differs);
			assert_eq!(out, "--- a\n+++ b\n@@ -1,2 +1,2 @@\n-a\n b\n+a\n");
		}

		/// A moved BLOCK reports the same way: the first lines that stop agreeing
		/// are deleted and re-inserted after the block that stayed. Asserting a
		/// run and not a single line keeps the rule from being read as an
		/// accident of length one.
		#[test]
		fn a_moved_block_reports_the_deletion_first_too() {
			let (differs, out) = diff("a\nb\nc\nd\n", "c\nd\na\nb\n", Ignore::default());

			assert!(differs);
			assert_eq!(out, "--- a\n+++ b\n@@ -1,4 +1,4 @@\n-a\n-b\n c\n d\n+a\n+b\n");
		}

		/// The same shape where the blank COUNT also changes, which GNU reports
		/// too: its longest common subsequence is the two blanks, so the real
		/// line is what changed and the hunk is not blank-only. Here both tools
		/// agree, which is what makes the case above a tie-break difference
		/// rather than a rule difference.
		#[test]
		fn a_blank_count_change_around_a_real_line_is_reported_by_both() {
			let ig = Ignore { blank_lines: true, ..Ignore::default() };
			assert!(diff("\n\na\n", "a\n\n\n", ig).0, "GNU 3.10 exits 1 here as well");
		}

		/// A whitespace-only line is NOT blank to `-B` alone, and IS blank once
		/// `-w` has emptied it. The blank test reads the key, which is what makes
		/// the two flags compose.
		#[test]
		fn a_whitespace_only_line_is_blank_only_once_a_flag_empties_it() {
			let alone = Ignore { blank_lines: true, ..Ignore::default() };
			assert!(diff("x\n   \ny\n", "x\ny\n", alone).0, "-B alone sees a non-empty line");
			let with_w = Ignore { blank_lines: true, all_space: true, ..Ignore::default() };
			assert!(!diff("x\n   \ny\n", "x\ny\n", with_w).0, "-w empties it, so -B drops it");
		}
	}

	/// How far apart two changes may sit and still share a hunk.
	///
	/// WHY THIS SUITE EXISTS. `group_ops` replaced `similar::group_diff_ops`
	/// because GNU's join distance is not a constant: it shrinks from
	/// `2 * context + 1` to `context` when the change it is about to reach is
	/// IGNORABLE, which under `-B` means a change whose every line is blank.
	/// That one number decides whether a blank-only change is printed inside a
	/// hunk with a real change or becomes a hunk of its own and disappears, so
	/// getting it wrong silently prints or silently swallows lines. The
	/// distance itself is invisible, so every case here asserts the `@@` header
	/// GNU diff 3.10 prints, which is the only place the grouping shows.
	mod hunks_group_the_way_gnu_groups_them {
		use super::*;

		/// The body GNU compares against: hunks only, no `---`/`+++` header.
		fn hunks(old: &str, new: &str, context: usize, ig: Ignore) -> String {
			let mut out = Vec::new();
			Unified::compute(old, new, context, ig)
				.write(&mut out, "a", "b")
				.expect("writing to a Vec cannot fail");
			let printed = String::from_utf8(out).expect("the fixtures are UTF-8");
			printed
				.strip_prefix("--- a\n+++ b\n")
				.unwrap_or(&printed)
				.to_string()
		}

		/// `n` numbered filler lines, the unchanged gap between two changes.
		fn gap(lines: usize) -> String {
			numbered_lines("L", lines)
		}

		/// Two ordinary changes join across `2 * context` unchanged lines.
		///
		/// The baseline every other case is measured against, and the only rule
		/// in force when `-B` is off. Six lines between two changed lines at
		/// `context` 3 means the trailing context of the first still touches the
		/// leading context of the second, so one hunk covers both.
		#[test]
		fn two_real_changes_join_across_twice_the_context() {
			let old = format!("A\n{}B\n", gap(6));
			let new = format!("a\n{}b\n", gap(6));

			assert_eq!(
				hunks(&old, &new, 3, Ignore::default()),
				"@@ -1,8 +1,8 @@\n-A\n+a\n L1\n L2\n L3\n L4\n L5\n L6\n-B\n+b\n"
			);
		}

		/// One more unchanged line and they split.
		///
		/// The boundary itself: at seven lines the two contexts no longer meet,
		/// so GNU prints two hunks and trims each to three lines. Asserting the
		/// split as well as the join is what pins the threshold to a value
		/// rather than to an inequality that happens to hold.
		#[test]
		fn two_real_changes_split_one_line_further_apart() {
			let old = format!("A\n{}B\n", gap(7));
			let new = format!("a\n{}b\n", gap(7));

			assert_eq!(
				hunks(&old, &new, 3, Ignore::default()),
				"@@ -1,4 +1,4 @@\n-A\n+a\n L1\n L2\n L3\n@@ -6,4 +6,4 @@\n L5\n L6\n L7\n-B\n+b\n"
			);
		}

		/// A real change followed by a blank-only one joins across `context - 1`
		/// lines, and the blank lines are then printed.
		///
		/// The shortened distance in the direction that has it. Two unchanged
		/// lines at `context` 3 still join, so the deleted blanks appear in a
		/// hunk they would never start on their own.
		#[test]
		fn an_ignorable_change_two_lines_away_is_printed_inside_the_hunk() {
			let ig = Ignore { blank_lines: true, ..Ignore::default() };
			let old = format!("{}\n\n", gap(2));
			let new = format!("X\n{}", gap(2));

			assert_eq!(hunks(&old, &new, 3, ig), "@@ -1,4 +1,3 @@\n+X\n L1\n L2\n-\n-\n");
		}

		/// One more line and the blank-only change becomes its own hunk, which is
		/// dropped: the deleted blanks vanish and the hunk SHRINKS around them.
		///
		/// This is the case the old hunk-level filter got wrong. It merged the
		/// two changes at this distance and printed the blanks; GNU counts
		/// three of the five old lines and prints neither. The old range in the
		/// header is the proof, since a filter that merely skipped the lines
		/// would still say `-1,5`.
		#[test]
		fn an_ignorable_change_three_lines_away_becomes_its_own_dropped_hunk() {
			let ig = Ignore { blank_lines: true, ..Ignore::default() };
			let old = format!("{}\n\n", gap(3));
			let new = format!("X\n{}", gap(3));

			assert_eq!(hunks(&old, &new, 3, ig), "@@ -1,3 +1,4 @@\n+X\n L1\n L2\n L3\n");
		}

		/// The other direction keeps the FULL distance, which is the asymmetry.
		///
		/// A blank-only change followed by a real one joins across six unchanged
		/// lines at `context` 3, where the reverse order split at three. The
		/// threshold reads the ignorability of the change it is about to reach
		/// and nothing else, and this is the case that rules out "either change
		/// is ignorable" as the rule.
		#[test]
		fn an_ignorable_change_before_a_real_one_joins_across_twice_the_context() {
			let ig = Ignore { blank_lines: true, ..Ignore::default() };
			let old = format!("\n\n{}", gap(6));
			let new = format!("{}X\n", gap(6));

			assert_eq!(
				hunks(&old, &new, 3, ig),
				"@@ -1,8 +1,7 @@\n-\n-\n L1\n L2\n L3\n L4\n L5\n L6\n+X\n"
			);
		}

		/// And splits at seven, where the leading blank-only hunk is dropped.
		///
		/// The far end of the same direction. Only the real hunk survives, and it
		/// keeps the line numbers it had before the other hunk was dropped:
		/// dropping a hunk does not renumber the file.
		#[test]
		fn an_ignorable_change_seven_lines_before_a_real_one_is_dropped() {
			let ig = Ignore { blank_lines: true, ..Ignore::default() };
			let old = format!("\n\n{}", gap(7));
			let new = format!("{}X\n", gap(7));

			assert_eq!(hunks(&old, &new, 3, ig), "@@ -7,3 +5,4 @@\n L5\n L6\n L7\n+X\n");
		}

		/// The threshold scales with the context size, in both directions.
		///
		/// At `context` 1 the two distances are 1 and 3, so a real change splits
		/// from a blank-only one at a single unchanged line while the reverse
		/// order still joins across two. A threshold hardcoded to a context of
		/// 3, or one that ignored the context entirely, passes every case above
		/// and fails here.
		#[test]
		fn the_two_thresholds_follow_the_context_size() {
			let ig = Ignore { blank_lines: true, ..Ignore::default() };

			let old = format!("{}\n\n", gap(1));
			let new = format!("X\n{}", gap(1));
			assert_eq!(
				hunks(&old, &new, 1, ig),
				"@@ -1 +1,2 @@\n+X\n L1\n",
				"one line is already too far when the next change is ignorable"
			);

			let old = format!("\n\n{}", gap(2));
			let new = format!("{}X\n", gap(2));
			assert_eq!(
				hunks(&old, &new, 1, ig),
				"@@ -1,4 +1,3 @@\n-\n-\n L1\n L2\n+X\n",
				"two lines still join in the other direction"
			);

			let old = format!("\n\n{}", gap(3));
			let new = format!("{}X\n", gap(3));
			assert_eq!(hunks(&old, &new, 1, ig), "@@ -5 +3,2 @@\n L3\n+X\n", "and three do not");
		}

		/// A change in the middle of a long file carries exactly `context` lines
		/// on each side.
		///
		/// The leading and trailing trim, which moved into this crate with the
		/// grouper. Nine unchanged lines precede the change and ten follow it,
		/// and three of each are printed.
		#[test]
		fn a_change_in_a_long_file_carries_exactly_the_context_lines() {
			let old = numbered_lines("f", 20);
			let new = old.replace("f10\n", "TEN\n");

			assert_eq!(
				hunks(&old, &new, 3, Ignore::default()),
				"@@ -7,7 +7,7 @@\n f7\n f8\n f9\n-f10\n+TEN\n f11\n f12\n f13\n"
			);
		}

		/// An unchanged run shorter than the context is printed whole, once.
		///
		/// The trim takes at most `context` lines, not exactly `context`, and the
		/// single line between two changes must not be printed twice: a grouper
		/// that emitted the trailing context of one change and then the leading
		/// context of the next would duplicate it.
		#[test]
		fn a_gap_shorter_than_the_context_is_printed_once() {
			assert_eq!(
				hunks("a\nX\nb\nY\nc\n", "a\nx\nb\ny\nc\n", 3, Ignore::default()),
				"@@ -1,5 +1,5 @@\n a\n-X\n+x\n b\n-Y\n+y\n c\n"
			);
		}

		/// With `-B` off, no change is ignorable and the short threshold never
		/// applies.
		///
		/// NON-VACUITY for the whole suite in the other direction: the same pair
		/// that loses its blanks under `-B` keeps them without it, joined across
		/// three unchanged lines by the ordinary distance. If the grouper read
		/// the blankness of a line rather than the flag, this would fail.
		#[test]
		fn without_the_flag_a_blank_change_groups_like_any_other() {
			let old = format!("{}\n\n", gap(3));
			let new = format!("X\n{}", gap(3));

			assert_eq!(
				hunks(&old, &new, 3, Ignore::default()),
				"@@ -1,5 +1,4 @@\n+X\n L1\n L2\n L3\n-\n-\n"
			);
		}
	}

	/// Equality under a key transform, which is what `-q` and `-s` report and
	/// what the exit code is.
	mod a_transform_can_make_two_files_equal {
		use super::*;

		fn differs(old: &str, new: &str, ig: Ignore) -> bool {
			Unified::compute(old, new, 3, ig).differs()
		}

		/// Trailing whitespace under `-w`, `-b` and `-Z` alike.
		#[test]
		fn trailing_whitespace_stops_being_a_difference() {
			for ig in [
				Ignore { all_space: true, ..Ignore::default() },
				Ignore { space_change: true, ..Ignore::default() },
				Ignore { trailing_space: true, ..Ignore::default() },
			] {
				assert!(!differs("trail \nsame\n", "trail\nsame\n", ig), "{ig:?}");
			}
			assert!(differs("trail \nsame\n", "trail\nsame\n", Ignore::default()));
		}

		/// `-b` and `-w` disagree about a space appearing from nothing, which is
		/// the single case that tells them apart.
		#[test]
		fn only_all_space_hides_a_space_that_was_not_there() {
			let b = Ignore { space_change: true, ..Ignore::default() };
			let w = Ignore { all_space: true, ..Ignore::default() };
			assert!(differs("ab\n", "a b\n", b), "-b keeps a run that appeared");
			assert!(!differs("ab\n", "a b\n", w));
			assert!(!differs("a  b\n", "a b\n", b), "-b still hides a run that grew");
		}

		/// An unterminated last line equals a terminated one under the whitespace
		/// flags, and does not under none of them.
		#[test]
		fn a_missing_final_newline_is_a_whitespace_difference() {
			let z = Ignore { trailing_space: true, ..Ignore::default() };
			assert!(!differs("a\nb", "a\nb\n", z));
			assert!(differs("a\nb", "a\nb\n", Ignore::default()));
		}

		/// A context line prints the LEFT file's original bytes even when the key
		/// that matched it came from a transform. This is the property that makes
		/// the whole design worth it: `-w` changes equality, never output.
		#[test]
		fn a_context_line_keeps_the_bytes_it_was_read_with() {
			let ig = Ignore { all_space: true, ..Ignore::default() };
			let unified = Unified::compute("trail \nx\nchanged\n", "trail\nx\nother\n", 3, ig);
			let mut out = Vec::new();
			unified.write(&mut out, "a", "b").unwrap();

			assert_eq!(
				String::from_utf8(out).unwrap(),
				"--- a\n+++ b\n@@ -1,3 +1,3 @@\n trail \n x\n-changed\n+other\n",
				"the context line carries its trailing space"
			);
		}
	}

	/// The binary sniff window, which used to be a different number in each of
	/// the two crates that asked the question.
	mod a_nul_within_the_window_means_binary {
		use super::*;

		/// Both sides of the boundary GNU diff 3.10 draws.
		#[test]
		fn the_window_ends_at_four_kilobytes() {
			let mut inside = vec![b'x'; BINARY_SNIFF_WINDOW - 1];
			inside.push(0);
			inside.extend(std::iter::repeat_n(b'x', 10_000));
			assert!(looks_binary(&inside), "a NUL at 4095 is inside the window");

			let mut outside = vec![b'x'; BINARY_SNIFF_WINDOW];
			outside.push(0);
			outside.extend(std::iter::repeat_n(b'x', 10_000));
			assert!(!looks_binary(&outside), "a NUL at 4096 is outside it");
		}

		/// The window is 4 KiB and not 8, asserted on the value so a silent
		/// widening back to the old number fails here and not only in a
		/// consumer.
		#[test]
		fn the_window_is_four_kilobytes_and_not_eight() {
			assert_eq!(BINARY_SNIFF_WINDOW, 4096);
		}

		/// The ordinary cases, so the boundary test is not the only thing holding
		/// the sniff up.
		#[test]
		fn a_nul_near_the_start_is_binary_and_text_is_not() {
			assert!(looks_binary(b"\0"));
			assert!(looks_binary(b"ELF\0\0\0"));
			assert!(!looks_binary(b"fn main() {}\n"));
			assert!(!looks_binary(b""), "an empty file is text");
			assert!(!looks_binary("line\n".repeat(20_000).as_bytes()), "size is not the signal");
		}
	}
	/// Structural locks: nobody grows a second owner.
	///
	/// WHY THIS SUITE EXISTS. The two consumers each had their own copy of this
	/// code and the copies HAD ALREADY DRIFTED, in both directions that matter:
	/// they split lines differently, so the same file was one line to one and
	/// two to the other, and they disagreed about the NUL window, so a file
	/// with a NUL 5 KiB in got a patch from one and a refusal from the other.
	/// Nothing failed when that happened. These cases fail.
	///
	/// Every rule is a needle assembled from pieces, because this file would
	/// otherwise contain every string it looks for and match itself. A detector
	/// that quietly stops finding the real thing is worse than no detector.
	mod one_owner_for_the_unified_body {
		use std::path::{Path, PathBuf};

		/// The `crates` directory of this workspace, found from this crate's own
		/// manifest path rather than the process working directory, which differs
		/// between `cargo test` and a test binary run by hand.
		fn crates_dir() -> PathBuf {
			Path::new(env!("CARGO_MANIFEST_DIR"))
				.parent()
				.expect("the kernel crate sits inside crates/")
				.to_path_buf()
		}

		/// Every first-party `.rs` file, as (workspace-relative path, contents).
		///
		/// `vendor` is excluded because it holds upstream code this workspace
		/// does not own, and `target` because it holds generated output.
		fn first_party_sources() -> Vec<(String, String)> {
			let root = crates_dir();
			let mut found = Vec::new();
			let mut stack = vec![root.clone()];
			while let Some(dir) = stack.pop() {
				let entries = std::fs::read_dir(&dir).expect("crates/ is readable");
				for entry in entries {
					let entry = entry.expect("a readable directory entry");
					let path = entry.path();
					let name = entry.file_name().to_string_lossy().to_string();
					if path.is_dir() {
						if name != "vendor" && name != "target" {
							stack.push(path);
						}
						continue;
					}
					if path.extension().is_some_and(|ext| ext == "rs") {
						let rel = path
							.strip_prefix(&root)
							.unwrap_or(&path)
							.to_string_lossy()
							.replace('\\', "/");
						found.push((rel, std::fs::read_to_string(&path).expect("a readable source")));
					}
				}
			}
			found.sort();
			found
		}

		/// Files that contain `needle`, by workspace-relative path.
		fn files_containing(needle: &str) -> Vec<String> {
			first_party_sources()
				.into_iter()
				.filter(|(_, body)| body.contains(needle))
				.map(|(path, _)| path)
				.collect()
		}

		/// The scan reaches real code. Every negative rule below would pass on an
		/// empty file list, so this is the case that keeps them meaningful.
		#[test]
		fn the_scan_reads_the_whole_workspace() {
			let sources = first_party_sources();
			assert!(sources.len() > 40, "only {} sources found", sources.len());
			for expected in
				["veyyon-diff-kernel/src/lib.rs", "veyyon-uu-diff/src/lib.rs", "veyyon-iso/src/diff.rs"]
			{
				assert!(sources.iter().any(|(path, _)| path == expected), "the scan missed {expected}");
			}
			assert!(
				sources.iter().all(|(path, _)| !path.starts_with("vendor/")),
				"vendored code is not ours to police"
			);
		}

		/// `similar`'s own unified formatter has exactly ONE first-party caller,
		/// and it is this crate. A second caller is a second answer to "what is
		/// a line", which is the drift that was already here.
		#[test]
		fn only_this_crate_asks_similar_for_a_line_diff() {
			let needle = format!("TextDiff::{}", "from_lines");
			assert_eq!(
				files_containing(&needle),
				vec!["veyyon-diff-kernel/src/lib.rs".to_string()],
				"a second caller of similar's line differ appeared"
			);
		}

		/// The line splitter has one definition. Two would be two answers about
		/// the lone `\r` that started this.
		#[test]
		fn the_line_splitter_has_one_definition() {
			let needle = format!("fn split_{}(text: &str)", "lines");
			assert_eq!(files_containing(&needle), vec!["veyyon-diff-kernel/src/lib.rs".to_string()]);
		}

		/// So does the binary sniff, and so does its window. This is the pair
		/// that was corrected in one crate and left wrong in the other.
		#[test]
		fn the_binary_sniff_and_its_window_have_one_definition_each() {
			let sniff = format!("fn looks_{}(bytes: &[u8])", "binary");
			assert_eq!(files_containing(&sniff), vec!["veyyon-diff-kernel/src/lib.rs".to_string()]);

			let window = format!("const BINARY_{}: usize", "SNIFF_WINDOW");
			assert_eq!(files_containing(&window), vec!["veyyon-diff-kernel/src/lib.rs".to_string()]);
		}

		/// The old window is gone from every first-party source. `8192` is the
		/// value both copies used, and it is specific enough that a match is a
		/// regression rather than a coincidence.
		#[test]
		fn the_old_eight_kilobyte_window_is_gone() {
			let old = format!("take({}192)", 8);
			assert!(
				files_containing(&old).is_empty(),
				"the old sniff window came back in {:?}",
				files_containing(&old)
			);
		}

		/// BOTH consumers really import the owner. Every rule above is satisfied
		/// by deleting a call site, so this is the case that proves the code is
		/// still wired rather than merely absent.
		#[test]
		fn both_consumers_import_the_owner() {
			let importers = files_containing("veyyon_diff_kernel::");
			for expected in ["veyyon-iso/src/diff.rs", "veyyon-uu-diff/src/lib.rs"] {
				assert!(
					importers.iter().any(|path| path == expected),
					"{expected} no longer imports the owner; importers were {importers:?}"
				);
			}
		}
	}

	/// The normalization that decides WHERE a change group sits when several
	/// placements cost the same.
	///
	/// GNU diff does not print whatever its sequence comparison happened to
	/// return. It runs `shift_boundaries` first, which slides each run of
	/// changed lines as far as it will go, so two implementations that pick
	/// different equal-cost alignments still print the same hunks. Without it
	/// our hunks disagreed with GNU's on 33 of the 464 measured cases; with it,
	/// on 16, and the residual is which of two identical lines the sequence
	/// comparison matched rather than where a run sits. The rules are tested on
	/// the flag arrays directly, because that is the representation the
	/// algorithm is defined on and a printed hunk hides which line carried the
	/// flag.
	/// Flags from a mask of `.` for unchanged and `X` for changed.
	///
	/// Every alignment case here is written as a mask, because a printed hunk
	/// hides WHICH line carried the flag and that is the whole subject.
	fn flags(mask: &str) -> Vec<bool> {
		mask.chars().map(|c| c == 'X').collect()
	}

	/// A mask again, so a failure prints the shape rather than a list of
	/// booleans.
	fn mask(flags: &[bool]) -> String {
		flags.iter().map(|&f| if f { 'X' } else { '.' }).collect()
	}

	/// The lines GNU removes before it compares anything.
	///
	/// WHY THIS SUITE EXISTS. `discard_unmatched` looks like an optimization and
	/// is not one: a line with no counterpart in the other file cannot be part
	/// of any common subsequence, so dropping it cannot change the COST, but it
	/// changes which lines the search sees as adjacent and therefore which of
	/// two identical lines ends up as the unchanged one. That is the whole
	/// remaining difference between this crate and GNU on ten of the 784
	/// differential cases, and a normalization pass invented to paper over it
	/// (`pull_unchanged_lines_back`) closed those ten and opened twenty-nine
	/// others. The suite pins both halves: that the reduction is cost-neutral,
	/// and that the pairing it produces is GNU's.
	mod lines_with_no_counterpart_are_discarded_before_the_search {
		use super::*;

		/// The reduced classes and the real line each one came from.
		fn reduce(mine: &[&str], theirs: &[&str]) -> (Vec<usize>, Vec<usize>) {
			let mine_keys: Vec<Cow<'_, str>> = mine.iter().map(|line| Cow::Borrowed(*line)).collect();
			let theirs_keys: Vec<Cow<'_, str>> =
				theirs.iter().map(|line| Cow::Borrowed(*line)).collect();
			let (mine_equivs, theirs_equivs) = equivalence_classes(&mine_keys, &theirs_keys);
			let classes = mine_equivs.len() + theirs_equivs.len();
			discard_unmatched(&mine_equivs, &theirs_equivs, classes)
		}

		/// Only the lines that occur in the other file survive, and each one
		/// remembers its real line number.
		///
		/// The whole contract in one case: `A`, the blank and `Z` occur nowhere
		/// in `c`, so the reduced sequence is the two `c` lines at real lines 1
		/// and 3. The line numbers matter as much as the classes, because the
		/// flags are spread back over them.
		#[test]
		fn a_line_missing_from_the_other_file_is_dropped_with_its_index() {
			let (kept, lines) = reduce(&["A", "c", "", "c", "Z"], &["c"]);

			assert_eq!(lines, vec![1, 3], "the two `c` lines and nothing else");
			assert_eq!(kept.len(), 2);
			assert_eq!(kept[0], kept[1], "both are the same equivalence class");
		}

		/// Nothing is dropped when every line occurs on both sides.
		///
		/// NON-VACUITY: a pass that dropped too eagerly would still pass the case
		/// above. Here the two files share every line, in a different order, and
		/// the reduction has to be the identity.
		#[test]
		fn a_shared_line_is_never_dropped_however_it_moved() {
			let (kept, lines) = reduce(&["a", "b", "c"], &["c", "b", "a"]);

			assert_eq!(lines, vec![0, 1, 2]);
			assert_eq!(kept.len(), 3);
		}

		/// Every line goes when the other file is empty.
		///
		/// The boundary the caller depends on: with nothing to match, the reduced
		/// sequence is empty and `restore_discarded` marks the whole side
		/// changed, which is exactly the answer for a file that was created or
		/// deleted.
		#[test]
		fn an_empty_other_file_discards_everything() {
			let (kept, lines) = reduce(&["a", "b"], &[]);

			assert!(kept.is_empty() && lines.is_empty());
			assert_eq!(restore_discarded(&[], &[], 2), vec![true, true]);
		}

		/// The flags come back on the REAL line numbers, with every discarded
		/// line changed.
		///
		/// The inverse half of the pass, asserted on its own because a mistake
		/// here is a silently misplaced hunk rather than a crash: two of five
		/// lines survived, the search called the first of them unchanged, and
		/// the three discarded lines are changed by definition.
		#[test]
		fn the_discarded_lines_come_back_changed() {
			let flags = restore_discarded(&[false, true], &[1, 3], 5);

			assert_eq!(flags, vec![true, false, true, true, true]);
		}

		/// The reduction does not change the COST of the alignment.
		///
		/// The property that makes this pass legitimate rather than a heuristic,
		/// checked against `similar`'s independent Myers over the whole shape
		/// family: the number of changed lines has to be the optimum on the FULL
		/// sequences, even though the search ran on shorter ones.
		#[test]
		fn discarding_never_changes_the_number_of_changed_lines() {
			for (old, new) in [
				(vec!["c "], vec!["A", "c ", "", "c ", "A"]),
				(vec!["a", "b", "c"], vec!["x", "a", "y", "b", "z", "c"]),
				(vec!["", "", "b"], vec!["b", "b", "a", "A", "", "A"]),
				(vec!["a", "a", "a"], vec!["q", "a", "q", "a", "q"]),
				(vec!["one", "two"], vec!["three", "four"]),
			] {
				let old_keys: Vec<Cow<'_, str>> = old.iter().map(|line| Cow::Borrowed(*line)).collect();
				let new_keys: Vec<Cow<'_, str>> = new.iter().map(|line| Cow::Borrowed(*line)).collect();
				let ours: usize = aligned_ops(&old_keys, &new_keys)
					.iter()
					.map(|op| {
						let (tag, old_range, new_range) = op.as_tag_tuple();
						if matches!(tag, DiffTag::Equal) {
							0
						} else {
							old_range.len() + new_range.len()
						}
					})
					.sum();
				let reference: usize =
					similar::capture_diff_slices(similar::Algorithm::Myers, &old_keys, &new_keys)
						.iter()
						.map(|op| {
							let (tag, old_range, new_range) = op.as_tag_tuple();
							if matches!(tag, DiffTag::Equal) {
								0
							} else {
								old_range.len() + new_range.len()
							}
						})
						.sum();

				assert_eq!(ours, reference, "{old:?} -> {new:?} must still cost {reference}");
			}
		}

		/// The visible outcome: the FIRST of two identical lines is the context
		/// line, which is what GNU prints.
		///
		/// The case the pass exists for, end to end. `c \n` against
		/// `A\nc \n\nc \nA\n` reduces to the two `c ` lines, so the head slide
		/// inside `compareseq` pairs the old line with the first of them. These
		/// are GNU diff 3.10's exact bytes, and without the pass we kept the
		/// SECOND copy and printed `+A +c  +` before the context line.
		#[test]
		fn the_context_line_is_the_first_of_the_identical_copies() {
			let mut out = Vec::new();
			Unified::compute("c \n", "A\nc \n\nc \nA\n", 3, Ignore::default())
				.write(&mut out, "A", "B")
				.expect("writing to a Vec cannot fail");

			assert_eq!(
				String::from_utf8(out).expect("the fixture is UTF-8"),
				"--- A\n+++ B\n@@ -1 +1,5 @@\n+A\n c \n+\n+c \n+A\n"
			);
		}
	}

	/// GNU's own sequence comparison, in place of a library Myers.
	///
	/// WHY THIS SUITE EXISTS. `compareseq` replaced `similar`'s Myers because
	/// the last 8 of 464 measured GNU cases could not be reached any other way:
	/// where two alignments cost the same they can pair the unchanged lines
	/// with DIFFERENT lines, and no rule applied to the flags afterwards turns
	/// one pairing into the other. Swapping the comparison engine is the kind
	/// of change that can be right on the eight cases that motivated it and
	/// wrong on the other 456, so this suite pins two separate things: that the
	/// script is still MINIMAL, which is the property a comparison engine owes
	/// its caller, and that the specific tie preferences are GNU's.
	mod the_alignment_is_gnus_own_bidirectional_search {
		use super::*;

		/// Turn a string of lines into equivalence classes the way `aligned_ops`
		/// does, so a case here runs the same numbers the shipped path runs.
		fn classes_of(old: &[&str], new: &[&str]) -> (Vec<usize>, Vec<usize>) {
			let old_keys: Vec<Cow<'_, str>> = old.iter().map(|line| Cow::Borrowed(*line)).collect();
			let new_keys: Vec<Cow<'_, str>> = new.iter().map(|line| Cow::Borrowed(*line)).collect();
			equivalence_classes(&old_keys, &new_keys)
		}

		/// The changed flags for a pair, as two `X`/`.` masks.
		fn compare(old: &[&str], new: &[&str]) -> (String, String) {
			let (old_equivs, new_equivs) = classes_of(old, new);
			let (old_changed, new_changed) = compareseq(&old_equivs, &new_equivs);
			(mask(&old_changed), mask(&new_changed))
		}

		/// The script is MINIMAL, checked against an independent Myers.
		///
		/// The one property that matters most and the one a hand-ported algorithm
		/// is most likely to lose: an off-by-one in the diagonal bookkeeping can
		/// still produce a valid script, just a longer one, and every hunk would
		/// then be bigger than GNU's without any single case looking wrong.
		/// `similar`'s Myers is an independent implementation of the same
		/// optimum, so the number of changed lines has to agree exactly, pair
		/// by pair.
		#[test]
		fn the_script_is_as_short_as_an_independent_myers_finds() {
			for (old, new) in [
				(vec!["a"], vec!["a"]),
				(vec!["a", "b"], vec!["b", "a"]),
				(vec!["a", "b", "c"], vec!["c", "b", "a"]),
				(vec![""], vec!["a", "", "b", "", "c"]),
				(vec!["", "", "b"], vec!["b", "b", "a", "A", "", "A"]),
				(vec!["c "], vec!["A", "c ", "", "c ", "A"]),
				(vec!["a", "b", "c", "d", "e"], vec!["a", "c", "e"]),
				(vec!["a", "c", "e"], vec!["a", "b", "c", "d", "e"]),
				(vec!["x"; 6], vec!["x", "y", "x", "y", "x", "y"]),
				(vec!["a", "a", "a", "b"], vec!["b", "a", "a", "a"]),
				(vec![], vec!["a", "b"]),
				(vec!["a", "b"], vec![]),
			] {
				let (old_equivs, new_equivs) = classes_of(&old, &new);
				let (old_changed, new_changed) = compareseq(&old_equivs, &new_equivs);
				let ours = old_changed.iter().filter(|flag| **flag).count()
					+ new_changed.iter().filter(|flag| **flag).count();

				let old_keys: Vec<Cow<'_, str>> = old.iter().map(|line| Cow::Borrowed(*line)).collect();
				let new_keys: Vec<Cow<'_, str>> = new.iter().map(|line| Cow::Borrowed(*line)).collect();
				let reference: usize =
					similar::capture_diff_slices(similar::Algorithm::Myers, &old_keys, &new_keys)
						.iter()
						.map(|op| {
							let (tag, old_range, new_range) = op.as_tag_tuple();
							if matches!(tag, DiffTag::Equal) {
								0
							} else {
								old_range.len() + new_range.len()
							}
						})
						.sum();

				assert_eq!(ours, reference, "{old:?} -> {new:?} should cost {reference} changed lines");
			}
		}

		/// Identical inputs change nothing, however long they are.
		///
		/// NON-VACUITY for the whole suite, and the case the head-and-tail trim
		/// exists for: it should reduce the region to nothing before any diagonal
		/// search starts.
		#[test]
		fn identical_inputs_have_no_changed_lines() {
			let lines: Vec<String> = (0..500).map(|index| format!("line {index}")).collect();
			let refs: Vec<&str> = lines.iter().map(std::string::String::as_str).collect();

			let (old_mask, new_mask) = compare(&refs, &refs);

			assert_eq!(old_mask, ".".repeat(500));
			assert_eq!(new_mask, ".".repeat(500));
		}

		/// An empty side makes every line on the other side changed.
		///
		/// Both of `compareseq`'s simple cases, which are the ones that write
		/// flags without consulting `diag` at all.
		#[test]
		fn an_empty_side_changes_every_line_of_the_other() {
			assert_eq!(compare(&[], &["a", "b", "c"]), (String::new(), "XXX".to_string()));
			assert_eq!(compare(&["a", "b", "c"], &[]), ("XXX".to_string(), String::new()));
			assert_eq!(compare(&[], &[]), (String::new(), String::new()));
		}

		/// A common head and tail is trimmed before any search runs.
		///
		/// Asserted through the flags rather than by instrumenting the trim: the
		/// shared lines have to come out unchanged, and only the middle can move.
		#[test]
		fn a_shared_head_and_tail_stay_unchanged() {
			let (old_mask, new_mask) =
				compare(&["a", "b", "mid", "y", "z"], &["a", "b", "other", "y", "z"]);

			assert_eq!(old_mask, "..X..");
			assert_eq!(new_mask, "..X..");
		}

		/// The case that motivated the port, flag for flag.
		///
		/// `\n\nb\n` against `b\nb\na\nA\n\nA\n` costs seven changed lines either
		/// way. GNU deletes both blanks and keeps `b` as the context; `similar`
		/// keeps a BLANK as the context and deletes the `b`. This is the pairing
		/// no normalization could reach, and it is the whole reason the engine
		/// changed: all eight flag combinations of the `random-09` differential
		/// case were open before it and none are now.
		#[test]
		fn the_case_no_normalization_could_reach_pairs_the_way_gnu_pairs() {
			let (old_mask, new_mask) = compare(&["", "", "b"], &["b", "b", "a", "A", "", "A"]);

			assert_eq!(old_mask, "XX.", "both blanks are deleted and `b` is the context");
			assert_eq!(new_mask, ".XXXXX", "the context is the FIRST `b` on the new side");
		}

		/// A swapped pair reports the deletion first, which is GNU's preference.
		///
		/// Turning `a\nb\n` into `b\na\n` costs two edits either way: GNU deletes
		/// `a` and re-inserts it after `b`, and `similar` inserts `b` first and
		/// deletes it after. This preference used to be bought by computing the
		/// alignment on the SWAPPED input and mirroring every op back; the search
		/// order here gives it directly, which is why the mirror is gone.
		#[test]
		fn a_swapped_pair_deletes_before_it_inserts() {
			let (old_mask, new_mask) = compare(&["a", "b"], &["b", "a"]);

			assert_eq!(old_mask, "X.", "`a` is the line deleted");
			assert_eq!(new_mask, ".X", "and re-inserted after `b`");
		}

		/// Every line changed on both sides when nothing matches.
		///
		/// The case where the diagonal band is used at its full width, so a
		/// mistake in `dmin`/`dmax` or in the sentinel edges shows up as a panic
		/// rather than a wrong answer.
		#[test]
		fn two_files_with_nothing_in_common_change_completely() {
			let (old_mask, new_mask) = compare(&["a", "b", "c"], &["x", "y", "z", "w"]);

			assert_eq!(old_mask, "XXX");
			assert_eq!(new_mask, "XXXX");
		}

		/// A long edit script does not exhaust the process stack.
		///
		/// GNU recurses in `compareseq` and this keeps an explicit stack, which
		/// is the difference this asserts: an input whose script is as long as
		/// the input itself splits as deeply as it can, and a recursive port
		/// would be at the mercy of the thread's stack size for it.
		#[test]
		fn a_deeply_split_comparison_does_not_overflow_the_stack() {
			let old: Vec<String> = (0..4_000).map(|index| format!("old {index}")).collect();
			let new: Vec<String> = (0..4_000).map(|index| format!("new {index}")).collect();
			let old_refs: Vec<&str> = old.iter().map(std::string::String::as_str).collect();
			let new_refs: Vec<&str> = new.iter().map(std::string::String::as_str).collect();

			let (old_mask, new_mask) = compare(&old_refs, &new_refs);

			assert_eq!(old_mask.len(), 4_000);
			assert_eq!(old_mask.matches('X').count(), 4_000, "no line survives");
			assert_eq!(new_mask.matches('X').count(), 4_000);
		}

		/// The classes are shared across both sides.
		///
		/// The one thing a per-side map gets wrong, and it would be silent: every
		/// comparison in `compareseq` is a class from one side against a class
		/// from the other, so two maps numbering independently would make
		/// unrelated lines compare equal and equal lines compare different. Two
		/// files with the same lines in a different order are the shortest
		/// proof.
		#[test]
		fn one_class_map_numbers_both_sides() {
			let (old_equivs, new_equivs) = classes_of(&["a", "b"], &["b", "a", "c"]);

			assert_eq!(old_equivs, vec![0, 1], "the old side introduces `a` and `b`");
			assert_eq!(new_equivs, vec![1, 0, 2], "the new side reuses both and adds `c`");
		}
	}

	mod a_change_group_is_slid_the_way_gnu_slides_it {
		use super::*;

		/// Classes for a sequence of one-character lines, so a case reads as the
		/// text it is about.
		fn classes(lines: &str) -> Vec<usize> {
			let keys: Vec<Cow<'_, str>> = lines.chars().map(|c| Cow::Owned(c.to_string())).collect();
			// One side only: `shift_one_side` compares lines within a side, so the
			// other side of the pair is empty here.
			equivalence_classes(&keys, &[]).0
		}

		/// A run slides forward while its first changed line equals the unchanged
		/// line after it.
		///
		/// Both placements cost one insertion, and GNU reports the LAST of the
		/// equal lines. This is the rule that makes two implementations agree
		/// about a duplicated line.
		#[test]
		fn a_run_slides_forward_onto_an_equal_neighbour() {
			let mut changed = flags("X.");
			shift_one_side(&mut changed, &[], &classes("aa"));

			assert_eq!(mask(&changed), ".X", "the run should end as far forward as it can go");
		}

		/// The forward pass runs after the backward one, so a run that could sit
		/// either side of an equal line ends up forward.
		///
		/// GNU orders the two passes this way on purpose: sliding back first lets
		/// runs merge, and sliding forward second leaves an unmerged run at its
		/// furthest point. A run that started BEHIND the equal line therefore
		/// ends in the same place as one that started ahead of it, which is
		/// what makes the result canonical rather than a function of where it
		/// began.
		#[test]
		fn a_run_ends_forward_wherever_it_started() {
			let mut from_behind = flags("X.");
			let mut from_ahead = flags(".X");
			shift_one_side(&mut from_behind, &[], &classes("aa"));
			shift_one_side(&mut from_ahead, &[], &classes("aa"));

			assert_eq!(mask(&from_behind), ".X");
			assert_eq!(mask(&from_ahead), ".X");
			assert_eq!(mask(&from_behind), mask(&from_ahead), "the two starts must converge");
		}

		/// Two runs separated by an equal line merge into one.
		///
		/// Sliding the first run forward frees the line between them, the two
		/// runs become one, and the loop repeats because the run GREW. A merged
		/// run prints as one hunk where the unmerged pair prints as two, so
		/// this is the rule that decides how many hunks a reader sees.
		#[test]
		fn two_runs_around_an_equal_line_merge() {
			let mut changed = flags("X.X");
			shift_one_side(&mut changed, &[], &classes("aaa"));

			assert_eq!(mask(&changed), ".XX", "the two runs should merge and sit forward");
		}

		/// A run whose neighbours differ does not move.
		///
		/// The normalization must not invent movement: sliding a run past a line
		/// that is not equal to it would change what the diff says, not just
		/// where it says it.
		#[test]
		fn a_run_between_unequal_lines_stays_put() {
			let mut changed = flags(".X.");
			shift_one_side(&mut changed, &[], &classes("abc"));

			assert_eq!(mask(&changed), ".X.", "nothing here is equal, so nothing may move");
		}

		/// A run moves back to line up with a changed run on the other side.
		///
		/// This is `corresponding`, the third rule. Where a run could sit at
		/// several equal-cost places, GNU puts it where it FACES the other file's
		/// change, so a deletion and the insertion that replaces it print as one
		/// hunk instead of two that happen to be adjacent.
		#[test]
		fn a_run_moves_back_to_face_the_other_sides_change() {
			// This side: three equal lines, one of them changed and free to slide.
			// The other side: its change sits opposite the FIRST of them.
			let mut changed = flags("X..");
			let other_changed = flags("X..");
			shift_one_side(&mut changed, &other_changed, &classes("aaa"));

			assert_eq!(
				mask(&changed),
				"X..",
				"the run should stay where it faces the other side's change"
			);
		}

		/// Which lines of each side a list of ops calls changed.
		///
		/// The inverse of [`ops_from_changed`], and TEST-ONLY: nothing in the
		/// shipped path needs it, because `compareseq` produces the flags
		/// directly and the ops are built from them. It lives here so the
		/// round-trip property below can still be asserted without leaving an
		/// unused function in the crate.
		fn changed_flags(ops: &[DiffOp], old_len: usize, new_len: usize) -> (Vec<bool>, Vec<bool>) {
			let mut old_changed = vec![false; old_len];
			let mut new_changed = vec![false; new_len];
			for op in ops {
				let (tag, old_range, new_range) = op.as_tag_tuple();
				if matches!(tag, DiffTag::Equal) {
					continue;
				}
				for flag in &mut old_changed[old_range] {
					*flag = true;
				}
				for flag in &mut new_changed[new_range] {
					*flag = true;
				}
			}
			(old_changed, new_changed)
		}

		/// Flags are exactly the ops' non-equal ranges.
		///
		/// The two representations have to agree or the normalization would be
		/// applied to a shape the printer never had.
		#[test]
		fn the_flags_cover_exactly_the_changed_ranges() {
			let old: Vec<Cow<'_, str>> = ["a", "b", "c"].map(Cow::Borrowed).into();
			let new: Vec<Cow<'_, str>> = ["a", "x", "y", "c"].map(Cow::Borrowed).into();
			let ops = similar::capture_diff_slices(similar::Algorithm::Myers, &old, &new);

			let (old_changed, new_changed) = changed_flags(&ops, old.len(), new.len());

			assert_eq!(mask(&old_changed), ".X.", "only `b` changed on the old side");
			assert_eq!(mask(&new_changed), ".XX.", "`x` and `y` changed on the new side");
		}

		/// Ops rebuilt from flags carry the same flags again.
		///
		/// `ops_from_changed` is the inverse of `changed_flags`, and a round trip
		/// that lost a flag would silently drop a line from a hunk. Every shape
		/// that matters is checked: a pure deletion, a pure insertion, a
		/// replacement, two runs with context between them, a run that moved, and
		/// both ends of the file.
		///
		/// Each pair leaves the same number of unchanged lines on both sides,
		/// which is not a detail of the test: unchanged lines are PAIRS, so a
		/// flag pair with different counts describes no alignment at all and
		/// the rebuild has nothing to return for it.
		#[test]
		fn flags_survive_a_round_trip_through_the_ops() {
			for (old_mask, new_mask) in [
				("X..", ".."),
				("..", "X.."),
				("X..", "X.."),
				(".X.X.", ".X.X."),
				("XX.", ".XX"),
				("...", "..."),
				("X", "X"),
				("", "X"),
				("X", ""),
			] {
				let old_changed = flags(old_mask);
				let new_changed = flags(new_mask);

				let ops = ops_from_changed(&old_changed, &new_changed);
				let (round_old, round_new) = changed_flags(&ops, old_changed.len(), new_changed.len());

				assert_eq!(mask(&round_old), old_mask, "old side of {old_mask}/{new_mask}");
				assert_eq!(mask(&round_new), new_mask, "new side of {old_mask}/{new_mask}");
			}
		}

		/// The rebuilt ops are the ones the printer expects, op for op.
		///
		/// A round trip through the flags would also survive a rebuild that split
		/// one replacement into a deletion and an insertion, and the printer
		/// would then emit two hunk bodies where GNU emits one. This asserts
		/// the ops themselves for the three shapes.
		#[test]
		fn the_rebuilt_ops_name_the_shape_of_each_change() {
			assert_eq!(ops_from_changed(&flags("X.."), &flags("..")), vec![
				DiffOp::Delete { old_index: 0, old_len: 1, new_index: 0 },
				DiffOp::Equal { old_index: 1, new_index: 0, len: 2 },
			]);
			assert_eq!(ops_from_changed(&flags(".."), &flags("X..")), vec![
				DiffOp::Insert { old_index: 0, new_index: 0, new_len: 1 },
				DiffOp::Equal { old_index: 0, new_index: 1, len: 2 },
			]);
			// Changed lines on BOTH sides at the same position are one replacement,
			// not a deletion beside an insertion: the printer writes one hunk body
			// for it, as GNU does.
			assert_eq!(ops_from_changed(&flags("XX."), &flags("XX.")), vec![
				DiffOp::Replace { old_index: 0, old_len: 2, new_index: 0, new_len: 2 },
				DiffOp::Equal { old_index: 2, new_index: 2, len: 1 },
			]);
			// A run that moved: the deletion faces nothing, the equal line pairs
			// across a shifted position, and the insertion lands at the end.
			assert_eq!(ops_from_changed(&flags("XX."), &flags(".XX")), vec![
				DiffOp::Delete { old_index: 0, old_len: 2, new_index: 0 },
				DiffOp::Equal { old_index: 2, new_index: 0, len: 1 },
				DiffOp::Insert { old_index: 3, new_index: 1, new_len: 2 },
			]);
		}

		/// Equal keys share a class and different keys do not.
		///
		/// The whole algorithm asks "is this line the same as that one" through
		/// these numbers, so a class that collided would slide a run past a line
		/// it does not match.
		#[test]
		fn equal_keys_share_a_class_and_others_do_not() {
			let keys: Vec<Cow<'_, str>> = ["a", "b", "a", "c", "b"].map(Cow::Borrowed).into();
			let other: Vec<Cow<'_, str>> = ["c", "a", "d"].map(Cow::Borrowed).into();

			let (ids, other_ids) = equivalence_classes(&keys, &other);

			assert_eq!(ids[0], ids[2], "both `a` lines share a class");
			assert_eq!(ids[1], ids[4], "both `b` lines share a class");
			assert_ne!(ids[0], ids[1], "`a` and `b` must not collide");
			assert_ne!(ids[0], ids[3], "`a` and `c` must not collide");
			assert_eq!(ids.len(), keys.len(), "one class per line");
			// The map is SHARED, which is what `compareseq` needs: it compares a
			// class from one side against a class from the other, so a per-side map
			// would make unrelated lines compare equal.
			assert_eq!(other_ids[0], ids[3], "`c` has the class the old side gave it");
			assert_eq!(other_ids[1], ids[0], "and so does `a`");
			assert!(
				!ids.contains(&other_ids[2]),
				"`d` is new, so its class is one the old side never used"
			);
		}

		/// A line that moved reads as a deletion first, which is GNU's answer.
		///
		/// `similar` reports the insertion first, so this is the visible end of
		/// the whole normalization: the hunk names the earliest line at which
		/// the two files stop agreeing.
		#[test]
		fn a_moved_line_is_reported_as_a_deletion_first() {
			let mut out = Vec::new();
			Unified::compute("a\nb\nc\n", "b\nc\na\n", 3, Ignore::default())
				.write(&mut out, "A", "B")
				.expect("writing to a Vec cannot fail");

			assert_eq!(
				String::from_utf8(out).expect("the fixture is UTF-8"),
				"--- A\n+++ B\n@@ -1,3 +1,3 @@\n-a\n b\n c\n+a\n"
			);
		}

		/// A blank line that moved past a real one changes the BLANKS.
		///
		/// This is the case `diff -B` depends on: GNU marks the blank lines, so
		/// ignoring blank lines makes the two files identical, and an alignment
		/// that marked the real line instead would report a difference GNU does
		/// not.
		#[test]
		fn a_blank_that_moved_marks_the_blank_and_not_the_line() {
			let mut out = Vec::new();
			Unified::compute("\nx\n", "x\n\n", 3, Ignore::default())
				.write(&mut out, "A", "B")
				.expect("writing to a Vec cannot fail");

			assert_eq!(
				String::from_utf8(out).expect("the fixture is UTF-8"),
				"--- A\n+++ B\n@@ -1,2 +1,2 @@\n-\n x\n+\n"
			);

			let ignoring_blanks = Unified::compute("\nx\n", "x\n\n", 3, Ignore {
				blank_lines: true,
				..Ignore::default()
			});

			assert!(
				!ignoring_blanks.differs(),
				"with -B the two files are identical, which only holds if the blanks carried the \
				 change"
			);
		}
	}
}
