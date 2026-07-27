#![no_main]

//! Fuzzes the primitives every minimizer filter is built out of.
//!
//! WHAT IS UNDER TEST. `minimizer::primitives` owns capping, dedup, blank-run collapsing,
//! elision accounting and the "did we write this line" question. `minimizer_filters.rs`
//! reaches all of it, but only through forty filters, so a defect in a primitive arrives
//! there as a failure in whichever filter happened to call it, minimized against that
//! filter's shape. Testing the primitives directly says which one is wrong.
//!
//! WHY THE CAPTURES ARE GENERATED AND NOT RAW BYTES. Every real defect in this module has
//! come from a capture that ALREADY HELD one of the module's own annotations: a repeat
//! counter read back as a table row, an elision marker counted as one line when it stood for
//! twenty-six, a find summary parsed as a path. Raw bytes essentially never produce
//! `[…26ln elided…]`, so a run spends itself on text no annotation-aware branch ever sees.
//! Lines are drawn from a table that is half program output and half markers this module
//! writes.
//!
//! THE PROPERTIES.
//!
//!   - ACCOUNTING. `head_tail_lines`, `head_lines_only`, `tail_lines_only` and `max_lines`
//!     each keep some lines and write one marker for the rest. The marker's count must equal
//!     the number of ORIGINAL lines it stands for, where a marker already in the capture
//!     stands for the count it carries and every other line stands for one. Get this wrong
//!     and a capture that has been through two passes under-reports what was dropped, which
//!     is the one number a caller cannot check for itself.
//!   - THE KEPT LINES ARE THE RIGHT ONES. Head keeps a PREFIX and tail keeps a SUFFIX, so an
//!     off-by-one that keeps the wrong window is caught even when the count is right.
//!   - IDEMPOTENCE. Everything here can run on its own output, because filters chain and
//!     captures get replayed. A primitive that changes its answer on the second pass makes
//!     every filter built on it do the same.
//!   - DEDUP CONSERVES LINES. `dedup_consecutive_lines` replaces a run with one line and a
//!     `(×N)` counter, so the counters and the kept lines have to add back up to the input.
//!   - BLANK RUNS. `collapse_blank_runs` may never drop a non-blank line and may never leave
//!     two blanks in a row.
//!   - `or_original` answers with one of its two arguments and never with nothing for a
//!     capture that printed something.

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use veyyon_shell::minimizer::primitives;

/// Lines a capture is built from: ordinary output on one side, annotations this module
/// writes on the other.
///
/// The markers are the point. Every accounting defect this target exists to catch needs a
/// capture that already carries one, and no byte-level generator produces `[…26ln elided…]`
/// by chance.
const LINES: &[&str] = &[
	// ordinary program output
	"src/main.rs:10:5: error[E0308]: mismatched types",
	"the same line",
	"the same line",
	"",
	"   ",
	"\t",
	"| a | b |",
	"----+----",
	"{\"a\": 1}",
	"a\tb",
	"warning: unused variable",
	"ok",
	// annotations this module writes
	"[…26ln elided…]",
	"[…1ln elided…]",
	"[…0ln elided…]",
	"the same line (×3)",
	"| a | b | (×2)",
	"100 entries",
	"13 rows",
	"find: 3 paths in 2 dirs",
	"3 diagnostics in 2 files",
	"log summary: 10 lines, 10 unique, 0 errors, 0 warnings, 0 info",
	// shapes that LOOK like annotations and are not
	"[…not a marker…]",
	"[…ln elided…]",
	"(×2)",
	"elided…]",
];

/// One line of a generated capture: a real one, or free-form bytes.
#[derive(Arbitrary, Debug)]
enum Line {
	Known(u8),
	Free(String),
}

impl Line {
	fn render(&self) -> String {
		match self {
			Line::Known(index) => LINES[*index as usize % LINES.len()].to_string(),
			// A newline inside a "line" would make the line count disagree with the number
			// of parts, and every property below counts lines.
			Line::Free(text) => text.replace(['\n', '\r'], " "),
		}
	}
}

/// The capture and the two window sizes to cap it with.
#[derive(Arbitrary, Debug)]
struct Input {
	lines: Vec<Line>,
	head: u8,
	tail: u8,
}

/// The longest capture the target builds. Past this the properties are the same ones with
/// more lines, and the extra bytes only slow the run down.
const MAX_LINES: usize = 40;

