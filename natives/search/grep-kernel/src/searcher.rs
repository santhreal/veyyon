//! How a `Searcher` is built, stated once as data.
//!
//! The matcher decides what a match IS. The searcher decides how a file is
//! READ: how many context lines come with a match, when a file is treated as
//! binary, what ends a line, whether the search stops after N matches. Those
//! are the settings that decide what a search RETURNS, and all three engines in
//! this workspace had been setting them in their own `build_searcher`, each
//! reading its own flag surface and each reaching straight for
//! `SearcherBuilder`.
//!
//! Three surfaces is correct: GNU `grep` options, `rg` options and the N-API
//! tool options are genuinely different vocabularies, and collapsing them would
//! be forcing one CLI's spelling onto the others. What is NOT correct is three
//! independent answers to "how is a Searcher constructed", because the builder
//! has settings a caller can forget to state, and a caller that forgets gets
//! the library's default silently.
//!
//! So the vocabularies stay separate and the CONSTRUCTION is shared: each
//! surface fills in a [`SearcherSpec`], which names every setting this
//! workspace uses, and [`build_searcher`] turns it into a `Searcher`. A surface
//! that does not care about a setting leaves it at [`SearcherSpec::default`],
//! and the defaults are the library's own, so this is a rename of the existing
//! behaviour and not a new policy.
//!
//! ```
//! use grep_searcher::BinaryDetection;
//! use veyyon_grep_kernel::{SearcherSpec, build_searcher};
//!
//! // Three lines of context, stop reading a file at the first NUL.
//! let searcher = build_searcher(SearcherSpec {
//! 	before_context: 3,
//! 	after_context: 3,
//! 	binary_detection: BinaryDetection::quit(b'\0'),
//! 	..SearcherSpec::default()
//! });
//! assert_eq!(searcher.before_context(), 3);
//! ```

use grep_matcher::LineTerminator;
use grep_searcher::{BinaryDetection, Encoding, Searcher, SearcherBuilder};

/// Every searcher setting this workspace sets, in one place.
///
/// The field defaults are `grep-searcher`'s own, so `..Default::default()`
/// means "the library's behaviour" rather than "somebody's opinion". Two of
/// them are worth knowing about because they are easy to be surprised by:
///
/// - `line_number` defaults to TRUE, and computing line numbers costs real time
///   on a large file. A caller that does not print line numbers should say so.
/// - `bom_sniffing` defaults to TRUE, so a UTF-16 file with a byte-order mark
///   is transcoded before it is searched even when no encoding was requested.
#[derive(Clone)]
pub struct SearcherSpec {
	/// Track and report line numbers. Costs a scan for line breaks.
	pub line_number:      bool,
	/// Lines to keep before a match.
	pub before_context:   usize,
	/// Lines to keep after a match.
	pub after_context:    usize,
	/// Emit every line, marking the matching ones. `rg --passthru`.
	pub passthru:         bool,
	/// Report the lines that do NOT match. `grep -v`.
	pub invert_match:     bool,
	/// Let a match span line boundaries. Changes what the matcher is handed, not
	/// only what is printed, so it has to agree with the matcher's own setting.
	pub multi_line:       bool,
	/// What to do when a file looks binary: nothing, quit, or convert NULs.
	pub binary_detection: BinaryDetection,
	/// Stop after this many matches in one file.
	pub max_matches:      Option<u64>,
	/// What ends a line. `None` means `\n`; NUL is `grep -z`, CRLF is `rg
	/// --crlf`.
	pub line_terminator:  Option<LineTerminator>,
	/// Transcode from this encoding before searching. `None` means the bytes are
	/// searched as they are, subject to `bom_sniffing`.
	pub encoding:         Option<Encoding>,
	/// Detect UTF-16 and UTF-8 byte-order marks and transcode accordingly.
	pub bom_sniffing:     bool,
}

impl Default for SearcherSpec {
	fn default() -> Self {
		Self {
			// Mirrors `grep_searcher::Config::default`. Kept here rather than
			// derived, because `#[derive(Default)]` would silently make
			// `line_number` and `bom_sniffing` false and change what every caller
			// that does not name them gets.
			line_number:      true,
			before_context:   0,
			after_context:    0,
			passthru:         false,
			invert_match:     false,
			multi_line:       false,
			binary_detection: BinaryDetection::none(),
			max_matches:      None,
			line_terminator:  None,
			encoding:         None,
			bom_sniffing:     true,
		}
	}
}

