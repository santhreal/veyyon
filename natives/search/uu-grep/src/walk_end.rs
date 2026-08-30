//! How a directory walk ends, decided in one place for both builtins.
//!
//! `grep -r` and `rg` both hand `veyyon-walker` a heartbeat and then have to
//! turn its `Result<WalkStatus, WalkError<_>>` into three things: whether
//! anything was selected, whether the run failed, and what to say on stderr.
//! Each had its own copy of that ladder, and the copies had drifted on all
//! three of the messages they produce:
//!
//! - An interrupted walk printed `grep: operation interrupted` from one and
//!   `rg: native directory scan interrupted: operation interrupted` from the
//!   other. The second names the walker, which is an implementation detail no
//!   operator asked about, and says "interrupted" twice.
//! - A malformed directory printed `grep: <path>: <message>`, which is the
//!   shape every other diagnostic in both tools uses, against `rg: native
//!   directory scan failed for <path>: <message>`.
//! - Cancellation is deliberately SILENT, because the shell wrapper owns the
//!   user-visible cancelled status and a diagnostic here would double it. Both
//!   copies got that right, and keeping it right in two places was luck.
//!
//! The ladder is not a formatting detail. Whether a walk error is silent
//! decides whether a cancelled scan looks like a crash, and both builtins were
//! one edit away from disagreeing about it.

use std::{fmt, io, path::Path};

/// The heartbeat both builtins pass to every walk.
///
/// A walk that does not check this cannot be cancelled: the shell wrapper sets
/// the flag and waits, and a walker with a no-op heartbeat keeps traversing.
/// That was a real bug in both builtins (#3933), fixed twice, which is the
/// argument for the closure having one owner.
pub(crate) fn cancellation_heartbeat() -> impl Fn() -> Result<(), io::Error> {
	|| {
		if veyyon_uutils_ctx::is_cancelled() {
			Err(io::Error::from(io::ErrorKind::Interrupted))
		} else {
			Ok(())
		}
	}
}

/// Why a walk stopped early.
///
/// Two cases and not a `String`, because the first one has no message: it sets
/// the error status and says nothing.
pub(crate) enum WalkFailure {
	/// The harness cancelled the run. Carries NO message on purpose.
	Cancelled,
	/// The walk failed. The payload is the finished stderr line, without a
	/// trailing newline, already prefixed with the tool name.
	Failed(String),
}

/// What a finished walk means to the caller.
///
/// Deliberately three cases and not a `Result`, because the middle one is
/// neither success nor a reportable failure.
pub(crate) enum WalkEnd {
	/// The walk ran out of entries, or a visitor stopped it on purpose.
	Finished,
	/// The harness cancelled the run. Carries NO message on purpose.
	Cancelled,
	/// The walk failed. The payload is the finished stderr line.
	Failed(String),
}

/// Classify a walk ERROR and, when it is reportable, build the line to print.
///
/// Split from [`classify_walk_end`] so a caller holding only an error, which is
/// what `collect_with_heartbeat` hands back, does not have to describe a
/// success it cannot have. The alternative was an `unreachable!` arm in every
/// such caller, which is a state the types can simply refuse to spell.
///
/// `tool` is the name that prefixes a diagnostic, `grep` or `rg`. `for_display`
/// maps the walker's absolute path to the spelling the tool shows for it, which
/// is how `grep` reports a path relative to the operand the user typed; a tool
/// that shows the path as-is passes `Path::to_path_buf`.
pub(crate) fn classify_walk_error<E, F>(
	tool: &str,
	error: veyyon_walker::WalkError<E>,
	for_display: F,
) -> WalkFailure
where
	E: fmt::Display,
	F: FnOnce(&Path) -> std::path::PathBuf,
{
	match error {
		// Cancellation is checked before the error is formatted, because the
		// heartbeat's error IS the cancellation and reporting it would be the
		// tool complaining about being asked to stop.
		veyyon_walker::WalkError::Interrupted(_) if veyyon_uutils_ctx::is_cancelled() => {
			WalkFailure::Cancelled
		},
		veyyon_walker::WalkError::Interrupted(error) => {
			// The inner error and not the `WalkError`, whose `Display` prepends
			// "native directory scan interrupted:" and names the walker.
			WalkFailure::Failed(format!("{tool}: {error}"))
		},
		veyyon_walker::WalkError::InvalidData { path, message } => {
			WalkFailure::Failed(format!("{tool}: {}: {message}", for_display(&path).to_string_lossy()))
		},
	}
}