/// How many ORIGINAL lines this line stands for: the count a marker carries, else one.
///
/// A MIRROR of `primitives::represented_line_count`, which is private. Restating the rule
/// here is the point: if the real one changes, this target fails rather than silently
/// adopting the new behaviour as correct.
fn represented(line: &str) -> usize {
	line.trim()
		.strip_prefix("[…")
		.and_then(|rest| rest.strip_suffix("ln elided…]"))
		.and_then(|count| count.parse::<usize>().ok())
		.unwrap_or(1)
}

/// The total number of original lines a text stands for.
fn represented_total(text: &str) -> usize {
	text.lines().map(represented).sum()
}

/// The count carried by the single elision marker in `text`, if there is exactly one.
fn sole_marker_count(text: &str) -> Option<usize> {
	let mut found = None;
	for line in text.lines() {
		let Some(count) = line
			.trim()
			.strip_prefix("[…")
			.and_then(|rest| rest.strip_suffix("ln elided…]"))
			.and_then(|count| count.parse::<usize>().ok())
		else {
			continue;
		};
		if found.is_some() {
			return None;
		}
		found = Some(count);
	}
	found
}

/// Every capping primitive conserves the number of original lines it stands for.
///
/// The invariant is stated on the TOTAL rather than on the marker alone so it holds whether
/// or not the primitive decided to elide anything: a capture short enough to pass through
/// untouched still stands for exactly as many lines as it did.
fn check_conserves(what: &str, input: &str, output: &str) {
	assert_eq!(
		represented_total(output),
		represented_total(input),
		"{what} lost or invented lines; input {input:?}, output {output:?}",
	);
}

/// Applying `f` to its own output changes nothing.
fn check_settles(what: &str, input: &str, f: impl Fn(&str) -> String) {
	let first = f(input);
	let second = f(&first);
	assert_eq!(second, first, "{what} changed its own output on a second pass; input {input:?}");
}