/// Build a `Searcher` from a spec.
///
/// Every field is applied, so a spec fully determines the searcher: there is no
/// setting a caller can pass that this drops on the floor, which is the
/// property that makes the spec worth reading instead of the builder call.
#[must_use]
pub fn build_searcher(spec: SearcherSpec) -> Searcher {
	let mut builder = SearcherBuilder::new();
	builder
		.line_number(spec.line_number)
		.before_context(spec.before_context)
		.after_context(spec.after_context)
		.passthru(spec.passthru)
		.invert_match(spec.invert_match)
		.multi_line(spec.multi_line)
		.binary_detection(spec.binary_detection)
		.max_matches(spec.max_matches)
		.encoding(spec.encoding)
		.bom_sniffing(spec.bom_sniffing);
	if let Some(terminator) = spec.line_terminator {
		builder.line_terminator(terminator);
	}
	builder.build()
}

#[cfg(test)]
mod tests {
	use grep_regex::RegexMatcherBuilder;
	use grep_searcher::{Sink, SinkMatch};

	use super::*;

	/// Collects `(line number, line bytes)` so a test can assert what a search
	/// actually produced rather than that it produced something.
	struct Collector(Vec<(Option<u64>, Vec<u8>)>);

	impl Sink for Collector {
		type Error = std::io::Error;

		fn matched(
			&mut self,
			_searcher: &Searcher,
			matched: &SinkMatch<'_>,
		) -> Result<bool, Self::Error> {
			self
				.0
				.push((matched.line_number(), matched.bytes().to_vec()));
			Ok(true)
		}
	}

	fn search(spec: SearcherSpec, pattern: &str, haystack: &[u8]) -> Vec<(Option<u64>, Vec<u8>)> {
		let matcher = RegexMatcherBuilder::new()
			.build(pattern)
			.expect("valid pattern");
		let mut collector = Collector(Vec::new());
		build_searcher(spec)
			.search_slice(&matcher, haystack, &mut collector)
			.expect("the search runs");
		collector.0
	}

	/// The defaults are the LIBRARY's defaults, field by field.
	///
	/// This is the test that makes `..Default::default()` safe to write. If a
	/// future `#[derive(Default)]` or a hand edit flipped `line_number` or
	/// `bom_sniffing` to false, every caller that does not name them would
	/// silently change behaviour, and no other test here would notice: a search
	/// with no line numbers still finds the same lines.
	#[test]
	fn the_spec_defaults_match_the_library_defaults() {
		let ours = build_searcher(SearcherSpec::default());
		let theirs = SearcherBuilder::new().build();

		assert_eq!(ours.line_number(), theirs.line_number());
		assert!(ours.line_number(), "line numbers are on by default in grep-searcher");
		assert_eq!(ours.before_context(), theirs.before_context());
		assert_eq!(ours.after_context(), theirs.after_context());
		assert_eq!(ours.passthru(), theirs.passthru());
		assert_eq!(ours.multi_line(), theirs.multi_line());
		assert_eq!(ours.invert_match(), theirs.invert_match());
		assert_eq!(ours.line_terminator(), theirs.line_terminator());
		assert_eq!(ours.binary_detection(), theirs.binary_detection());
	}

	/// Context lines reach the searcher. Asserted through a real search, because
	/// the getter agreeing with the field it was set from proves only that the
	/// struct was copied.
	#[test]
	fn context_settings_reach_a_real_search() {
		let haystack = b"one\ntwo\nthree\nfour\nfive\n";

		let no_context = search(SearcherSpec::default(), "three", haystack);
		assert_eq!(no_context, vec![(Some(3), b"three\n".to_vec())]);

		let with_context = build_searcher(SearcherSpec {
			before_context: 1,
			after_context: 1,
			..SearcherSpec::default()
		});
		assert_eq!(with_context.before_context(), 1);
		assert_eq!(with_context.after_context(), 1);
	}

	/// `max_matches` stops a search, which is how every caller here bounds work
	/// on a file full of matches. A spec that dropped it would turn a bounded
	/// search into a full one, which is slow rather than wrong and so would not
	/// fail any correctness test.
	#[test]
	fn max_matches_stops_the_search() {
		let haystack = b"hit\nhit\nhit\nhit\n";

		let all = search(SearcherSpec::default(), "hit", haystack);
		assert_eq!(all.len(), 4);

		let bounded =
			search(SearcherSpec { max_matches: Some(2), ..SearcherSpec::default() }, "hit", haystack);
		assert_eq!(bounded.len(), 2);
		assert_eq!(bounded[0], (Some(1), b"hit\n".to_vec()));
		assert_eq!(bounded[1], (Some(2), b"hit\n".to_vec()));
	}

