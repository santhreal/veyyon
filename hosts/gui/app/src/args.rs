//! Command-line arguments.
//!
//! Parsed by hand rather than with a parser crate: there are five flags, none
//! of them positional, and the whole grammar fits in one match. A dependency
//! here would be larger than the thing it parses.
//!
//! Every flag exists because a capture needs it. `--width`/`--height` fix the
//! window so a Before and an After frame are the same size, `--theme` seeds the
//! palette before the window opens rather than toggling it afterwards, and
//! `--exit-after` ends the process so a recorder can wait on it instead of
//! guessing.

use veyyon_gui_contract::screen::RouteId;
use veyyon_gui_theme::builtin;

pub const USAGE: &str = "\
usage: veyyon-gui [options]

  --theme <name>       open with a bundled theme
  --list-themes        print every bundled theme name and exit
  --route <key>        open on a screen: session, pick, form, board, report,
                       tree, splash, wizard, diff
  --list-routes        print every route key and exit
  --dialog <index>     open with a fixture dialog on top
  --sidebar <on|off>   open with the thread list revealed, default on
  --terminal <on|off>  open with the bottom panel revealed, default off
  --width <px>         window width, default 1440
  --height <px>        window height, default 900
  --exit-after <ms>    quit after this long, for a capture
  --help               print this and exit";

/// What the process should do with its arguments.
pub enum Outcome {
	/// Open a window.
	Run(Arguments),
	/// Print this and exit successfully.
	Printed(String),
}

/// A parsed command line.
#[derive(Debug, Clone, PartialEq)]
pub struct Arguments {
	pub theme:         Option<String>,
	pub route:         RouteId,
	pub dialog:        Option<usize>,
	pub sidebar:       bool,
	pub terminal:      bool,
	pub width:         f32,
	pub height:        f32,
	pub exit_after_ms: Option<u64>,
}

impl Default for Arguments {
	fn default() -> Arguments {
		Arguments {
			theme:         None,
			route:         RouteId::Session,
			dialog:        None,
			sidebar:       true,
			terminal:      false,
			width:         1440.0,
			height:        900.0,
			exit_after_ms: None,
		}
	}
}

impl Arguments {
	/// Parse arguments, without the program name.
	///
	/// An unknown flag is an error rather than a warning: a mistyped flag in a
	/// capture script would otherwise produce a frame of the default state and
	/// look like the feature not working.
	pub fn parse(arguments: impl IntoIterator<Item = String>) -> Result<Outcome, String> {
		let mut parsed = Arguments::default();
		let mut rest = arguments.into_iter();

		while let Some(argument) = rest.next() {
			match argument.as_str() {
				"--help" | "-h" => return Ok(Outcome::Printed(USAGE.to_owned())),
				"--list-themes" => {
					return Ok(Outcome::Printed(builtin::names().collect::<Vec<_>>().join("\n")));
				},
				"--list-routes" => {
					return Ok(Outcome::Printed(route_keys()));
				},
				"--theme" => parsed.theme = Some(value(&argument, &mut rest)?),
				"--route" => parsed.route = route(&argument, &mut rest)?,
				"--dialog" => parsed.dialog = Some(number(&argument, &mut rest)?),
				"--sidebar" => parsed.sidebar = switch(&argument, &mut rest)?,
				"--terminal" => parsed.terminal = switch(&argument, &mut rest)?,
				"--width" => parsed.width = dimension(&argument, &mut rest)?,
				"--height" => parsed.height = dimension(&argument, &mut rest)?,
				"--exit-after" => parsed.exit_after_ms = Some(number(&argument, &mut rest)?),
				other => return Err(format!("unknown argument {other}")),
			}
		}
		Ok(Outcome::Run(parsed))
	}
}

/// The value after a flag.
fn value(flag: &str, rest: &mut impl Iterator<Item = String>) -> Result<String, String> {
	rest.next().ok_or_else(|| format!("{flag} needs a value"))
}

