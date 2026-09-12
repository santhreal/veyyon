use std::{
	io::{self, BufWriter, LineWriter, Read, Write},
	path::PathBuf,
	time::Duration,
};

use grep_matcher::{Captures, Match as Span, Matcher};
use grep_printer::Stats;
use grep_searcher::{Searcher, Sink, SinkContext, SinkFinish, SinkMatch};
use smallvec::SmallVec;

use crate::{match_spans, matcher::strip_record_terminator};

pub const PREVIEW_CUT_MARKER: &[u8] = b" [... omitted end of long line]";

/// How a stream is buffered.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Buffering {
	Block,
	Line,
}

impl Buffering {
	/// The mode for this command line, given whether stdout is a terminal.
	#[must_use]
	pub const fn resolve(
		line_buffered: bool,
		block_buffered: bool,
		stdout_is_terminal: bool,
	) -> Self {
		if line_buffered {
			return Self::Line;
		}
		if block_buffered {
			return Self::Block;
		}
		if stdout_is_terminal {
			Self::Line
		} else {
			Self::Block
		}
	}

	/// Wrap `sink` so it buffers the way this mode says.
	pub fn wrap<W: Write>(self, sink: W) -> BufferSinkOf<W> {
		match self {
			Self::Line => BufferSinkOf::Line(LineWriter::new(sink)),
			Self::Block => BufferSinkOf::Block(BufWriter::new(sink)),
		}
	}
}

/// Output writer for either buffering mode.
pub enum BufferSinkOf<W: Write> {
	Block(BufWriter<W>),
	Line(LineWriter<W>),
}

impl<W: Write> Write for BufferSinkOf<W> {
	fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
		match self {
			Self::Block(output) => output.write(bytes),
			Self::Line(output) => output.write(bytes),
		}
	}

	fn flush(&mut self) -> io::Result<()> {
		match self {
			Self::Block(output) => output.flush(),
			Self::Line(output) => output.flush(),
		}
	}
}

/// Configuration options controlling how a search prints or collects its
/// results.
#[derive(Clone, Debug)]
pub struct SearchOptions {
	pub line_number:         bool,
	pub column:              bool,
	pub byte_offset:         bool,
	pub count:               bool,
	pub count_matches:       bool,
	pub files_with_matches:  bool,
	pub files_without_match: bool,
	pub only_matching:       bool,
	pub quiet:               bool,
	pub vimgrep:             bool,
	pub before:              usize,
	pub after:               usize,
	pub passthru:            bool,
	pub trim:                bool,
	pub max_columns:         Option<usize>,
	pub max_columns_preview: bool,
	pub null_paths:          bool,
	pub record_terminator:   u8,
	pub no_messages:         bool,
	pub replacement:         Option<Vec<u8>>,
	pub json:                bool,
	pub stats:               bool,
	pub heading:             bool,
	pub path_separator:      Option<u8>,
	pub include_zero:        bool,
	pub match_separator:     Vec<u8>,
	pub context_separator:   Vec<u8>,
	pub group_separator:     Option<Vec<u8>>,
	pub pre_command:         Option<std::ffi::OsString>,
	pub pre_globs:           Vec<String>,
}

impl Default for SearchOptions {
	fn default() -> Self {
		Self {
			line_number:         false,
			column:              false,
			byte_offset:         false,
			count:               false,
			count_matches:       false,
			files_with_matches:  false,
			files_without_match: false,
			only_matching:       false,
			quiet:               false,
			vimgrep:             false,
			before:              0,
			after:               0,
			passthru:            false,
			trim:                false,
			max_columns:         None,
			max_columns_preview: false,
			null_paths:          false,
			record_terminator:   b'\n',
			no_messages:         false,
			replacement:         None,
			json:                false,
			stats:               false,
			heading:             false,
			path_separator:      None,
			include_zero:        false,
			match_separator:     vec![b':'],
			context_separator:   vec![b'-'],
			group_separator:     Some(vec![b'-', b'-']),
			pre_command:         None,
			pre_globs:           Vec::new(),
		}
	}
}

impl SearchOptions {
	#[must_use]
	pub const fn summary_mode(&self) -> bool {
		self.count || self.count_matches || self.files_with_matches || self.files_without_match
	}

	#[must_use]
	pub const fn stops_the_run_at_first_match(&self) -> bool {
		self.quiet && !self.stats && !self.json
	}

	#[must_use]
	pub const fn reports_whole_search_numbers(&self) -> bool {
		self.stats || self.json
	}

