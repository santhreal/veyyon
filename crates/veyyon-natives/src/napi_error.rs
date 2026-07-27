//! One place where a Rust error becomes the message a JavaScript caller reads.
//!
//! Every fallible export in this crate ends at `napi::Error`, and before this
//! module each one built that error itself. 86 call sites across sixteen
//! modules, and the two shapes underneath them were written out by hand every
//! time: `Error::from_reason(err.to_string())` when the error's own message is
//! the whole story, and `Error::from_reason(format!("<context>: {err}"))` when
//! the caller needs to know which operation produced it. Fifteen copies of the
//! first and thirty-four of the second, so the convention that a wrapped
//! message reads `context, colon, space, reason` lived in nobody's code and
//! could not be checked.
//!
//! The two helpers here are that convention, and they produce byte-identical
//! messages to what the call sites built, because the message a JS caller sees
//! is a contract: `packages/coding-agent` matches on some of these strings.
//!
//! What is deliberately NOT here: a mapper that swallows the context. A message
//! such as `Failed to resolve cwd: <io error>` says which operation failed and
//! is worth more than the reason alone, so [`to_napi_with`] keeps that context
//! rather than collapsing every failure into its `Display` (Law: an error
//! message carries context and the fix). Composed messages that are not
//! `context: reason` -- a path in the middle, two values joined -- stay written
//! out where they are made, since there is no shape for a helper to own.
//!
//! Status: every error from this module is `Status::GenericFailure`, which is
//! what `from_reason` sets and what `napi` turns into a plain JavaScript
//! `Error`. The one place in the crate that chooses a status explicitly is the
//! panic-unwind path in `task.rs`, and it names `GenericFailure` for the same
//! reason.

use std::fmt::Display;

use napi::Error;

/// The error's own message, unchanged.
///
/// For the case where the failing operation is obvious from the export the
/// caller invoked, so the reason alone is the whole message. `veyyon-glob`'s
/// `compile_glob` is the example: its message already names the pattern and the
/// syntax problem, and prefixing it with `Failed to compile glob` would say the
/// same thing twice.
pub fn to_napi(err: impl Display) -> Error {
	Error::from_reason(err.to_string())
}

/// The error's message behind `context`, as `context: reason`.
///
/// `context` says what the crate was doing, in the words a caller would use for
/// it, and takes anything printable so a path can be the context without being
/// formatted into a string first.
pub fn to_napi_with(context: impl Display, err: impl Display) -> Error {
	Error::from_reason(format!("{context}: {err}"))
}

#[cfg(test)]
mod tests {
	use std::{fmt, io, path::Path};

	use napi::Status;

	use super::*;

	/// An error whose message is exactly what the test wrote, so an assertion is
	/// about the mapping rather than about someone else's wording.
	struct Spelled(&'static str);

	impl fmt::Display for Spelled {
		fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
			f.write_str(self.0)
		}
	}

	/// The unwrapped mapping is the identity on the message.
	///
	/// Asserted as the whole string rather than with `contains`, because the
	/// failure this locks out is a helper that decorates: a `Native error: `
	/// prefix added here would change fifteen messages at once, and
	/// `packages/coding-agent` matches on some of them.
	#[test]
	fn to_napi_keeps_the_reason_exactly() {
		assert_eq!(
			to_napi(Spelled("unsupported language: cobol")).reason,
			"unsupported language: cobol"
		);
	}

	/// Including the awkward ones: an empty message stays empty rather than
	/// becoming a placeholder, and internal newlines survive, since a multi-line
	/// reason is what a parser error looks like.
	#[test]
	fn to_napi_keeps_an_empty_or_multiline_reason_as_it_is() {
		assert_eq!(to_napi(Spelled("")).reason, "");
		assert_eq!(to_napi(Spelled("line one\nline two")).reason, "line one\nline two");
	}

	/// A real `io::Error`, which is the type most of these sites carry, and its
	/// message is the operating system's rather than ours.
	#[test]
	fn to_napi_carries_an_io_errors_own_words() {
		let err = io::Error::new(io::ErrorKind::NotFound, "no such file or directory");
		assert_eq!(to_napi(&err).reason, "no such file or directory");
	}

	/// The wrapped shape: context, colon, space, reason. One space, and no
	/// trailing punctuation.
	#[test]
	fn to_napi_with_joins_the_context_and_the_reason_with_one_colon_and_space() {
		assert_eq!(
			to_napi_with("Failed to resolve cwd", Spelled("permission denied")).reason,
			"Failed to resolve cwd: permission denied"
		);
	}

	/// The context does not have to be a string, which is why it takes
	/// `Display`: a path is a context and formatting it at every call site is
	/// how `{}: {err}` got written out by hand.
	#[test]
	fn to_napi_with_takes_any_printable_context() {
		let path = Path::new("/tmp/a.rs");
		assert_eq!(
			to_napi_with(path.display(), Spelled("parse error")).reason,
			"/tmp/a.rs: parse error"
		);
		assert_eq!(to_napi_with(7, Spelled("bad index")).reason, "7: bad index");
	}

	/// An empty context still produces the separator rather than silently
	/// dropping it, so a caller passing an empty string sees the mistake instead
	/// of getting an unwrapped message that looks correct.
	#[test]
	fn to_napi_with_does_not_hide_an_empty_context() {
		assert_eq!(to_napi_with("", Spelled("reason")).reason, ": reason");
	}

	/// Both helpers produce `GenericFailure`, which is what the whole crate's
	/// convention has always been and what `napi` turns into a plain JS `Error`.
	/// Pinned because a status change is invisible in Rust and changes the class
	/// of the exception a JS caller catches.
	#[test]
	fn both_helpers_report_a_generic_failure() {
		assert_eq!(to_napi(Spelled("x")).status, Status::GenericFailure);
		assert_eq!(to_napi_with("y", Spelled("x")).status, Status::GenericFailure);
	}

	/// And they agree with what the call sites used to build, which is the whole
	/// claim of the refactor: the same bytes, from one place.
	#[test]
	fn the_helpers_match_the_expressions_they_replaced() {
		let err = Spelled("boom");
		assert_eq!(to_napi(&err).reason, Error::from_reason(err.to_string()).reason);
		assert_eq!(
			to_napi_with("Search failed", &err).reason,
			Error::from_reason(format!("Search failed: {err}")).reason
		);
	}
}