/// Classify a whole walk result, success included.
pub(crate) fn classify_walk_end<E, F>(
	tool: &str,
	result: Result<veyyon_walker::WalkStatus, veyyon_walker::WalkError<E>>,
	for_display: F,
) -> WalkEnd
where
	E: fmt::Display,
	F: FnOnce(&Path) -> std::path::PathBuf,
{
	match result {
		Ok(veyyon_walker::WalkStatus::Complete | veyyon_walker::WalkStatus::Stopped) => {
			WalkEnd::Finished
		},
		Err(error) => match classify_walk_error(tool, error, for_display) {
			WalkFailure::Cancelled => WalkEnd::Cancelled,
			WalkFailure::Failed(message) => WalkEnd::Failed(message),
		},
	}
}

#[cfg(test)]
mod tests {
	use std::{path::PathBuf, sync::Arc};

	use veyyon_uutils_ctx::{ScopeIo, scope};

	use super::*;

	/// Build a scope whose cancel flag is set or clear, so the cancellation
	/// branch can be exercised without a real walk.
	fn in_scope<T>(cancelled: bool, body: impl FnOnce() -> T) -> T {
		let io = ScopeIo {
			stdin:                 Box::new(io::empty()),
			stdin_fd:              None,
			stdin_is_search_input: false,
			stdout:                Box::new(io::sink()),
			stdout_is_terminal:    false,
			stderr:                Box::new(io::sink()),
			cwd:                   std::env::temp_dir(),
			env:                   std::collections::HashMap::new(),
			cancel:                Arc::new(std::sync::atomic::AtomicBool::new(cancelled)),
		};
		scope(io, body)
	}

	fn interrupted() -> veyyon_walker::WalkError<io::Error> {
		veyyon_walker::WalkError::Interrupted(io::Error::from(io::ErrorKind::Interrupted))
	}

	fn invalid(path: &str) -> veyyon_walker::WalkError<io::Error> {
		veyyon_walker::WalkError::InvalidData {
			path:    PathBuf::from(path),
			message: String::from("malformed directory entry"),
		}
	}

	fn line(end: WalkEnd) -> String {
		match end {
			WalkEnd::Failed(message) => message,
			WalkEnd::Finished => panic!("expected a failure, got Finished"),
			WalkEnd::Cancelled => panic!("expected a failure, got Cancelled"),
		}
	}

	/// Both terminal statuses mean the same thing to a caller: the walk is over
	/// and nothing went wrong. `Stopped` is what a visitor returns for `-q`
	/// after the first match, so treating it as a failure would make every
	/// quiet run exit non-zero.
	#[test]
	fn a_complete_or_deliberately_stopped_walk_is_finished() {
		in_scope(false, || {
			for status in [veyyon_walker::WalkStatus::Complete, veyyon_walker::WalkStatus::Stopped] {
				let end = classify_walk_end::<io::Error, _>("grep", Ok(status), Path::to_path_buf);
				assert!(matches!(end, WalkEnd::Finished), "{status:?} must be Finished");
			}
		});
	}

	/// THE SILENCE CONTRACT. A cancelled walk reports the error status and says
	/// nothing, because the shell wrapper prints the cancelled status itself.
	/// The same `Interrupted` error is a REPORTABLE failure when the flag is
	/// clear, which is the pair that makes the branch meaningful: the error
	/// alone does not decide, the flag does.
	#[test]
	fn cancellation_is_silent_and_the_same_error_is_loud_without_it() {
		in_scope(true, || {
			let end = classify_walk_end("grep", Err(interrupted()), Path::to_path_buf);
			assert!(matches!(end, WalkEnd::Cancelled), "a cancelled walk must not carry a message");
		});
		in_scope(false, || {
			assert_eq!(
				line(classify_walk_end("grep", Err(interrupted()), Path::to_path_buf)),
				"grep: operation interrupted"
			);
		});
	}

