//! Builders for composer scenes across conversational lifecycle phases (§5.4).

use veyyon_desktop_model::{
	BadgeKind, ConnectionState, InputModality, ModelRef, ModelView, ModelsView, QueueMode,
	QueuePartition,
};
use veyyon_desktop_surface::{
	Overlay, PaletteMode, PaletteState, TurnPhase,
	composer::{ModelChoice, ModelControl, ModelOption, ThinkingControl, ThinkingLevel},
	palette::PaletteItem,
};

use crate::scene::seed::{Built, Seed};

/// Typing draft text into single-line composer.
pub fn composer_typing() -> Built {
	let mut seed = Seed::attached();
	seed.session(QueuePartition::Live);
	let mut built = seed.finish();
	built.composer_text = "Refactor the authentication flow to use session cookies".to_string();
	built
}

/// Multi-line draft expanding composer pill to ~110px.
pub fn composer_multiline() -> Built {
	let mut seed = Seed::attached();
	seed.session(QueuePartition::Live);
	let mut built = seed.finish();
	built.composer_text = "Refactor the authentication flow:\n- Migrate tokens to secure \
	                       cookies\n- Add session refresh endpoint"
		.to_string();
	built
}

/// 10 lines of text at maximum growth cap (200px) with internal scroll.
pub fn composer_max_height() -> Built {
	let mut seed = Seed::attached();
	seed.session(QueuePartition::Live);
	let mut built = seed.finish();
	built.composer_text = "1. Initialize authentication subsystem\n2. Validate token storage \
	                       backend\n3. Check session expiration policy\n4. Configure refresh \
	                       cookie rotation\n5. Implement bearer token exchange\n6. Handle \
	                       signature verification failures\n7. Audit authorization middleware \
	                       hooks\n8. Add integration tests for revocation\n9. Verify telemetry \
	                       events are emitted\n10. Update migration guide documentation"
		.to_string();
	built
}

/// Mid-turn steering mode with Abort and Steer action buttons.
pub fn composer_steering() -> Built {
	let mut seed = Seed::attached();
	let session = seed.badged_session(QueuePartition::Live, BadgeKind::Working);
	seed.exchange(&session, Seed::prose());
	seed.stream(&session, "bash");
	let mut built = seed.finish();
	built.state.turn = TurnPhase::Running { queue_mode: QueueMode::Steer };
	built.composer_text = "Steer the current turn: check error handling too".to_string();
	built
}

/// Mid-turn aborting state with active stop control.
pub fn composer_aborting() -> Built {
	let mut seed = Seed::attached();
	let session = seed.badged_session(QueuePartition::Live, BadgeKind::Working);
	seed.exchange(&session, Seed::prose());
	seed.stream(&session, "bash");
	let mut built = seed.finish();
	built.state.turn = TurnPhase::Running { queue_mode: QueueMode::Queue };
	built.composer_text = "Queue follow-up: run migration verification".to_string();
	built
}

/// Disabled composer while disconnected.
pub fn composer_disconnected() -> Built {
	let mut seed = Seed::connection(ConnectionState::Connecting { attempt: 2 });
	seed.session(QueuePartition::Live);
	let mut built = seed.finish();
	built.composer_text = "Draft composed while offline".to_string();
	built
}

/// Composer showing refusal notice and error state.
pub fn composer_error() -> Built {
	let mut seed = Seed::attached();
	seed.session(QueuePartition::Live);
	let mut built = seed.finish();
	built.composer_text = "Attach unsupported media stream".to_string();
	built.notice = Some("The active model does not accept audio attachments".to_string());
	built
}

/// Anchored model selector popover above composer.
pub fn composer_model_selector() -> Built {
	let mut seed = Seed::attached();
	seed.session(QueuePartition::Live);
	seed.store.domains.models = Some(ModelsView {
		models:          vec![
			ModelView {
				provider:       "anthropic".to_string(),
				id:             "claude-sonnet-4.5".to_string(),
				name:           "Claude Sonnet 4.5".to_string(),
				reasoning:      true,
				context_window: 200_000,
				max_output:     64_000,
				input:          vec![InputModality::Text, InputModality::Image],
			},
			ModelView {
				provider:       "openai".to_string(),
				id:             "gpt-5".to_string(),
				name:           "GPT-5".to_string(),
				reasoning:      true,
				context_window: 256_000,
				max_output:     32_000,
				input:          vec![InputModality::Text, InputModality::Image],
			},
		],
		current:         Some(ModelRef {
			provider: "anthropic".to_string(),
			id:       "claude-sonnet-4.5".to_string(),
		}),
		thinking_level:  Some("high".to_string()),
		thinking_levels: vec![
			"off".to_string(),
			"low".to_string(),
			"medium".to_string(),
			"high".to_string(),
		],
	});
	let mut built = seed.finish();
	let models = vec![
		ModelOption {
			choice:    ModelChoice::new("anthropic".to_string(), "claude-sonnet-4.5".to_string()),
			name:      "Claude Sonnet 4.5".to_string(),
			reasoning: true,
			input:     vec![InputModality::Text, InputModality::Image],
		},
		ModelOption {
			choice:    ModelChoice::new("openai".to_string(), "gpt-5".to_string()),
			name:      "GPT-5".to_string(),
			reasoning: true,
			input:     vec![InputModality::Text, InputModality::Image],
		},
	];
	let control = ModelControl {
		current: Some(ModelChoice::new("anthropic".to_string(), "claude-sonnet-4.5".to_string())),
		options: models,
	};
	built.state.overlay = Some(Overlay::Palette(PaletteState::from_models(&control, true)));
	built
}

/// Anchored thinking effort selector popover above composer.
pub fn composer_thinking_selector() -> Built {
	let mut seed = Seed::attached();
	seed.session(QueuePartition::Live);
	let mut built = seed.finish();
	let mut palette = PaletteState::new(PaletteMode::Commands);
	let levels = ["off", "low", "medium", "high"];
	palette.set_items(
		levels
			.iter()
			.enumerate()
			.map(|(i, &level)| {
				PaletteItem::command(
					i as u64 + 1,
					format!("Thinking: {level}"),
					veyyon_desktop_surface::Intent::SetThinking(ThinkingLevel::new(level.to_string())),
					None,
				)
			})
			.collect(),
	);
	palette.selected = 3;
	built.state.composer.thinking = Some(ThinkingControl {
		level:  "high".to_string(),
		levels: levels.iter().map(|&s| s.to_string()).collect(),
	});
	built.state.overlay = Some(Overlay::Palette(palette));
	built
}