	#[must_use]
	pub const fn stops_a_file_at_first_match(&self) -> bool {
		if self.reports_whole_search_numbers() {
			return false;
		}
		self.stops_the_run_at_first_match() || self.files_with_matches || self.files_without_match
	}

	#[must_use]
	pub const fn prints_context_lines(&self) -> bool {
		(self.passthru || self.before > 0 || self.after > 0) && !self.summary_mode()
	}

	#[must_use]
	pub const fn requests_context(&self) -> bool {
		(self.before > 0 || self.after > 0) && !self.summary_mode()
	}

	#[must_use]
	pub const fn selected_input(&self, any_match: bool) -> bool {
		if self.files_without_match {
			!any_match
		} else {
			any_match
		}
	}
}

/// Outcome of searching a single file or stream.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SearchOutcome {
	pub any_match: bool,
	pub had_error: bool,
}

/// A writer that tracks how many bytes were accepted.
pub struct CountingWriter<'a, W: Write> {
	pub inner:   &'a mut W,
	pub written: u64,
}

impl<W: Write> Write for CountingWriter<'_, W> {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		let n = self.inner.write(buf)?;
		self.written += n as u64;
		Ok(n)
	}

	fn flush(&mut self) -> io::Result<()> {
		self.inner.flush()
	}
}

#[derive(Clone, Copy)]
pub enum BodyKind<'a> {
	MatchingLine { spans: &'a [Span] },
	MatchText,
	ContextLine,
}

/// A Sink implementing ripgrep's line formatting and output rules.
pub struct RgSink<'a, M: Matcher, W: Write> {
	pub out:             CountingWriter<'a, W>,
	pub matcher:         &'a M,
	pub display:         Option<&'a [u8]>,
	pub opts:            &'a SearchOptions,
	pub captures:        M::Captures,
	pub scratch:         Vec<u8>,
	pub spans:           Vec<Span>,
	pub replaced_spans:  Vec<Span>,
	pub line_count:      u64,
	pub match_count:     u64,
	pub any_match:       bool,
	pub bytes_searched:  u64,
	pub follows_a_group: bool,
	pub printed_group:   bool,
	pub binary_offset:   Option<u64>,
	pub binary_quit:     bool,
}

impl<'a, M: Matcher, W: Write> RgSink<'a, M, W> {
	pub fn new(
		out: &'a mut W,
		matcher: &'a M,
		display: Option<&'a [u8]>,
		opts: &'a SearchOptions,
		follows_a_group: bool,
	) -> Result<Self, io::Error> {
		let captures = matcher
			.new_captures()
			.map_err(|error| io::Error::other(error.to_string()))?;
		Ok(Self {
			out: CountingWriter { inner: out, written: 0 },
			matcher,
			display,
			opts,
			captures,
			scratch: Vec::new(),
			spans: Vec::new(),
			replaced_spans: Vec::new(),
			line_count: 0,
			match_count: 0,
			any_match: false,
			bytes_searched: 0,
			follows_a_group,
			printed_group: false,
			binary_offset: None,
			binary_quit: false,
		})
	}

	pub fn write_path_with_separator(&mut self, separator: &[u8]) -> io::Result<()> {
		if let Some(name) = self.display {
			self.out.write_all(name)?;
			if self.opts.null_paths {
				self.out.write_all(b"\0")?;
			} else {
				self.out.write_all(separator)?;
			}
		}
		Ok(())
	}

	pub const fn filtered_as_binary(&self) -> bool {
		self.binary_quit && self.binary_offset.is_some() && self.opts.summary_mode()
	}

	pub fn write_terminator(&mut self) -> io::Result<()> {
		self.out.write_all(&[self.opts.record_terminator])
	}

	pub const fn heading_mode(&self) -> bool {
		self.opts.heading && !self.opts.vimgrep && !self.opts.summary_mode()
	}

	pub fn search_separator(&self) -> Option<&[u8]> {
		if self.opts.summary_mode() {
			None
		} else if self.heading_mode() {
			Some(&[])
		} else if self.opts.requests_context() {
			self.opts.group_separator.as_deref()
		} else {
			None
		}
	}

	pub fn begin_search(&mut self) -> io::Result<()> {
		if self.printed_group {
			return Ok(());
		}
		self.printed_group = true;
		if self.follows_a_group
			&& let Some(separator) = self.search_separator()
		{
			let separator = separator.to_vec();
			self.out.write_all(&separator)?;
			self.write_terminator()?;
		}
		Ok(())
	}

