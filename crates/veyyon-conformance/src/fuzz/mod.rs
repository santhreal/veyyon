//! Fuzz targets: the bodies a libFuzzer or AFL++ harness calls, and the
//! registry that refuses to let a raw-input surface go uncovered.
//!
//! A fuzz harness binary is three lines — take the bytes, call one function,
//! return. Those three lines need nightly and a linker flag, so they are not
//! what lives here. What lives here is the function they call: a [`Target`]
//! that feeds `&[u8]` to a real parser and reports what came back. That split
//! is deliberate, because the interesting property is checkable without a
//! fuzzer at all. Every target must terminate and must not panic on any input,
//! and [`drive`] asserts exactly that over a corpus, in-process, in a normal
//! `cargo test`.
//!
//! [`Surface`] is the list of raw-byte entry points the product has, and the
//! registry is swept against it. A surface with no target and no row in
//! [`AWAITING_MIGRATION`] makes the crate red: the alternative is a parser
//! nobody fuzzes because nobody noticed it was missing. Several surfaces are in
//! that list today for one honest reason — their parser is still TypeScript, so
//! there is nothing in this process to hand bytes to, and a Rust
//! reimplementation of it would be a fake under test rather than the product.
//!
//! # What this does not catch
//!
//! Coverage-guided exploration. The driver here runs the corpus it is given; it
//! does not mutate, instrument, or grow one, which is the fuzzer's job and the
//! reason the harness binaries exist at all. A target that hangs is caught by
//! the test timeout rather than by an internal deadline, so a hang reports as a
//! timed-out suite and not as a named finding.

#[cfg(test)]
mod tests;

use std::{
	collections::BTreeSet,
	fmt::Write as _,
	panic::{AssertUnwindSafe, catch_unwind},
};

use crate::{
	corpus::Corpus,
	generator::boundary,
	rng::Rng,
	vpty::{grid::Grid, parser::Parser},
};

/// A raw-byte entry point of the product.
///
/// "Raw" is the test: the bytes arrive from outside and nothing has validated
/// them. A struct deserialized from an already-parsed value is not a surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Surface {
	/// Escape sequences arriving from a terminal or written by a component.
	VtSequence,
	/// A committed corpus row, read back from JSONL.
	CorpusRow,
	/// Server-sent event framing from a provider socket.
	SseWire,
	/// A hashline patch as the edit tool receives it.
	HashlinePatch,
	/// An Argot handle token inside model output.
	ArgotToken,
	/// An HTTP/2 frame header from a provider connection.
	Http2Frame,
}

impl Surface {
	/// Every surface, in declaration order.
	#[must_use]
	pub const fn all() -> [Self; 6] {
		[
			Self::VtSequence,
			Self::CorpusRow,
			Self::SseWire,
			Self::HashlinePatch,
			Self::ArgotToken,
			Self::Http2Frame,
		]
	}

	/// The stable id a report prints.
	#[must_use]
	pub const fn id(self) -> &'static str {
		match self {
			Self::VtSequence => "vt-sequence",
			Self::CorpusRow => "corpus-row",
			Self::SseWire => "sse-wire",
			Self::HashlinePatch => "hashline-patch",
			Self::ArgotToken => "argot-token",
			Self::Http2Frame => "http2-frame",
		}
	}
}

impl std::fmt::Display for Surface {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(self.id())
	}
}

/// What a target did with one input.
///
/// A target reports a refusal rather than hiding it: `Rejected` is the answer a
/// parser is supposed to give to bytes it does not accept, and a target that
/// only ever answers `Accepted` is a target that accepts everything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
	/// The parser consumed the input.
	Accepted,
	/// The parser refused the input, which is a correct outcome.
	Rejected,
}

/// One fuzz target: a name, the surface it covers, and the body a harness
/// binary calls.
pub struct Target {
	pub name:    &'static str,
	pub surface: Surface,
	pub entry:   fn(&[u8]) -> Verdict,
}

impl std::fmt::Debug for Target {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Target")
			.field("name", &self.name)
			.field("surface", &self.surface)
			.finish()
	}
}

/// The registered targets.
pub static TARGETS: [Target; 2] = [
	Target { name: "vt-sequence-parser", surface: Surface::VtSequence, entry: vt_sequence },
	Target { name: "corpus-row-reader", surface: Surface::CorpusRow, entry: corpus_row },
];

/// Surfaces with no target, and what each one is waiting for.
///
/// Every row here is a parser that is still TypeScript. A target could only be
/// written against a Rust reimplementation, and issue #877 forbids testing a
/// reimplementation that is not the production implementation, so the honest
/// state is a named gap rather than a green target over a fake.
pub static AWAITING_MIGRATION: [(Surface, &str); 4] = [
	(Surface::SseWire, "provider wire parsing is still TypeScript"),
	(Surface::HashlinePatch, "the hashline parser is still TypeScript"),
	(Surface::ArgotToken, "the argot codec is still TypeScript"),
	(Surface::Http2Frame, "framing is h2's, and h2 is fuzzed upstream"),
];

