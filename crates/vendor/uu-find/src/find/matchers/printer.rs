// Copyright 2017 Google Inc.
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

use std::{fs::File, io::Write};

use veyyon_uutils_ctx::stderr;

use super::{Matcher, MatcherIO, WalkEntry};

pub enum PrintDelimiter {
	Newline,
	Null,
}

impl std::fmt::Display for PrintDelimiter {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Newline => writeln!(f),
			Self::Null => write!(f, "\0"),
		}
	}
}

/// This matcher just prints the name of the file to stdout.
pub struct Printer {
	delimiter:   PrintDelimiter,
	output_file: Option<File>,
}

impl Printer {
	pub fn new(delimiter: PrintDelimiter, output_file: Option<File>) -> Self {
		Self { delimiter, output_file }
	}

	fn print(
		&self,
		file_info: &WalkEntry,
		matcher_io: &mut MatcherIO,
		mut out: impl Write,
		print_error_message: bool,
	) {
		match write!(out, "{}{}", file_info.display_path().to_string_lossy(), self.delimiter) {
			Ok(_) => {},
			Err(e) => {
				if print_error_message {
					// Reporting a write failure must not itself be a write that can
					// panic: stderr is a pipe too, and both ends close together.
					let _ = writeln!(
						&mut stderr(),
						"Error writing {:?} for {}",
						file_info.display_path().to_string_lossy(),
						e
					);
					matcher_io.set_exit_code(1);
				}
			},
		}
		// `find … | head` closes the pipe under us, which is ordinary use and not a
		// fault. This used to `.unwrap()`, so the flush after an already-reported
		// write error aborted the whole worker with a BrokenPipe panic.
		let _ = out.flush();
	}
}

impl Matcher for Printer {
	fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
		if let Some(file) = &self.output_file {
			self.print(file_info, matcher_io, file, true);
		} else {
			self.print(file_info, matcher_io, &mut *matcher_io.deps.get_output().borrow_mut(), false);
		}
		true
	}

	fn has_side_effects(&self) -> bool {
		true
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::find::{
		matchers::tests::get_dir_entry_for,
		tests::{FakeDependencies, fix_up_slashes},
	};

	#[test]
	fn prints_newline() {
		let abbbc = get_dir_entry_for("./test_data/simple", "abbbc");

		let matcher = Printer::new(PrintDelimiter::Newline, None);
		let deps = FakeDependencies::new();
		assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));
		assert_eq!(fix_up_slashes("./test_data/simple/abbbc\n"), deps.get_output_as_string());
	}

	#[test]
	fn prints_null() {
		let abbbc = get_dir_entry_for("./test_data/simple", "abbbc");

		let matcher = Printer::new(PrintDelimiter::Null, None);
		let deps = FakeDependencies::new();
		assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));
		assert_eq!(fix_up_slashes("./test_data/simple/abbbc\0"), deps.get_output_as_string());
	}

	/// WHY: `find … | head -1` closes the pipe while find is still walking. That
	/// is ordinary use, but every write on this print path used to `.unwrap()`,
	/// so the failure arrived as a BrokenPipe PANIC that aborted the worker
	/// thread instead of a write error the matcher already knows how to report.
	///
	/// The class this closes: on a sink that fails every write and every flush,
	/// a print path returns, reports through its normal channel, and does not
	/// panic. `Printf` is covered by the twin test in `printf.rs`.
	///
	/// What it does not catch: a NEW matcher that prints with `.unwrap()`.
	/// Nothing here enumerates print paths, because they share no trait method
	/// that writes.
	struct ClosedPipe;

	impl Write for ClosedPipe {
		fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
			Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "closed"))
		}

		fn flush(&mut self) -> std::io::Result<()> {
			Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "closed"))
		}
	}

	#[test]
	fn reports_a_closed_pipe_instead_of_panicking() {
		let abbbc = get_dir_entry_for("./test_data/simple", "abbbc");
		let matcher = Printer::new(PrintDelimiter::Newline, None);
		let deps = FakeDependencies::new();
		let mut matcher_io = deps.new_matcher_io();

		matcher.print(&abbbc, &mut matcher_io, ClosedPipe, true);

		// The write failed and said so through the matcher, rather than unwinding.
		assert_eq!(1, matcher_io.exit_code());
	}

	#[test]
	fn stays_silent_about_a_closed_pipe_when_asked_to() {
		let abbbc = get_dir_entry_for("./test_data/simple", "abbbc");
		let matcher = Printer::new(PrintDelimiter::Newline, None);
		let deps = FakeDependencies::new();
		let mut matcher_io = deps.new_matcher_io();

		matcher.print(&abbbc, &mut matcher_io, ClosedPipe, false);

		assert_eq!(0, matcher_io.exit_code());
	}

	#[test]
	#[cfg(target_os = "linux")]
	fn prints_error_message() {
		let dev_full = File::open("/dev/full").unwrap();
		let abbbc = get_dir_entry_for("./test_data/simple", "abbbc");

		let matcher = Printer::new(PrintDelimiter::Newline, Some(dev_full));
		let deps = FakeDependencies::new();

		assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));
		assert!(deps.get_output_as_string().is_empty());
	}
}
