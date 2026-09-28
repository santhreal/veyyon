//! Parsing and highlighting finish in bounded time on large inputs. Each test
//! prints its measured time; the bounds are generous, so a failure means a
//! hang or a complexity regression rather than a slow host.

use std::time::{Duration, Instant};

use veyyon_desktop_ui::markdown::{MarkdownDoc, highlight};

const BOUND: Duration = Duration::from_secs(20);

/// `count` lines built by `line`, concatenated.
fn joined(count: usize, line: impl Fn(usize) -> String) -> String {
	let mut out = String::new();
	for i in 0..count {
		out.push_str(&line(i));
	}
	out
}

#[test]
fn a_5000_line_code_block_highlights_in_bounded_time() {
	let code = joined(5000, |i| {
		format!("pub fn f{i}(x: u32) -> u32 {{ let y = x + {i}; /* note */ y * 2 }} // line {i}\n")
	});
	let started = Instant::now();
	let highlighted = highlight(&code, Some("rust"));
	let full = started.elapsed();
	assert!(highlighted.spans().len() > 5000, "{} spans", highlighted.spans().len());
	assert!(highlighted.role_at(code.len() - 3).is_some(), "the last line is highlighted");

	// A different block of the same size streamed about 50 lines at a time,
	// each cut landing mid-line.
	let text = code.replace("line", "row");
	let started = Instant::now();
	let mut cut = 0;
	let mut steps = 0;
	while cut < text.len() {
		cut = (cut + 50 * 80 + 17).min(text.len());
		highlight(&text[..cut], Some("rust"));
		steps += 1;
	}
	let streamed = started.elapsed();
	eprintln!(
		"highlight 5000 lines ({} bytes): full {full:?}; streamed in {steps} deltas {streamed:?}",
		code.len()
	);
	assert!(full < BOUND && streamed < BOUND, "full {full:?}, streamed {streamed:?}");
}

#[test]
fn a_long_document_parses_and_streams_in_bounded_time() {
	let source = joined(2000, |i| match i % 4 {
		0 => format!("## Section {i}\n\n"),
		1 => format!("Paragraph {i} with **bold**, `code` and a [link](https://example.com/{i}).\n\n"),
		2 => format!("- item {i}\n- second item\n  - nested\n\n"),
		_ => format!("```rust\nfn f{i}() {{}}\n```\n\n"),
	});
	let started = Instant::now();
	let full = MarkdownDoc::new(source.as_str());
	let parse = started.elapsed();

	let started = Instant::now();
	let mut streamed = MarkdownDoc::default();
	let mut slowest = Duration::ZERO;
	for delta in source.as_bytes().chunks(32) {
		let Ok(delta) = std::str::from_utf8(delta) else {
			panic!("the corpus is ASCII");
		};
		let step = Instant::now();
		streamed.append(delta);
		slowest = slowest.max(step.elapsed());
	}
	let stream = started.elapsed();
	eprintln!(
		"parse {} bytes: full {parse:?}; streamed in 32-byte deltas {stream:?}, slowest append {slowest:?}",
		source.len()
	);
	assert_eq!(streamed.blocks(), full.blocks());
	assert!(parse < BOUND && stream < BOUND, "full {parse:?}, streamed {stream:?}");
}
