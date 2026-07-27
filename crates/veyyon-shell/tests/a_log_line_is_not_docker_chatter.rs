//! What a container logged is not what docker logged.
//!
//! WHAT IT DID. `compact_build_or_progress` is the DEFAULT path for `docker`
//! and for `helm install`, `helm upgrade` and `helm lint`, and it dropped every
//! line matching `is_progress_line`. Three of that predicate's rules were bare
//! substring tests: `contains("Waiting")`, `contains("Downloading")`,
//! `contains("Extracting")`. So a container that logged `Waiting for database
//! connection`, a build step that printed `Downloading dependencies`, or a helm
//! hook reporting `Extracting chart` had that line deleted from what the agent
//! was shown. Nothing recorded the drop, and a log with one line missing still
//! reads as a log, which makes an unanchored substring test worse than no
//! filter at all.
//!
//! THE RULE NOW. Every arm is anchored to the shape docker actually prints. A
//! layer status must START the line, after at most one token for the layer id
//! or the service name, and what follows it must be nothing, a meter, or a
//! size. A buildkit line must open with `#` and a step NUMBER. A compose
//! lifecycle line must END with its status. `worker Waiting on queue` fails all
//! three.
//!
//! These are the same defect as the `--` and `://` rule in `filters/cloud.rs`,
//! found the same way: a noise predicate written as a substring test eventually
//! matches program output. See `a_table_row_is_not_a_download_log.rs`.

use veyyon_shell::minimizer::{MinimizerConfig, MinimizerCtx, filters};

mod common;

use common::enabled;

const fn docker<'a>(command: &'a str, config: &'a MinimizerConfig) -> MinimizerCtx<'a> {
	MinimizerCtx { program: "docker", subcommand: Some("build"), command, config }
}

mod what_a_container_logged_survives {
	use super::*;

	/// THE regression. Every one of these is a line an application prints, and
	/// every one of them used to be deleted.
	#[test]
	fn a_word_in_the_middle_of_a_sentence_is_not_a_status() {
		let config = enabled();
		let ctx = docker("docker build .", &config);
		for line in [
			"Waiting for database connection",
			"worker Waiting on queue",
			"Downloading dependencies from the registry",
			"npm: Extracting tarball for lodash",
			"app: Waiting for the lock to be released",
			"Preparing to migrate 4 tables",
		] {
			let input = format!("start\n{line}\nend\n");

			let output = filters::filter(&ctx, &input, 0).text;

			assert!(output.contains(line), "{line:?} was deleted as progress: {output:?}");
		}
	}

	/// A comment or a prompt that begins with `#` is not a buildkit step,
	/// because a step carries a NUMBER. `# DONE` in a shell transcript used to
	/// disappear.
	#[test]
	fn a_hash_without_a_step_number_is_not_a_buildkit_line() {
		let config = enabled();
		let ctx = docker("docker build .", &config);
		let input = "# DONE reviewing the config\n# CACHED means nothing here\nreal output\n";

		let output = filters::filter(&ctx, input, 0).text;

		assert!(output.contains("# DONE reviewing the config"), "{output:?}");
		assert!(output.contains("# CACHED means nothing here"), "{output:?}");
	}

	/// A compose lifecycle line is recognized by its LAST token, so a log line
	/// that opens with the word `Container` keeps its place.
	#[test]
	fn a_line_that_merely_starts_with_container_is_not_a_lifecycle_line() {
		let config = enabled();
		let ctx = docker("docker build .", &config);
		let input = "Container startup logs: Started processing job 4\nreal output\n";

		let output = filters::filter(&ctx, input, 0).text;

		assert!(output.contains("job 4"), "{output:?}");
	}
}

mod what_docker_printed_still_goes {
	use super::*;

	/// The classic per-layer pull, which is the noise the predicate exists for.
	#[test]
	fn a_layer_pull_is_stripped() {
		let config = enabled();
		let ctx = docker("docker pull app", &config);
		let input = "a1b2c3d4e5f6: Pulling fs layer\na1b2c3d4e5f6: Downloading [====>    ]  \
		             1.2MB/3.4MB\na1b2c3d4e5f6: Verifying Checksum\na1b2c3d4e5f6: Download \
		             complete\na1b2c3d4e5f6: Pull complete\nStatus: Downloaded newer image for \
		             app:latest\n";

		let output = filters::filter(&ctx, input, 0).text;

		assert!(!output.contains("Pulling fs layer"), "{output:?}");
		assert!(!output.contains("Download complete"), "{output:?}");
		assert!(!output.contains("[====>"), "{output:?}");
		assert!(
			output.contains("Status: Downloaded newer image for app:latest"),
			"the result line stays: {output:?}",
		);
	}