/// Every route key, one per line.
fn route_keys() -> String {
	RouteId::ALL
		.into_iter()
		.map(|id| id.key().to_owned())
		.collect::<Vec<_>>()
		.join("\n")
}

/// A route by key.
///
/// The error lists every key rather than only rejecting the one given: a
/// capture script names a route by hand, and a message that says only "unknown"
/// sends the reader to the source for a list the binary already has.
fn route(flag: &str, rest: &mut impl Iterator<Item = String>) -> Result<RouteId, String> {
	let raw = value(flag, rest)?;
	RouteId::parse(&raw).ok_or_else(|| {
		format!("{flag} needs one of: {}, got {raw}", route_keys().replace('\n', ", "))
	})
}

/// An on/off flag.
///
/// Spelled out rather than a bare `--sidebar` that means "on", because both
/// arms of a differential are named explicitly in the capture script. A script
/// that says one arm by its presence and the other by its absence is a script
/// whose two arms do not read as a pair.
fn switch(flag: &str, rest: &mut impl Iterator<Item = String>) -> Result<bool, String> {
	let raw = value(flag, rest)?;
	match raw.as_str() {
		"on" | "true" | "1" => Ok(true),
		"off" | "false" | "0" => Ok(false),
		other => Err(format!("{flag} needs on or off, got {other}")),
	}
}

/// A non-negative integer after a flag.
fn number<T: std::str::FromStr>(
	flag: &str,
	rest: &mut impl Iterator<Item = String>,
) -> Result<T, String> {
	let raw = value(flag, rest)?;
	raw.parse()
		.map_err(|_| format!("{flag} needs a whole number, got {raw}"))
}

/// A window dimension: a positive number of pixels.
///
/// Zero and negative are rejected rather than clamped, because a window of no
/// size opens and draws nothing, which reads as the shell being broken.
fn dimension(flag: &str, rest: &mut impl Iterator<Item = String>) -> Result<f32, String> {
	let raw = value(flag, rest)?;
	let parsed: f32 = raw
		.parse()
		.map_err(|_| format!("{flag} needs a number, got {raw}"))?;
	if parsed.is_finite() && parsed > 0.0 {
		return Ok(parsed);
	}
	Err(format!("{flag} needs a positive number of pixels, got {raw}"))
}

/// WHY THIS SUITE EXISTS.
///
/// These arguments drive the capture harness, so a parsing defect shows up as a
/// frame of the wrong state rather than as an error — a `--theme` whose value
/// was swallowed, a `--width` that clamped to nothing, an unknown flag ignored.
/// Each of those produces a plausible-looking screenshot of the wrong thing.
///
/// WHAT IT DOES NOT CATCH. Whether a flag reaches the window: `--width` being
/// parsed is not `--width` being applied. That is the app's own capture.
#[cfg(test)]
mod tests {
	use super::*;

	fn run(arguments: &[&str]) -> Result<Arguments, String> {
		match Arguments::parse(arguments.iter().map(|it| (*it).to_owned()))? {
			Outcome::Run(parsed) => Ok(parsed),
			Outcome::Printed(text) => Err(format!("printed instead of running: {text}")),
		}
	}

	fn printed(arguments: &[&str]) -> String {
		match Arguments::parse(arguments.iter().map(|it| (*it).to_owned())).expect("parses") {
			Outcome::Printed(text) => text,
			Outcome::Run(_) => panic!("ran instead of printing"),
		}
	}

	/// No arguments is the default window, and the defaults are a fixed size so
	/// two captures taken a week apart are comparable.
	#[test]
	fn no_arguments_is_a_fixed_default_window() {
		let parsed = run(&[]).expect("an empty command line parses");
		assert_eq!(parsed, Arguments::default());
		assert_eq!((parsed.width, parsed.height), (1440.0, 900.0));
		assert!(parsed.theme.is_none() && parsed.dialog.is_none() && parsed.exit_after_ms.is_none());
	}