	pub fn begin_group(&mut self) -> io::Result<()> {
		if self.printed_group {
			return Ok(());
		}
		self.begin_search()?;
		if self.heading_mode() && self.display.is_some() {
			self.write_path_with_separator(&[self.opts.record_terminator])?;
		}
		Ok(())
	}

	pub fn write_binary_notice(&mut self, offset: u64) -> io::Result<()> {
		self.begin_search()?;
		if let Some(name) = self.display {
			self.out.write_all(name)?;
			self.out.write_all(b": ")?;
		}
		write!(self.out, "binary file matches (found \"\\0\" byte around offset {offset})")?;
		self.write_terminator()
	}

	pub fn write_prefix(
		&mut self,
		line_number: Option<u64>,
		column: Option<usize>,
		byte_offset: u64,
		separator: &[u8],
	) -> io::Result<()> {
		self.begin_group()?;
		if !self.heading_mode() && self.display.is_some() {
			self.write_path_with_separator(separator)?;
		}
		if self.opts.line_number
			&& let Some(number) = line_number
		{
			write!(self.out, "{number}")?;
			self.out.write_all(separator)?;
		}
		if self.opts.column
			&& let Some(column) = column
		{
			write!(self.out, "{column}")?;
			self.out.write_all(separator)?;
		}
		if self.opts.byte_offset {
			write!(self.out, "{byte_offset}")?;
			self.out.write_all(separator)?;
		}
		Ok(())
	}

	pub fn write_body(&mut self, bytes: &[u8], kind: BodyKind<'_>) -> io::Result<()> {
		let bytes = if self.opts.trim {
			trim_ascii_start(bytes)
		} else {
			bytes
		};
		if self.exceeds_limit(bytes) {
			self.write_substitute(bytes, kind)?;
			return self.write_terminator();
		}
		self.out.write_all(bytes)?;
		if !bytes.ends_with(&[self.opts.record_terminator]) {
			self.write_terminator()?;
		}
		Ok(())
	}

	pub fn exceeds_limit(&self, bytes: &[u8]) -> bool {
		self
			.opts
			.max_columns
			.is_some_and(|limit| limit > 0 && bytes.len() > limit)
	}

	pub fn write_substitute(&mut self, bytes: &[u8], kind: BodyKind<'_>) -> io::Result<()> {
		let content = self.strip_terminator(bytes);
		if !self.opts.max_columns_preview {
			return match kind {
				BodyKind::MatchingLine { spans } if self.knows_match_positions() => {
					let total = spans.len();
					write!(self.out, "[Omitted long line with {total} matches]")
				},
				BodyKind::MatchingLine { .. } | BodyKind::MatchText => {
					self.out.write_all(b"[Omitted long matching line]")
				},
				BodyKind::ContextLine => self.out.write_all(b"[Omitted long context line]"),
			};
		}
		let limit = self.opts.max_columns.unwrap_or(0);
		let prefix = preview_prefix(content, limit);
		let cut = prefix.len();
		self.out.write_all(prefix)?;
		let remaining = match kind {
			BodyKind::MatchText => Some(0),
			BodyKind::MatchingLine { spans } if self.knows_match_positions() => {
				Some(spans.iter().filter(|span| span.start() >= cut).count())
			},
			BodyKind::MatchingLine { .. } | BodyKind::ContextLine => None,
		};
		match remaining {
			Some(1) => self.out.write_all(b" [... 1 more match]"),
			Some(count) => write!(self.out, " [... {count} more matches]"),
			None => self.out.write_all(PREVIEW_CUT_MARKER),
		}
	}

	pub const fn knows_match_positions(&self) -> bool {
		self.opts.column || self.opts.replacement.is_some()
	}

