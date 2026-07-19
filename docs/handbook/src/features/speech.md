# Speech

Three surfaces share a local neural TTS engine (Kokoro-82M, ~100 MB, WAV/PCM). Network
is used only for the first model download (and for optional remote TTS backends when configured):

- **Spoken replies**: the assistant's streaming output is vocalized through
  the speakers as it arrives.
- **Voice input**: hold Space to talk; speech-to-text feeds the composer.
- **Speech synthesis**: the `tts` agent tool and the `veyyon say` CLI turn
  text into audio files or playback.

## Setup

```bash
veyyon setup speech
```

Installs audio dependencies and downloads the local TTS model into the tiny-models cache.

## `veyyon say`

```bash
veyyon say "hello world"                 # play through the speakers
veyyon say --file notes.md               # speak a file
git log -1 --format=%s | veyyon say      # speak piped stdin
veyyon say "hello" --out hello.wav       # write a WAV instead of playing
veyyon say --voices                      # list models and voices
veyyon say "hello" --voice bm_fable      # pick a voice for this run
```

Long input is segmented into sentence-sized chunks and streamed gaplessly, so
arbitrarily long text works. Error paths exit non-zero.

## Spoken replies

Enable with the `speech.enabled` setting (Settings → Providers → Services).
Related settings:

| Setting | What it does |
| --- | --- |
| `speech.enabled` | Speak the assistant's output aloud as it streams. |
| `speech.mode` | What to speak: `all` (messages + thinking), `assistant` (messages only), or `yield` (final message only). |
| `speech.voice` | Kokoro voice used for spoken replies. |
| `speech.enhanced` | Rewrite output into natural spoken prose with the tiny model before synthesis (describes code, drops links/markdown). |

Speech pauses automatically while you are talking (push-to-talk), so the
assistant does not talk over you.

## Voice input

| Setting | What it does |
| --- | --- |
| `stt.enabled` | Enable microphone speech-to-text (hold Space to talk, or bind `app.stt.toggle`). |
| `stt.language` | Recognition language (default `en`). |
| `stt.modelName` | On-device STT model. |

## Synthesis backend

| Setting | What it does |
| --- | --- |
| `providers.tts` | Backend for the `tts` tool: `auto` (prefer local, route `.mp3` to xAI when credentials exist), `local` (Kokoro, WAV/PCM), or `xai` (Grok Voice, needs xAI credentials). |
| `tts.localModel` | Local TTS model (`kokoro`). |
| `tts.localVoice` | Default Kokoro voice (see `veyyon say --voices`). |
| `speechgen.enabled` | Enable the `tts` agent tool for speech-file synthesis. |

## Cache and worker recovery

Corrupt or incomplete TTS model caches are detected and re-downloaded. The synthesis worker restarts on failure so `veyyon say` and the `tts` tool can continue after a bad download.
