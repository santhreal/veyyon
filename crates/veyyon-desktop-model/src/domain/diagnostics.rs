//! The host's diagnostics payload, read as rows (§5.9).
//!
//! The host reports diagnostics as free-form JSON, so one reader states what
//! a source is: its name, the status it is in, and the sentence it came with.
//! Which source offers to be re-run is decided here too, because the page
//! that draws the `Retry` and the projection that gates it must agree -- a
//! gate for a control the page draws under another rule is a control reading
//! an availability nothing set.

use serde_json::Value;

/// One row of the host's diagnostics payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiagnosticSource<'a> {
	/// What the host calls this source.
	pub name:    &'a str,
	/// The state the host reports it in: `ok`, `warning`, `error`,
	/// `disabled`, or anything else it sends.
	pub status:  &'a str,
	/// The sentence the host sent with it, from `message` or `last_error`.
	pub message: Option<&'a str>,
}

impl DiagnosticSource<'_> {
	/// Whether this source is one the page offers to run again.
	#[must_use]
	pub fn offers_retry(&self) -> bool {
		self.status == "error"
	}
}

/// Every source the host's diagnostics payload names, in the order it sent
/// them. A payload with no `sources` array names none.
#[must_use]
pub fn diagnostic_sources(diagnostics: Option<&Value>) -> Vec<DiagnosticSource<'_>> {
	diagnostics
		.and_then(|payload| payload.get("sources"))
		.and_then(Value::as_array)
		.map(|sources| sources.iter().map(source_row).collect())
		.unwrap_or_default()
}

/// One source's row, with the fields it did not send read as unknown.
fn source_row(source: &Value) -> DiagnosticSource<'_> {
	DiagnosticSource {
		name:    source
			.get("name")
			.and_then(Value::as_str)
			.unwrap_or("Unknown"),
		status:  source
			.get("status")
			.and_then(Value::as_str)
			.unwrap_or("unknown"),
		message: source
			.get("message")
			.and_then(Value::as_str)
			.or_else(|| source.get("last_error").and_then(Value::as_str)),
	}
}