	pub fn strip_terminator<'b>(&self, bytes: &'b [u8]) -> &'b [u8] {
		strip_record_terminator(bytes, self.opts.record_terminator)
	}

	pub fn print_matched_line(
		&mut self,
		line: &[u8],
		line_number: Option<u64>,
		line_offset: u64,
	) -> io::Result<bool> {
		let mut spans = std::mem::take(&mut self.spans);
		let result = self.scan_and_print(line, &mut spans, line_number, line_offset);
		spans.clear();
		self.spans = spans;
		result
	}

	pub fn scan_and_print(
		&mut self,
		line: &[u8],
		spans: &mut Vec<Span>,
		line_number: Option<u64>,
		line_offset: u64,
	) -> io::Result<bool> {
		match_spans(self.matcher, self.strip_terminator(line), spans)?;
		let found =
			u64::try_from(spans.len()).map_err(|error| io::Error::other(error.to_string()))?;
		self.match_count += found.max(1);

		if self.opts.quiet || self.opts.files_with_matches {
			return Ok(!self.opts.stops_a_file_at_first_match());
		}
		if self.opts.files_without_match || self.opts.count || self.opts.count_matches {
			return Ok(true);
		}
		if self.binary_offset.is_some() {
			return Ok(true);
		}
		if self.opts.replacement.is_some() {
			let mut body = std::mem::take(&mut self.scratch);
			let mut body_spans = std::mem::take(&mut self.replaced_spans);
			body.clear();
			body_spans.clear();
			let result = self
				.interpolate(line, spans, &mut body, &mut body_spans)
				.and_then(|()| self.print_records(&body, &body_spans, line_number, line_offset));
			body.clear();
			body_spans.clear();
			self.scratch = body;
			self.replaced_spans = body_spans;
			result?;
		} else {
			self.print_records(line, spans, line_number, line_offset)?;
		}
		Ok(true)
	}

	pub fn interpolate(
		&mut self,
		line: &[u8],
		spans: &[Span],
		out: &mut Vec<u8>,
		out_spans: &mut Vec<Span>,
	) -> io::Result<()> {
		let Some(replacement) = self.opts.replacement.as_deref() else {
			out.extend_from_slice(line);
			out_spans.extend_from_slice(spans);
			return Ok(());
		};
		let mut copied = 0usize;
		for span in spans {
			out.extend_from_slice(&line[copied..span.start()]);
			let begin = out.len();
			if self
				.matcher
				.captures_at(line, span.start(), &mut self.captures)
				.map_err(|error| io::Error::other(error.to_string()))?
			{
				self.captures.interpolate(
					|name| self.matcher.capture_index(name),
					line,
					replacement,
					out,
				);
			}
			out_spans.push(Span::new(begin, out.len()));
			copied = span.end();
		}
		out.extend_from_slice(&line[copied..]);
		Ok(())
	}

	pub fn print_records(
		&mut self,
		body: &[u8],
		spans: &[Span],
		line_number: Option<u64>,
		line_offset: u64,
	) -> io::Result<()> {
		if self.record_spans_lines(body) {
			return self.print_multi_line_records(body, spans, line_number, line_offset);
		}
		if self.opts.only_matching || self.opts.vimgrep {
			for span in spans {
				let offset = line_offset.saturating_add(
					u64::try_from(span.start()).map_err(|error| io::Error::other(error.to_string()))?,
				);
				self.write_prefix(
					line_number,
					Some(span.start() + 1),
					offset,
					&self.opts.match_separator,
				)?;
				if self.opts.only_matching {
					self.write_body(&body[span.start()..span.end()], BodyKind::MatchText)?;
				} else {
					self.write_body(body, BodyKind::MatchingLine { spans })?;
				}
			}
			if spans.is_empty() && self.opts.vimgrep {
				self.write_prefix(line_number, Some(1), line_offset, &self.opts.match_separator)?;
				self.write_body(body, BodyKind::MatchingLine { spans })?;
			}
			return Ok(());
		}
		let column = if self.opts.column {
			Some(spans.first().map_or(1, |span| span.start() + 1))
		} else {
			None
		};
		self.write_prefix(line_number, column, line_offset, &self.opts.match_separator)?;
		self.write_body(body, BodyKind::MatchingLine { spans })
	}

	pub fn record_spans_lines(&self, body: &[u8]) -> bool {
		let terminator = self.opts.record_terminator;
		body
			.strip_suffix(&[terminator])
			.unwrap_or(body)
			.contains(&terminator)
	}

	pub fn print_multi_line_records(
		&mut self,
		body: &[u8],
		spans: &[Span],
		line_number: Option<u64>,
		line_offset: u64,
	) -> io::Result<()> {
		let terminator = self.opts.record_terminator;
		if self.opts.vimgrep {
			return self.print_multi_line_vimgrep_records(body, spans, line_number, line_offset);
		}
		let column = if self.opts.column {
			Some(spans.first().map_or(1, |span| span.start() + 1))
		} else {
			None
		};
		let mut on_this_line: Vec<Span> = Vec::new();
		let mut start = 0usize;
		for (index, line) in body.split_inclusive(|byte| *byte == terminator).enumerate() {
			let end = start + line.len();
			let content = line.strip_suffix(&[terminator]).unwrap_or(line).len();
			let index = u64::try_from(index).map_err(|error| io::Error::other(error.to_string()))?;
			let start_offset = line_offset.saturating_add(
				u64::try_from(start).map_err(|error| io::Error::other(error.to_string()))?,
			);
			if self.opts.only_matching {
				for span in spans
					.iter()
					.filter(|span| span.end() > start && span.start() < start + content)
				{
					let piece_start = span.start().max(start);
					let piece_end = span.end().min(start + content);
					let offset = line_offset.saturating_add(
						u64::try_from(span.start())
							.map_err(|error| io::Error::other(error.to_string()))?,
					);
					self.write_prefix(
						line_number.map(|number| number + index),
						Some(span.start() + 1),
						offset,
						&self.opts.match_separator,
					)?;
					self
						.write_body(&line[piece_start - start..piece_end - start], BodyKind::MatchText)?;
				}
			} else {
				on_this_line.clear();
				on_this_line.extend(
					spans
						.iter()
						.filter(|span| span.end() > start && span.start() < end)
						.map(|span| {
							Span::new(span.start().max(start) - start, span.end().min(end) - start)
						}),
				);
				self.write_prefix(
					line_number.map(|number| number + index),
					column,
					start_offset,
					&self.opts.match_separator,
				)?;
				self.write_body(line, BodyKind::MatchingLine { spans: &on_this_line })?;
			}
			start = end;
		}
		Ok(())
	}

	pub fn print_multi_line_vimgrep_records(
		&mut self,
		body: &[u8],
		spans: &[Span],
		line_number: Option<u64>,
		line_offset: u64,
	) -> io::Result<()> {
		let terminator = self.opts.record_terminator;
		if spans.is_empty() {
			let first = first_line(body, terminator);
			self.write_prefix(line_number, Some(1), line_offset, &self.opts.match_separator)?;
			return self.write_body(&body[..first], BodyKind::MatchingLine { spans });
		}
		for span in spans {
			let (index, start, end) = line_holding(body, terminator, span.start());
			let offset = line_offset.saturating_add(
				u64::try_from(start).map_err(|error| io::Error::other(error.to_string()))?,
			);
			self.write_prefix(
				line_number.map(|number| number + index),
				Some(span.start() - start + 1),
				offset,
				&self.opts.match_separator,
			)?;
			self.write_body(&body[start..end], BodyKind::MatchingLine { spans })?;
		}
		Ok(())
	}
}