fuzz_target!(|value: Input| {
	let lines: Vec<String> = value.lines.iter().take(MAX_LINES).map(Line::render).collect();
	if lines.is_empty() {
		return;
	}
	let mut input = lines.join("\n");
	input.push('\n');
	let line_count = input.lines().count();

	// Windows are kept small on purpose: a head or tail wider than the capture makes every
	// primitive a passthrough, and the interesting behaviour is at the boundary.
	let head = usize::from(value.head) % (line_count + 2);
	let tail = usize::from(value.tail) % (line_count + 2);

	// ACCOUNTING AND WINDOWS.
	let capped = primitives::head_tail_lines(&input, head, tail);
	check_conserves("head_tail_lines", &input, &capped);
	if line_count > head + tail {
		let kept: Vec<&str> = capped.lines().collect();
		let original: Vec<&str> = input.lines().collect();
		assert_eq!(
			&kept[..head],
			&original[..head],
			"head_tail_lines kept the wrong prefix; input {input:?}",
		);
		assert_eq!(
			&kept[kept.len() - tail..],
			&original[original.len() - tail..],
			"head_tail_lines kept the wrong suffix; input {input:?}",
		);
		// One marker, and it stands for exactly the window that was dropped.
		let dropped: usize = original[head..original.len() - tail].iter().copied().map(represented).sum();
		assert_eq!(
			sole_marker_count(&capped),
			Some(dropped),
			"head_tail_lines miscounted what it elided; input {input:?}, output {capped:?}",
		);
	} else {
		assert_eq!(capped, input, "a capture that fits is returned unchanged; input {input:?}");
	}

	let head_only = primitives::head_lines_only(&input, head);
	check_conserves("head_lines_only", &input, &head_only);
	let tail_only = primitives::tail_lines_only(&input, tail);
	check_conserves("tail_lines_only", &input, &tail_only);
	let hard = primitives::max_lines(&input, head);
	check_conserves("max_lines", &input, &hard);

	// DEDUP CONSERVES LINES THAT SAY SOMETHING. A run of N identical lines becomes one line
	// plus a `(×N)` counter, so what the output stands for has to match what went in.
	//
	// BLANK RUNS ARE EXEMPT, and deliberately so: a counter on whitespace invents a message
	// the program never printed, and blank lines separate sections in the output of cargo,
	// tsc, eslint, git and gh, so ` (×2)` was being spliced into most of what an agent read.
	// `flush_repeated` therefore collapses a blank run and writes no counter, which means
	// blank lines are the one thing dedup is allowed to lose. Stating the property over
	// non-blank lines only is what makes it true; stating it over all of them just
	// rediscovers that decision.
	let deduped = primitives::dedup_consecutive_lines(&input);
	assert_eq!(
		represented_repeat_total(&deduped),
		represented_repeat_total(&input),
		"dedup_consecutive_lines lost lines that said something; input {input:?}, output {deduped:?}",
	);
	for line in deduped.lines() {
		let content = line.rfind(" (×").map_or(line, |at| &line[..at]);
		assert!(
			!(content.trim().is_empty() && line != content),
			"dedup_consecutive_lines annotated whitespace; input {input:?}, output {deduped:?}",
		);
	}

	// BLANK RUNS. Nothing with content is dropped, and no two blanks survive together.
	for trim_whitespace_only in [false, true] {
		let collapsed = primitives::collapse_blank_runs(&input, trim_whitespace_only);
		let is_blank = |line: &str| if trim_whitespace_only { line.trim().is_empty() } else { line.is_empty() };
		let before: Vec<&str> = input.lines().filter(|line| !is_blank(line)).collect();
		let after: Vec<&str> = collapsed.lines().filter(|line| !is_blank(line)).collect();
		assert_eq!(after, before, "collapse_blank_runs dropped content; input {input:?}");
		let mut previous_blank = false;
		for line in collapsed.lines() {
			let blank = is_blank(line);
			assert!(
				!(blank && previous_blank),
				"collapse_blank_runs left two blanks in a row; input {input:?}, output {collapsed:?}",
			);
			previous_blank = blank;
		}
	}

	// IDEMPOTENCE, which is the property filters inherit from these.
	check_settles("collapse_blank_runs", &input, |text| primitives::collapse_blank_runs(text, true));
	check_settles("head_tail_lines", &input, |text| primitives::head_tail_lines(text, head, tail));
	check_settles("head_lines_only", &input, |text| primitives::head_lines_only(text, head));
	check_settles("tail_lines_only", &input, |text| primitives::tail_lines_only(text, tail));
	check_settles("max_lines", &input, |text| primitives::max_lines(text, head));
	check_settles("dedup_consecutive_lines", &input, primitives::dedup_consecutive_lines);
	check_settles("strip_ansi", &input, primitives::strip_ansi);
	check_settles("normalize_carriage_returns", &input, primitives::normalize_carriage_returns);

	// `or_original` answers with one of its two arguments, and never with nothing for a
	// capture that printed something.
	let answer = primitives::or_original(capped.clone(), &input);
	assert!(
		answer == capped || answer == input,
		"or_original invented an answer; compaction {capped:?}, original {input:?}, answer {answer:?}",
	);
	if !input.trim().is_empty() {
		assert!(
			!primitives::or_original(String::new(), &input).is_empty(),
			"or_original answered with nothing for a capture that printed something; input {input:?}",
		);
	}

	// The two halves of the annotation question agree line by line.
	for line in input.lines() {
		assert_eq!(
			primitives::is_program_content(line),
			!line.trim().is_empty() && !primitives::is_minimizer_annotation(line),
			"is_program_content disagrees with is_minimizer_annotation about {line:?}",
		);
	}
	assert_eq!(
		primitives::has_program_content(&input),
		input.lines().any(primitives::is_program_content),
		"has_program_content disagrees with its own per-line form; input {input:?}",
	);
});

/// How many NON-BLANK original lines a text stands for, counting repeat counters.
///
/// `dedup_consecutive_lines` writes ` (×N)`, which stands for N lines rather than the one an
/// elision marker's line count would give. Kept separate from `represented` so the capping
/// properties, which never write a repeat counter, are not weakened by understanding one.
///
/// Blank lines are skipped because a blank run collapses without a counter; see the call
/// site for why that is the right behaviour rather than a defect.
fn represented_repeat_total(text: &str) -> usize {
	text.lines()
		.filter(|line| !line.trim().is_empty())
		.map(|line| {
			let trimmed = line.trim_end();
			let Some(open) = trimmed.rfind(" (×") else {
				return represented(line);
			};
			let Some(count) = trimmed[open + " (×".len()..].strip_suffix(')') else {
				return represented(line);
			};
			count.parse::<usize>().unwrap_or(1)
		})
		.sum()
}