	/// A cancelled run is silent whatever the error says, including a malformed
	/// directory arriving in the same instant.
	///
	/// This is the one case the two old copies would have answered differently
	/// had it come up: `InvalidData` is not the `Interrupted` variant, so the
	/// cancellation guard does not catch it and the diagnostic prints. That is
	/// correct and is pinned here on purpose, so the silence contract is not
	/// read as "a cancelled process never prints".
	#[test]
	fn a_malformed_directory_still_reports_while_cancelled() {
		in_scope(true, || {
			assert_eq!(
				line(classify_walk_end("rg", Err(invalid("/tmp/broken")), Path::to_path_buf)),
				"rg: /tmp/broken: malformed directory entry"
			);
		});
	}

	/// THE MESSAGE SHAPE, which is what the two copies had drifted on.
	///
	/// `<tool>: <path>: <message>` is the shape every other diagnostic in both
	/// builtins uses, so a caller parsing stderr sees one format. The walker's
	/// own `Display` is asserted here to be the thing NOT used: it names the
	/// walker and says "failed for", and the old `rg` copy printed it verbatim.
	#[test]
	fn a_failure_names_the_tool_then_the_path_then_the_reason() {
		in_scope(false, || {
			assert_eq!(
				line(classify_walk_end("grep", Err(invalid("/tmp/x")), Path::to_path_buf)),
				"grep: /tmp/x: malformed directory entry"
			);
			assert_eq!(
				line(classify_walk_end("rg", Err(invalid("/tmp/x")), Path::to_path_buf)),
				"rg: /tmp/x: malformed directory entry"
			);

			// What the walker's Display would have produced, and why it is not
			// the diagnostic: it leaks the implementation and reads as prose.
			assert_eq!(
				invalid("/tmp/x").to_string(),
				"native directory scan failed for /tmp/x: malformed directory entry"
			);
			assert_eq!(
				interrupted().to_string(),
				"native directory scan interrupted: operation interrupted"
			);
		});
	}

	/// The display mapping is applied to the path, which is how `grep` shows a
	/// path relative to the operand the user typed instead of the absolute one
	/// the walker produced.
	#[test]
	fn the_reported_path_goes_through_the_callers_display_mapping() {
		in_scope(false, || {
			let end = classify_walk_end("grep", Err(invalid("/abs/root/sub")), |path| {
				PathBuf::from("sub").join(path.file_name().unwrap_or_default())
			});
			assert_eq!(line(end), "grep: sub/sub: malformed directory entry");
		});
	}

	/// The mapping is NOT called when there is no path to map. A closure that
	/// panics proves it, which a closure returning a value could not.
	#[test]
	fn the_display_mapping_is_untouched_when_the_walk_did_not_name_a_path() {
		in_scope(false, || {
			let end = classify_walk_end::<io::Error, _>(
				"grep",
				Ok(veyyon_walker::WalkStatus::Complete),
				|_| panic!("a finished walk must not ask for a display path"),
			);
			assert!(matches!(end, WalkEnd::Finished));
		});
		in_scope(true, || {
			let end = classify_walk_end("grep", Err(interrupted()), |_| {
				panic!("a cancelled walk must not ask for a display path")
			});
			assert!(matches!(end, WalkEnd::Cancelled));
		});
	}