impl<M: Matcher, W: Write> Sink for RgSink<'_, M, W> {
	type Error = io::Error;

	fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, io::Error> {
		self.line_count += 1;
		self.any_match = true;
		let line_offset = mat.absolute_byte_offset();
		self.print_matched_line(mat.bytes(), mat.line_number(), line_offset)
	}

	fn context(&mut self, _searcher: &Searcher, ctx: &SinkContext<'_>) -> Result<bool, io::Error> {
		if !self.opts.prints_context_lines() || self.binary_offset.is_some() || self.opts.quiet {
			return Ok(true);
		}
		let line_offset = ctx.absolute_byte_offset();
		self.write_prefix(ctx.line_number(), None, line_offset, &self.opts.context_separator)?;
		self.write_body(ctx.bytes(), BodyKind::ContextLine)?;
		Ok(true)
	}

	fn binary_data(&mut self, _searcher: &Searcher, offset: u64) -> Result<bool, io::Error> {
		if self.binary_offset.is_none() {
			self.binary_offset = Some(offset);
		}
		Ok(true)
	}

	fn context_break(&mut self, _searcher: &Searcher) -> Result<bool, io::Error> {
		if self.binary_offset.is_some() {
			return Ok(true);
		}
		if self.opts.prints_context_lines()
			&& let Some(separator) = self.opts.group_separator.as_deref()
		{
			self.out.write_all(separator)?;
			self.write_terminator()?;
		}
		Ok(true)
	}

	fn finish(&mut self, searcher: &Searcher, finish: &SinkFinish) -> Result<(), io::Error> {
		self.bytes_searched = finish.byte_count();
		self.binary_quit = searcher.binary_detection().quit_byte().is_some();
		if self.filtered_as_binary() {
			return Ok(());
		}
		if let Some(offset) = self.binary_offset
			&& self.any_match
			&& !self.opts.summary_mode()
			&& !self.opts.quiet
		{
			self.write_binary_notice(offset)?;
		}
		if self.opts.quiet {
			return Ok(());
		}
		if self.opts.files_with_matches {
			if self.any_match {
				self.write_path_with_separator(&[self.opts.record_terminator])?;
			}
		} else if self.opts.files_without_match {
			if !self.any_match {
				self.write_path_with_separator(&[self.opts.record_terminator])?;
			}
		} else if (self.opts.count || self.opts.count_matches)
			&& (self.any_match || self.opts.include_zero)
		{
			self.write_path_with_separator(&self.opts.match_separator)?;
			let count = if self.opts.count_matches {
				self.match_count
			} else {
				self.line_count
			};
			write!(self.out, "{count}")?;
			self.write_terminator()?;
		}
		Ok(())
	}
}