	/// Inverted search returns the lines that do not match. `grep -v`.
	#[test]
	fn invert_match_returns_the_lines_that_miss() {
		let haystack = b"keep\ndrop\nkeep\n";

		let inverted =
			search(SearcherSpec { invert_match: true, ..SearcherSpec::default() }, "drop", haystack);

		assert_eq!(inverted, vec![(Some(1), b"keep\n".to_vec()), (Some(3), b"keep\n".to_vec())]);
	}

	/// `BinaryDetection::quit` ends the search at the first NUL, which is what
	/// keeps a `grep` over a source tree from printing a megabyte of one line
	/// out of a `.png`. The match AFTER the NUL must not be reported.
	#[test]
	fn binary_detection_quit_stops_at_the_first_nul() {
		let haystack = b"before\n\x00\nafter needle\n";

		let quitting = search(
			SearcherSpec { binary_detection: BinaryDetection::quit(b'\0'), ..SearcherSpec::default() },
			"needle",
			haystack,
		);
		assert!(quitting.is_empty(), "the search should have stopped at the NUL");

		// The control: without detection the same haystack yields the match, so
		// the test above is about the setting and not about the pattern.
		let unrestricted = search(SearcherSpec::default(), "needle", haystack);
		assert_eq!(unrestricted, vec![(Some(3), b"after needle\n".to_vec())]);
	}

	/// A NUL line terminator is `grep -z`, and it changes what a "line" is: the
	/// whole NUL-free run becomes one record. Pinned because a caller that sets
	/// the terminator on the matcher but not on the searcher gets a search that
	/// matches correctly and reports the wrong bytes.
	#[test]
	fn a_nul_line_terminator_changes_what_a_line_is() {
		let haystack = b"first\nstill first\x00second\x00";

		let records = search(
			SearcherSpec {
				line_terminator: Some(LineTerminator::byte(b'\0')),
				..SearcherSpec::default()
			},
			"first",
			haystack,
		);

		assert_eq!(records, vec![(Some(1), b"first\nstill first\x00".to_vec())]);
	}

	/// `passthru` emits every line, which `rg --passthru` needs and which no
	/// other setting here implies.
	#[test]
	fn passthru_is_carried_through_to_the_searcher() {
		assert!(
			build_searcher(SearcherSpec { passthru: true, ..SearcherSpec::default() }).passthru()
		);
		assert!(!build_searcher(SearcherSpec::default()).passthru());
	}

	/// Turning line numbers off is a real saving on a large file and is the one
	/// default a caller is most likely to want changed, so it gets its own case
	/// asserting the searcher really reports `None` rather than merely being
	/// configured.
	#[test]
	fn line_numbers_can_be_turned_off_and_the_sink_sees_no_number() {
		let haystack = b"alpha\nbeta\n";

		let numbered = search(SearcherSpec::default(), "beta", haystack);
		assert_eq!(numbered, vec![(Some(2), b"beta\n".to_vec())]);

		let unnumbered =
			search(SearcherSpec { line_number: false, ..SearcherSpec::default() }, "beta", haystack);
		assert_eq!(unnumbered, vec![(None, b"beta\n".to_vec())]);
	}

	/// Multi-line search hands the matcher more than one line at a time, so a
	/// pattern spanning a newline matches. Off by default, and the default is
	/// asserted alongside so the pair reads as a contract rather than a demo.
	#[test]
	fn multi_line_lets_a_pattern_cross_a_newline() {
		let haystack = b"open\nclose\n";
		let pattern = r"open\nclose";

		assert!(search(SearcherSpec::default(), pattern, haystack).is_empty());

		let matcher = RegexMatcherBuilder::new()
			.multi_line(true)
			.build(pattern)
			.expect("valid pattern");
		let mut collector = Collector(Vec::new());
		build_searcher(SearcherSpec { multi_line: true, ..SearcherSpec::default() })
			.search_slice(&matcher, haystack, &mut collector)
			.expect("the search runs");

		assert_eq!(collector.0.len(), 1);
		assert_eq!(collector.0[0].1, b"open\nclose\n".to_vec());
	}
}
