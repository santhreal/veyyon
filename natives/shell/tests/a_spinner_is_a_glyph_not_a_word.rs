//! A package named `spinner` is not a spinner.
//!
//! WHAT IT DID. `filters/pkg.rs` classified a line as progress noise when the
//! line CONTAINED the word `"spinner"`, and package managers print package
//! names. `npm WARN deprecated cli-spinners@1.0.0: use ora instead`, `added 1
//! package: spinner`, and every other line naming one of the many packages with
//! `spinner` in the name were deleted from what the agent was shown. A
//! deprecation warning is exactly the line a caller needs.
//!
//! THE RULE NOW. A spinner is a GLYPH. `primitives::is_spinner_frame` is the
//! one owner of that question, and it was already written correctly in
//! `filters/js_tools.rs`, where a frame is a line of nothing but braille
//! spinner characters and spaces. The two filters now ask the same function, so
//! neither can drift.
//!
//! Same class as the docker and wget predicates: a noise test written as a
//! substring match eventually matches program output. See
//! `a_log_line_is_not_docker_chatter.rs` and
//! `a_table_row_is_not_a_download_log.rs`.

use veyyon_shell::minimizer::{MinimizerCtx, filters, primitives};

mod common;

use common::enabled;

mod the_predicate_itself {
	use super::*;

	/// A real frame, in every glyph the spinner cycles through.
	#[test]
	fn a_line_of_braille_glyphs_is_a_frame() {
		for glyph in ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] {
			assert!(primitives::is_spinner_frame(glyph), "{glyph} is a spinner frame");
			assert!(primitives::is_spinner_frame(&format!("  {glyph} ")), "padding does not matter");
		}
	}

	/// A frame with a MESSAGE beside it is not a frame; the message is content.
	#[test]
	fn a_glyph_with_text_beside_it_is_not_a_frame() {
		assert!(!primitives::is_spinner_frame("⠋ installing dependencies"));
		assert!(!primitives::is_spinner_frame("spinner"));
		assert!(!primitives::is_spinner_frame("cli-spinners@1.0.0"));
	}
}

mod what_a_package_manager_printed_survives {
	use super::*;

	/// THE regression. A deprecation warning naming a package with `spinner` in
	/// it is the exact line a caller acts on, and it was being deleted.
	#[test]
	fn a_warning_about_a_package_named_spinner_survives() {
		let config = enabled();
		let ctx = MinimizerCtx {
			program:    "npm",
			subcommand: Some("install"),
			command:    "npm install",
			config:     &config,
		};
		let input = "npm WARN deprecated cli-spinners@1.0.0: use ora instead\nadded 42 packages\n";

		let output = filters::filter(&ctx, input, 0).text;

		assert!(output.contains("cli-spinners@1.0.0"), "the warning survives: {output:?}");
	}

	/// And an ordinary line that merely mentions the word.
	#[test]
	fn a_line_that_mentions_the_word_survives() {
		let config = enabled();
		let ctx = MinimizerCtx {
			program:    "npm",
			subcommand: Some("install"),
			command:    "npm install",
			config:     &config,
		};
		let input = "npm ERR! could not resolve spinner@^2.0.0 from the registry\n";

		let output = filters::filter(&ctx, input, 1).text;

		assert!(output.contains("spinner@^2.0.0"), "{output:?}");
	}
}

mod what_is_still_stripped {
	use super::*;

	/// A real frame is still noise, through the filter rather than through the
	/// predicate, so the strip is proven end to end and not only in the unit.
	#[test]
	fn a_real_frame_is_still_dropped() {
		let config = enabled();
		let ctx = MinimizerCtx {
			program:    "pnpm",
			subcommand: Some("install"),
			command:    "pnpm install",
			config:     &config,
		};
		let input = "⠋\n⠙\n⠹\nadded 42 packages\n";

		let output = filters::filter(&ctx, input, 0).text;

		assert!(!output.contains('⠋'), "the frames go: {output:?}");
		assert!(!output.contains('⠹'), "the frames go: {output:?}");
	}
}