pub fn first_line(body: &[u8], terminator: u8) -> usize {
	body
		.split_inclusive(|byte| *byte == terminator)
		.next()
		.map_or(body.len(), |first| first.len())
}

pub fn line_holding(body: &[u8], terminator: u8, position: usize) -> (u64, usize, usize) {
	let mut start = 0usize;
	let mut last = (0u64, 0usize, body.len());
	for (index, line) in body.split_inclusive(|byte| *byte == terminator).enumerate() {
		let index = index as u64;
		let end = start + line.len();
		if position < end {
			return (index, start, end);
		}
		last = (index, start, end);
		start = end;
	}
	last
}

#[must_use]
pub fn preview_prefix(bytes: &[u8], columns: usize) -> &[u8] {
	let mut at = 0usize;
	let mut seen = 0usize;
	while at < bytes.len() && seen < columns {
		at += utf8_sequence_len(bytes[at]).min(bytes.len() - at);
		seen += 1;
	}
	&bytes[..at]
}

#[must_use]
pub const fn utf8_sequence_len(byte: u8) -> usize {
	match byte {
		0x00..=0x7f => 1,
		0xc0..=0xdf => 2,
		0xe0..=0xef => 3,
		0xf0..=0xf7 => 4,
		_ => 1,
	}
}

#[must_use]
pub fn trim_ascii_start(bytes: &[u8]) -> &[u8] {
	let start = bytes
		.iter()
		.position(|b| !b.is_ascii_whitespace() || *b == b'\n' || *b == b'\r')
		.unwrap_or(bytes.len());
	&bytes[start..]
}

#[must_use]
pub fn truncate_line(line: String, max_columns: Option<usize>) -> (String, bool) {
	match max_columns {
		Some(max) if line.len() > max => {
			let cut = max.saturating_sub(3);
			let boundary = line.floor_char_boundary(cut);
			(format!("{}...", &line[..boundary]), true)
		},
		_ => (line, false),
	}
}

#[must_use]
pub fn bytes_to_trimmed_string(bytes: &[u8]) -> String {
	match std::str::from_utf8(bytes) {
		Ok(text) => text.trim_end().to_string(),
		Err(_) => String::from_utf8_lossy(bytes).trim_end().to_string(),
	}
}

/// State maintained across a full multi-file search run.
pub struct RunState {
	pub stats:         Stats,
	pub printed_group: bool,
}

impl Default for RunState {
	fn default() -> Self {
		Self { stats: Stats::new(), printed_group: false }
	}
}

pub fn accumulate_text_stats<M: Matcher, W: Write>(
	stats: &mut Stats,
	sink: &RgSink<'_, M, W>,
	elapsed: Duration,
) {
	stats.add_elapsed(elapsed);
	stats.add_searches(1);
	if sink.any_match {
		stats.add_searches_with_match(1);
	}
	stats.add_bytes_searched(sink.bytes_searched);
	if !sink.opts.summary_mode() && !sink.opts.quiet {
		stats.add_bytes_printed(sink.out.written);
	}
	stats.add_matched_lines(sink.line_count);
	stats.add_matches(sink.match_count);
}

