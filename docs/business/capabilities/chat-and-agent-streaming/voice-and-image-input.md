# Capability: Voice & Image Input

## Description

Lets the user compose messages with their voice (speech-to-text) and attach images to messages. Voice input is powered by the Voice Proxy; images are saved to `cwd/.tmp/images` in the project directory and the path is appended to the prompt.

## Actors

- **End-user developer** — Speaks or drags in an image.
- **The Voice Input button** — Records audio and POSTs to the voice proxy.
- **The Image Attachment component** — Reads the file and previews it.
- **The provider runtime** — Receives the prompt with image paths.

## Trigger

- The user holds the mic button (or toggles continuous voice) and speaks.
- The user drags an image into the composer (or clicks attach).

## Flow (Voice)

1. The user holds the `VoiceInputButton`; the browser records audio.
2. On release, the audio is POSTed to `/api/voice/transcriptions` with the user's configured backend.
3. The voice proxy validates the URL, calls the backend, and returns the transcript.
4. The composer inserts the transcript as text.
5. The user sends the message normally.

## Flow (Image)

1. The user drags an image into the composer.
2. `ImageAttachment` reads the file, generates a preview, and stores the base64 payload.
3. On send, the frontend POSTs the image to the chat hub (or includes the base64 inline, depending on provider support).
4. The provider runtime saves the base64 to `cwd/.tmp/images/<uuid>.<ext>`.
5. The prompt is augmented with the path (e.g. `image attached at .tmp/images/abc.png`).
6. The provider reads the file from disk and includes it in the request.

## Output

- A text transcript (voice) or an attached image (file) in the user's message.
- The provider sees the audio as text or the image as a file path.
- The voice proxy returns a clean transcript; images are visible in the chat history.

## Technical Mapping

- **Frontend voice:** `src/components/chat/view/subcomponents/VoiceInputButton.tsx`
- **Frontend image:** `src/components/chat/view/subcomponents/ImageAttachment.tsx`
- **Backend voice:** `server/voice-proxy.js`
- **Backend image handling:**
  - Claude: base64 to temp file in `cwd/.tmp/images` in `server/claude-sdk.js`
  - Cursor/Codex/OpenCode: provider-specific handling

## Dependencies

- **Chat & Agent Streaming** — The composer and message flow.
- **Provider Integration** — Provider-specific image handling.
- **Authentication & Security** — The voice proxy is auth-gated.
- **SSRF guards** — `server/voice-proxy.js` enforces the URL allowlist.