	/// Every flag takes its value, and the flags compose in one command line.
	#[test]
	fn every_flag_takes_its_value() {
		let parsed = run(&[
			"--theme",
			"dark-gruvbox",
			"--dialog",
			"2",
			"--width",
			"960",
			"--height",
			"600",
			"--exit-after",
			"1500",
		])
		.expect("a full command line parses");

		assert_eq!(parsed.theme.as_deref(), Some("dark-gruvbox"));
		assert_eq!(parsed.dialog, Some(2));
		assert_eq!((parsed.width, parsed.height), (960.0, 600.0));
		assert_eq!(parsed.exit_after_ms, Some(1500));
	}

	/// A later flag wins over an earlier one, so a capture script can append an
	/// override to a shared argument list.
	#[test]
	fn a_later_flag_overrides_an_earlier_one() {
		let parsed = run(&["--theme", "dark", "--theme", "light"]).expect("parses");
		assert_eq!(parsed.theme.as_deref(), Some("light"));
	}

	/// A flag with no value is an error rather than a default. Swallowing it
	/// would silently capture the default state.
	#[test]
	fn a_flag_without_a_value_is_an_error() {
		for flag in ["--theme", "--dialog", "--width", "--height", "--exit-after"] {
			let error = run(&[flag]).expect_err("a bare flag is rejected");
			assert!(error.contains(flag), "{error} does not name {flag}");
		}
	}

	/// A value of the wrong shape is an error, and the message carries the value
	/// so the operator can see what was passed.
	#[test]
	fn a_malformed_value_is_an_error() {
		let error = run(&["--dialog", "first"]).expect_err("a word is not an index");
		assert!(error.contains("first"));

		let error = run(&["--dialog", "-1"]).expect_err("a negative index is rejected");
		assert!(error.contains("-1"));

		let error = run(&["--width", "wide"]).expect_err("a word is not a width");
		assert!(error.contains("wide"));
	}

	/// A window of no size is rejected. It opens, draws nothing, and reads as
	/// the shell failing rather than the argument being wrong.
	#[test]
	fn a_window_with_no_size_is_rejected() {
		for value in ["0", "-100", "nan", "-0"] {
			let error = run(&["--width", value]).expect_err("{value} was accepted as a width");
			assert!(error.contains(value), "{error} does not name {value}");
		}
		// Infinity parses as a float and is not a window.
		assert!(run(&["--height", "inf"]).is_err());
	}

	/// An unknown flag is an error naming the flag, so a typo in a capture
	/// script fails rather than producing a frame of the default state.
	#[test]
	fn an_unknown_flag_is_an_error() {
		let error = run(&["--them", "dark"]).expect_err("a typo is rejected");
		assert!(error.contains("--them"));

		let error = run(&["dark"]).expect_err("a bare value is rejected");
		assert!(error.contains("dark"));
	}

	/// `--help` and `--list-themes` print and stop, and the theme list is the
	/// bundled set rather than a hardcoded one.
	#[test]
	fn help_and_the_theme_list_print_and_stop() {
		assert!(printed(&["--help"]).contains("--exit-after"));
		assert!(printed(&["-h"]).contains("usage:"));

		let list = printed(&["--list-themes"]);
		let names: Vec<&str> = list.lines().collect();
		assert_eq!(names.len(), builtin::names().count());
		assert!(names.contains(&builtin::DEFAULT), "the default theme is not in the list");
	}

	/// A printing flag wins wherever it appears, so `--list-themes` after a bad
	/// flag still prints — and a bad flag before it does not open a window.
	#[test]
	fn a_printing_flag_stops_at_the_point_it_appears() {
		assert!(printed(&["--theme", "dark", "--list-themes"]).contains(builtin::DEFAULT));
		assert!(Arguments::parse(["--nope".to_owned(), "--help".to_owned()]).is_err());
	}
}