pub fn process_reader<M: Matcher, R: Read, W: Write>(
	matcher: &M,
	searcher: &mut Searcher,
	reader: R,
	display: Option<&[u8]>,
	opts: &SearchOptions,
	run: &mut RunState,
	out: &mut W,
) -> io::Result<bool> {
	if opts.json && !opts.quiet {
		let mut builder = grep_printer::JSONBuilder::new();
		builder.replacement(opts.replacement.clone());
		let mut printer = builder.build(out);
		if let Some(display) = display {
			let path = PathBuf::from(String::from_utf8_lossy(display).into_owned());
			let mut sink = printer.sink_with_path(matcher, &path);
			searcher.search_reader(matcher, reader, &mut sink)?;
			let matched = sink.has_match();
			run.stats += sink.stats();
			return Ok(matched);
		}
		let mut sink = printer.sink(matcher);
		searcher.search_reader(matcher, reader, &mut sink)?;
		let matched = sink.has_match();
		run.stats += sink.stats();
		return Ok(matched);
	}

	let mut sink = RgSink::new(out, matcher, display, opts, run.printed_group)?;
	let started = std::time::Instant::now();
	let outcome = searcher.search_reader(matcher, reader, &mut sink);
	let elapsed = started.elapsed();
	accumulate_text_stats(&mut run.stats, &sink, elapsed);
	run.printed_group |= sink.printed_group;
	outcome?;
	if sink.filtered_as_binary() {
		return Ok(false);
	}
	Ok(opts.selected_input(sink.any_match))
}

// ---------------------------------------------------------------------------
// Match collector for in-memory / structured N-API search
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct ContextLine {
	pub line_number: u32,
	pub line:        String,
	pub truncated:   Option<bool>,
}

#[derive(Debug)]
pub struct CollectedMatch {
	pub line_number:    u64,
	pub line:           String,
	pub context_before: SmallVec<[ContextLine; 8]>,
	pub context_after:  SmallVec<[ContextLine; 8]>,
	pub truncated:      bool,
}

pub struct MatchCollector {
	pub matches:         Vec<CollectedMatch>,
	pub match_count:     u64,
	pub collected_count: u64,
	pub max_count:       Option<u64>,
	pub offset:          u64,
	pub skipped:         u64,
	pub limit_reached:   bool,
	pub max_columns:     Option<usize>,
	pub collect_matches: bool,
	pub context_before:  SmallVec<[ContextLine; 8]>,
}

impl MatchCollector {
	#[must_use]
	pub fn new(
		max_count: Option<u64>,
		offset: u64,
		max_columns: Option<usize>,
		collect_matches: bool,
	) -> Self {
		Self {
			matches: Vec::new(),
			match_count: 0,
			collected_count: 0,
			max_count,
			offset,
			skipped: 0,
			limit_reached: false,
			max_columns,
			collect_matches,
			context_before: SmallVec::new(),
		}
	}
}

impl Sink for MatchCollector {
	type Error = io::Error;

	fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
		self.match_count += 1;

		if self.limit_reached {
			return Ok(false);
		}

		if self.skipped < self.offset {
			self.skipped += 1;
			self.context_before.clear();
			return Ok(true);
		}

		if self.collect_matches {
			let raw_line = bytes_to_trimmed_string(mat.bytes());
			let (line, truncated) = truncate_line(raw_line, self.max_columns);
			let line_number = mat.line_number().unwrap_or(0);

			self.matches.push(CollectedMatch {
				line_number,
				line,
				context_before: std::mem::take(&mut self.context_before),
				context_after: SmallVec::new(),
				truncated,
			});
		} else {
			self.context_before.clear();
		}

		self.collected_count += 1;

		if let Some(max) = self.max_count
			&& self.collected_count >= max
		{
			self.limit_reached = true;
		}

		Ok(true)
	}

	fn context(&mut self, _searcher: &Searcher, ctx: &SinkContext<'_>) -> Result<bool, Self::Error> {
		if !self.collect_matches {
			return Ok(true);
		}

		let raw_line = bytes_to_trimmed_string(ctx.bytes());
		let (line, truncated) = truncate_line(raw_line, self.max_columns);
		let line_number = ctx.line_number().unwrap_or(0);
		let truncated = truncated.then_some(true);

		match ctx.kind() {
			grep_searcher::SinkContextKind::Before => {
				self.context_before.push(ContextLine {
					line_number: line_number.min(u32::MAX as u64) as u32,
					line,
					truncated,
				});
			},
			grep_searcher::SinkContextKind::After => {
				if let Some(last_match) = self.matches.last_mut() {
					last_match.context_after.push(ContextLine {
						line_number: line_number.min(u32::MAX as u64) as u32,
						line,
						truncated,
					});
				}
			},
			grep_searcher::SinkContextKind::Other => {},
		}

		Ok(true)
	}
}

