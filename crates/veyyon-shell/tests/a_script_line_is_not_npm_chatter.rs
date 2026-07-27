//! What a build script logged is not what npm logged.
//!
//! WHY THIS FILTER SEES SCRIPT OUTPUT AT ALL. `npm run build` routes to the
//! package-manager filter, so everything a build script prints is judged by
//! rules written for npm's own chatter. That is fine as long as each rule
//! describes a line npm actually writes, and it stops being fine the moment a
//! rule is a bare substring test.
//!
//! WHAT IT DID. `is_js_package_noise` dropped any line containing `up to date`.
//! npm writes `up to date, audited 5 packages in 1s`, so the phrase opens ITS
//! line, but a build script logging `cache is up to date, rebuilding anyway`
//! had that line deleted from what the agent was shown.
//!
//! THE RULE NOW. `is_up_to_date_line` requires the phrase to open the line,
//! after at most yarn's `success ` marker, which is the only prefix a package
//! manager puts in front of it.
//!
//! Same class as the docker, wget and spinner predicates. See
//! `a_log_line_is_not_docker_chatter.rs`,
//! `a_table_row_is_not_a_download_log.rs` and `a_spinner_is_a_glyph_not_a_word.
//! rs`.

use veyyon_shell::minimizer::{MinimizerConfig, MinimizerCtx, filters};

fn enabled() -> MinimizerConfig {
	MinimizerConfig { enabled: true, ..Default::default() }
}

fn npm<'a>(subcommand: &'a str, command: &'a str, config: &'a MinimizerConfig) -> MinimizerCtx<'a> {
	MinimizerCtx { program: "npm", subcommand: Some(subcommand), command, config }
}

mod what_a_script_logged_survives {
	use super::*;

	/// THE regression: the phrase in the middle of a script's own sentence.
	#[test]
	fn a_sentence_containing_the_phrase_survives() {
		let config = enabled();
		let ctx = npm("run", "npm run build", &config);
		for line in [
			"cache is up to date, rebuilding anyway",
			"checking whether the lockfile is up to date",
			"the generated client is already up-to-date with the schema",
		] {
			let input = format!("build started\n{line}\nbuild finished\n");

			let output = filters::filter(&ctx, &input, 0).text;

			assert!(output.contains(line), "{line:?} was deleted as npm chatter: {output:?}");
		}
	}
}

mod what_npm_printed_is_handled_as_before {
	use super::*;

	/// npm's OWN no-op line is kept, once. It is the install signal: it says the
	/// lockfile and `node_modules` agree, and a caller reading a capture with
	/// it removed cannot tell that from a capture where npm said nothing.
	/// `is_js_install_summary` claims it before any strip rule sees it, and
	/// this asserts the anchoring change did not disturb that.
	#[test]
	fn npms_own_up_to_date_line_is_kept_once() {
		let config = enabled();
		let ctx = npm("install", "npm install", &config);
		let input = "up to date, audited 5 packages in 1s\nup to date, audited 5 packages in \
		             1s\nreal output\n";

		let output = filters::filter(&ctx, input, 0).text;

		assert_eq!(
			output
				.lines()
				.filter(|line| line.contains("audited 5 packages"))
				.count(),
			1,
			"kept once, not twice: {output:?}",
		);
		assert!(output.contains("real output"), "{output:?}");
	}

	/// yarn writes the same thing behind a `success ` marker, and that is the
	/// one prefix the rule allows in front of the phrase. It is kept for the
	/// same reason, and the marker is what proves the prefix is handled rather
	/// than accidentally ignored.
	#[test]
	fn yarns_success_marked_line_is_kept_once() {
		let config = enabled();
		let ctx = MinimizerCtx {
			program:    "yarn",
			subcommand: Some("install"),
			command:    "yarn install",
			config:     &config,
		};
		let input = "success Already up-to-date.\nsuccess Already up-to-date.\nreal output\n";

		let output = filters::filter(&ctx, input, 0).text;

		assert_eq!(
			output
				.lines()
				.filter(|line| line.contains("Already up-to-date"))
				.count(),
			1,
			"kept once, not twice: {output:?}",
		);
	}

	/// AND THE ASYMMETRY THAT MADE THIS A DEFECT. The keep rule and the strip
	/// rule ask the same question through the same function now. While they
	/// disagreed, the strip rule was the broader of the two, so the only lines
	/// it could reach were the ones the keep rule had already declined: script
	/// sentences with the phrase in the middle.
	#[test]
	fn a_sentence_is_neither_kept_as_a_summary_nor_stripped_as_noise() {
		let config = enabled();
		let ctx = npm("install", "npm install", &config);
		let input = "up to date, audited 5 packages in 1s\nthe lockfile is up to date with \
		             package.json\nreal output\n";

		let output = filters::filter(&ctx, input, 0).text;

		assert!(output.contains("the lockfile is up to date with package.json"), "{output:?}");
		assert!(output.contains("audited 5 packages"), "{output:?}");
	}
}