/// Surfaces that have at least one registered target.
#[must_use]
pub fn covered_surfaces() -> BTreeSet<Surface> {
	TARGETS.iter().map(|target| target.surface).collect()
}

/// The target called `name`.
#[must_use]
pub fn target(name: &str) -> Option<&'static Target> {
	TARGETS.iter().find(|target| target.name == name)
}

/// A finding from a driven corpus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Finding {
	/// The target panicked. Never acceptable: a parser refuses input, it does
	/// not unwind through its caller.
	Panicked { target: &'static str, input: String, message: String },
}

/// What driving a corpus produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FuzzReport {
	pub target:   &'static str,
	pub executed: usize,
	pub accepted: usize,
	pub rejected: usize,
	pub findings: Vec<Finding>,
}

impl FuzzReport {
	/// Whether the target survived the corpus. An empty corpus is not a pass:
	/// it proves the driver ran, and nothing about the parser.
	#[must_use]
	pub const fn is_clean(&self) -> bool {
		self.executed > 0 && self.findings.is_empty()
	}
}

/// Feed every input in `corpus` to `target` and report what happened.
///
/// A panic is caught and recorded rather than propagated, so one bad input
/// produces a finding naming the input instead of a dead suite with no detail.
/// The input is reported in escaped form because a finding is read in a
/// terminal and raw bytes rewrite it.
#[must_use]
pub fn drive(target: &'static Target, corpus: &[Vec<u8>]) -> FuzzReport {
	let mut report = FuzzReport {
		target:   target.name,
		executed: 0,
		accepted: 0,
		rejected: 0,
		findings: Vec::new(),
	};
	for input in corpus {
		report.executed += 1;
		match catch_unwind(AssertUnwindSafe(|| (target.entry)(input))) {
			Ok(Verdict::Accepted) => report.accepted += 1,
			Ok(Verdict::Rejected) => report.rejected += 1,
			Err(payload) => report.findings.push(Finding::Panicked {
				target:  target.name,
				input:   escape(input),
				message: panic_message(&payload),
			}),
		}
	}
	report
}

/// A deterministic seed corpus for `surface`.
///
/// The boundaries come from [`boundary::text`], which is the same set the case
/// generator draws from, so a target is fed the payloads the corpus already
/// treats as interesting — including the two that are not valid UTF-8. The
/// remainder is random bytes from a labelled stream, so the corpus is
/// reproducible without being stored.
#[must_use]
pub fn seed_corpus(surface: Surface, extra: usize) -> Vec<Vec<u8>> {
	let mut corpus: Vec<Vec<u8>> = boundary::text()
		.into_iter()
		.map(|payload| payload.bytes)
		.collect();
	corpus.push(surface.id().as_bytes().to_vec());
	let mut rng = Rng::for_label(0x5eed, surface.id());
	for _ in 0..extra {
		let length = rng.below(64) as usize;
		let mut input = Vec::with_capacity(length);
		for _ in 0..length {
			input.push((rng.next_u64() & 0xff) as u8);
		}
		corpus.push(input);
	}
	corpus
}

/// The VT parser target: escape sequences into a grid.
///
/// The grid is the smallest the dimension rules allow, which is where wrap,
/// scroll and clamp arithmetic is most exposed. A malformed sequence is
/// recorded by the parser rather than applied, and that is the rejection this
/// target reports.
fn vt_sequence(input: &[u8]) -> Verdict {
	let Ok(mut grid) = Grid::new(20, 5) else {
		return Verdict::Rejected;
	};
	let mut parser = Parser::default();
	parser.parse_bytes(input, &mut grid);
	if parser.malformed_sequences().is_empty() {
		Verdict::Accepted
	} else {
		Verdict::Rejected
	}
}

/// The corpus reader target: JSONL bytes back into cases.
///
/// Non-UTF-8 input is a rejection rather than a skip: a committed corpus is
/// text, and bytes that are not text are exactly what a truncated write leaves
/// behind.
fn corpus_row(input: &[u8]) -> Verdict {
	let Ok(text) = std::str::from_utf8(input) else {
		return Verdict::Rejected;
	};
	if Corpus::from_jsonl(text).is_ok() {
		Verdict::Accepted
	} else {
		Verdict::Rejected
	}
}

/// `input` as a printable string: ASCII kept, everything else hexadecimal.
fn escape(input: &[u8]) -> String {
	let mut escaped = String::with_capacity(input.len());
	for byte in input {
		if byte.is_ascii_graphic() || *byte == b' ' {
			escaped.push(*byte as char);
		} else {
			write!(escaped, "\\x{byte:02x}").expect("writing to a String cannot fail");
		}
	}
	escaped
}

/// The message out of a caught panic payload.
fn panic_message(payload: &Box<dyn std::any::Any + Send>) -> String {
	if let Some(message) = payload.downcast_ref::<&str>() {
		return (*message).to_owned();
	}
	payload
		.downcast_ref::<String>()
		.cloned()
		.unwrap_or_else(|| "non-string panic payload".to_owned())
}