	/// THE HEARTBEAT. It answers the cancel flag and nothing else, and the
	/// error it returns is `Interrupted`, which is the variant
	/// `classify_walk_end` keys its silence off. The two halves have to agree:
	/// a heartbeat returning any other kind would make every cancellation print
	/// a diagnostic.
	#[test]
	fn the_heartbeat_reports_interrupted_only_while_cancelled() {
		in_scope(false, || {
			assert!(cancellation_heartbeat()().is_ok(), "an uncancelled scope must keep walking");
		});
		in_scope(true, || {
			let error = cancellation_heartbeat()().expect_err("a cancelled scope must stop the walk");
			assert_eq!(error.kind(), io::ErrorKind::Interrupted);
			// And that error, fed back through the classifier in the same
			// scope, is silent. This is the round trip the two pieces exist to
			// make: heartbeat error in, no diagnostic out.
			let end =
				classify_walk_end("grep", Err(veyyon_walker::WalkError::Interrupted(error)), |_| {
					panic!("no path is involved")
				});
			assert!(matches!(end, WalkEnd::Cancelled));
		});
	}

	/// THE STRUCTURAL LOCK: this module stays the only owner.
	///
	/// The behaviour above is correct today in one place. What made the old
	/// version wrong was a SECOND place, so the rule worth pinning is that a
	/// third does not appear. Both needles are the shapes the deleted copies
	/// had: the heartbeat's `ErrorKind::Interrupted` construction, and the
	/// walker's own `Display` reaching a diagnostic.
	///
	/// The needles are composed from fragments rather than written out, because
	/// this file would otherwise match every rule it states and the scan would
	/// have to exclude it, which is how a detector quietly stops finding the
	/// real thing.
	#[test]
	fn nothing_else_in_the_crate_builds_a_heartbeat_or_formats_a_walk_error() {
		let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
		let this_file = "walk_end.rs";

		let heartbeat = format!("ErrorKind::{}", "Interrupted");
		let mut offenders = Vec::new();
		for entry in std::fs::read_dir(&dir).expect("the crate source must be readable") {
			let path = entry.expect("a readable directory entry").path();
			if path.extension().is_none_or(|ext| ext != "rs")
				|| path.file_name().is_some_and(|name| name == this_file)
			{
				continue;
			}
			let source = std::fs::read_to_string(&path).expect("a readable source file");
			for (number, text) in source.lines().enumerate() {
				// A comment naming the shape is documentation, not a copy.
				if text.trim_start().starts_with("//") {
					continue;
				}
				if text.contains(&heartbeat) {
					offenders.push(format!(
						"{}:{} builds its own cancellation error",
						path.file_name().unwrap_or_default().to_string_lossy(),
						number + 1
					));
				}
			}
		}
		assert!(
			offenders.is_empty(),
			"call cancellation_heartbeat() instead of rebuilding it:\n{}",
			offenders.join("\n")
		);

		// NON-VACUITY: the scan really reads the files that used to hold the
		// copies. A walker that found nothing would satisfy the assertion above.
		let mut scanned = Vec::new();
		for entry in std::fs::read_dir(&dir).expect("the crate source must be readable") {
			let path = entry.expect("a readable directory entry").path();
			if path.extension().is_some_and(|ext| ext == "rs") {
				scanned.push(
					path
						.file_name()
						.unwrap_or_default()
						.to_string_lossy()
						.into_owned(),
				);
			}
		}
		for expected in ["lib.rs", "rg.rs", this_file] {
			assert!(scanned.iter().any(|name| name == expected), "the scan must read {expected}");
		}
	}

	/// The heartbeat is re-read on every call rather than sampling the flag
	/// once, so a walk that starts before cancellation still stops after it.
	/// A closure that captured the answer at construction time would pass every
	/// test above and never cancel a real walk.
	#[test]
	fn the_heartbeat_is_re_read_and_not_sampled_at_construction() {
		let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
		let io = ScopeIo {
			stdin:                 Box::new(io::empty()),
			stdin_fd:              None,
			stdin_is_search_input: false,
			stdout:                Box::new(io::sink()),
			stdout_is_terminal:    false,
			stderr:                Box::new(io::sink()),
			cwd:                   std::env::temp_dir(),
			env:                   std::collections::HashMap::new(),
			cancel:                Arc::clone(&flag),
		};
		scope(io, || {
			let beat = cancellation_heartbeat();
			assert!(beat().is_ok(), "clear flag, keep going");
			flag.store(true, std::sync::atomic::Ordering::SeqCst);
			assert!(beat().is_err(), "the same closure must observe the flag being set");
		});
	}
}