pub struct SearchResultInternal {
	pub matches:       Vec<CollectedMatch>,
	pub match_count:   u64,
	pub collected:     u64,
	pub limit_reached: bool,
}

#[derive(Debug)]
pub struct FileSearchResult {
	pub relative_path: String,
	pub matches:       Vec<CollectedMatch>,
	pub match_count:   u64,
	pub limit_reached: bool,
}
#[cfg(test)]
mod tests {
	use grep_matcher::Match as Span;
	use grep_regex::RegexMatcherBuilder;

	use super::*;

	#[test]
	fn line_holding_identifies_correct_line_and_offsets() {
		let body = b"line 1\nline 2 with more\nline 3\n";
		// Position 0 is on line index 0: start 0, end 7
		assert_eq!(line_holding(body, b'\n', 0), (0, 0, 7));
		// Position 6 is '\n' of line 0
		assert_eq!(line_holding(body, b'\n', 6), (0, 0, 7));
		// Position 7 is 'l' of line 1: start 7, end 24
		assert_eq!(line_holding(body, b'\n', 7), (1, 7, 24));
		// Position 24 is 'l' of line 2: start 24, end 31
		assert_eq!(line_holding(body, b'\n', 24), (2, 24, 31));
	}

	#[test]
	fn multiline_spans_spanning_lines_are_mapped_correctly() {
		let matcher = RegexMatcherBuilder::new()
			.multi_line(true)
			.build("(?s)start.*end")
			.expect("valid regex");
		let body = b"start line\nmiddle line\nend line\n";
		let mut out = Vec::new();
		let opts = SearchOptions { line_number: true, ..SearchOptions::default() };
		let mut sink = RgSink::new(&mut out, &matcher, None, &opts, false).expect("sink created");
		let spans = vec![Span::new(0, 27)]; // "start line\nmiddle line\nend"
		sink
			.print_multi_line_records(body, &spans, Some(1), 0)
			.expect("records printed");
		assert_eq!(String::from_utf8_lossy(&out), "1:start line\n2:middle line\n3:end line\n");
	}

	#[test]
	fn multiline_vimgrep_prints_each_matching_line_body_and_offset() {
		let matcher = RegexMatcherBuilder::new()
			.multi_line(true)
			.build("(?m)^match")
			.expect("valid regex");
		let body = b"first line\nmatch one\nmiddle line\nmatch two\n";
		let mut out = Vec::new();
		let opts = SearchOptions {
			vimgrep: true,
			column: true,
			byte_offset: true,
			line_number: true,
			..SearchOptions::default()
		};
		let mut sink =
			RgSink::new(&mut out, &matcher, Some(b"file.txt"), &opts, false).expect("sink created");
		let spans = vec![Span::new(11, 16), Span::new(35, 40)];
		sink
			.print_multi_line_vimgrep_records(body, &spans, Some(1), 0)
			.expect("records printed");
		assert_eq!(
			String::from_utf8_lossy(&out),
			"file.txt:2:1:11:match one\nfile.txt:4:3:33:match two\n"
		);
	}

	#[test]
	fn multiline_only_matching_prints_each_matching_line_segment() {
		let matcher = RegexMatcherBuilder::new()
			.multi_line(true)
			.build("(?s)start.*end")
			.expect("valid regex");
		let body = b"start line\nmiddle line\nend line\n";
		let mut out = Vec::new();
		let opts =
			SearchOptions { only_matching: true, line_number: true, ..SearchOptions::default() };
		let mut sink = RgSink::new(&mut out, &matcher, None, &opts, false).expect("sink created");
		let spans = vec![Span::new(0, 27)]; // "start line\nmiddle line\nend"
		sink
			.print_multi_line_records(body, &spans, Some(1), 0)
			.expect("records printed");
		assert_eq!(String::from_utf8_lossy(&out), "1:start line\n2:middle line\n3:end \n");
	}

	#[test]
	fn files_with_matches_without_display_emits_no_stray_newline() {
		let matcher = RegexMatcherBuilder::new().build("needle").expect("valid");
		let mut out = Vec::new();
		let opts = SearchOptions { files_with_matches: true, ..SearchOptions::default() };
		let mut sink = RgSink::new(&mut out, &matcher, None, &opts, false).expect("sink created");
		sink.any_match = true;
		sink.write_path_with_separator(b"\n").expect("path written");
		assert!(out.is_empty(), "when display is None, nothing is written");
	}
}