	/// Compose names the SERVICE where docker names the layer, so the same
	/// statuses arrive with a different prefix and must still go.
	#[test]
	fn a_compose_pull_is_stripped() {
		let config = enabled();
		let ctx = docker("docker compose pull", &config);
		let input = "app Pulling fs layer\napp Downloading\napp Extracting\napp Pull \
		             complete\nStatus: Downloaded newer image for app:latest\n";

		let output = filters::filter(&ctx, input, 0).text;

		assert!(!output.contains("Pulling fs layer"), "{output:?}");
		assert!(!output.contains("app Extracting"), "{output:?}");
		assert!(output.contains("Status: Downloaded"), "{output:?}");
	}

	/// Buildkit steps still go, in all four shapes they come in.
	#[test]
	fn buildkit_steps_are_stripped() {
		let config = enabled();
		let ctx = docker("docker build .", &config);
		let input = "#1 [internal] load build definition from Dockerfile\n#1 transferring \
		             dockerfile: 512B done\n#2 CACHED\n#3 DONE 0.1s\n#4 extracting \
		             sha256:abc\nnaming to docker.io/library/app:latest\n";

		let output = filters::filter(&ctx, input, 0).text;

		assert!(!output.contains("transferring dockerfile"), "{output:?}");
		assert!(!output.contains("#2 CACHED"), "{output:?}");
		assert!(!output.contains("#3 DONE"), "{output:?}");
		assert!(output.contains("naming to docker.io/library/app:latest"), "{output:?}");
	}

	/// And compose's lifecycle lines, which end in their status.
	#[test]
	fn compose_lifecycle_lines_are_stripped() {
		let config = enabled();
		let ctx = docker("docker compose up -d", &config);
		let input = "Container app-db-1  Creating\nContainer app-db-1  Created\nContainer app-db-1  \
		             Healthy\nserver listening on 8080\n";

		let output = filters::filter(&ctx, input, 0).text;

		assert!(!output.contains("Creating"), "{output:?}");
		assert!(!output.contains("Healthy"), "{output:?}");
		assert!(output.contains("server listening on 8080"), "{output:?}");
	}
}

mod the_boundary_stated_as_pairs {
	use super::*;

	/// The same word, once as a status and once inside a sentence, in one
	/// capture. A future change that loosens either anchor breaks exactly one
	/// of these two assertions, which says immediately which direction it went.
	#[test]
	fn the_status_form_goes_and_the_sentence_form_stays() {
		let config = enabled();
		let ctx = docker("docker pull app", &config);
		let input = "app Waiting\nWaiting for the database to accept connections\napp Downloading \
		             [==>  ]\nDownloading the dataset takes a while\n";

		let output = filters::filter(&ctx, input, 0).text;

		assert!(!output.contains("app Waiting"), "the status form goes: {output:?}");
		assert!(!output.contains("app Downloading"), "the status form goes: {output:?}");
		assert!(
			output.contains("Waiting for the database to accept connections"),
			"the sentence stays: {output:?}",
		);
		assert!(output.contains("Downloading the dataset takes a while"), "{output:?}");
	}

	/// A status followed by a size is still a status, which is how `Retrying in
	/// 5 seconds` and a bare meter both arrive.
	#[test]
	fn a_status_followed_by_a_number_is_still_a_status() {
		let config = enabled();
		let ctx = docker("docker pull app", &config);
		let input = "a1b2: Retrying in 5 seconds\na1b2: Downloading 1.2MB/3.4MB\nkeep me\n";

		let output = filters::filter(&ctx, input, 0).text;

		assert!(!output.contains("Retrying in"), "{output:?}");
		assert!(!output.contains("1.2MB"), "{output:?}");
		assert!(output.contains("keep me"), "{output:?}");
	}
}

mod helm_reaches_the_same_predicate {
	use super::*;

	/// `helm install`, `upgrade` and `lint` share this path, so the fix has to
	/// be checked through them as well: a chart that prints one of these words
	/// in a message was losing the line just as a container was.
	#[test]
	fn a_helm_message_is_not_progress() {
		let config = enabled();
		for subcommand in ["install", "upgrade", "lint"] {
			let command = format!("helm {subcommand} app ./chart");
			let ctx = MinimizerCtx {
				program:    "helm",
				subcommand: Some(subcommand),
				command:    &command,
				config:     &config,
			};
			let input = "NOTES:\nWaiting for the ingress to obtain an address\nDownloading the CRDs \
			             is not required\n";

			let output = filters::filter(&ctx, input, 0).text;

			assert!(
				output.contains("Waiting for the ingress to obtain an address"),
				"helm {subcommand}: {output:?}",
			);
			assert!(
				output.contains("Downloading the CRDs is not required"),
				"helm {subcommand}: {output:?}"
			);
		}
	}
}
