# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Auto-McGraw is a Chrome Manifest V3 extension. It reads McGraw Hill questions (SmartBook at `learning.mheducation.com/static/awd/*`, and ezto quizzes at `ezto.mheducation.com/*`), sends them to an AI chat site open in another tab (ChatGPT, Gemini or DeepSeek), parses the JSON reply and fills in / submits the answer. It drives third-party web UIs purely through DOM selectors and synthetic events, so most bugs are "a site changed its markup".

## Development

- No build step, package manager, linter or test suite. Plain browser JavaScript loaded directly by Chrome. Do not add imports/exports (see Module pattern).
- Run: `chrome://extensions` → Developer mode → "Load unpacked" → repo root. After editing, reload the extension card **and refresh the McGraw Hill / assistant tabs** (orphaned content scripts lose `chrome.runtime`; the code shows "Auto-McGraw was updated or reloaded. Refresh this page" when that happens).
- Logs are prefixed `[Auto-McGraw]`. Page console = content scripts; service worker console (from the extension card) = background.
- Release: `.github/workflows/release.yml` fires when `manifest.json` changes on `main`. If `version` ≠ latest `v*` tag it zips `manifest.json LICENSE assets/icon.png background content popup shared` and publishes a GitHub release whose notes are commit subjects (`--no-merges`) plus `Co-authored-by` / `Thanks:` trailer credits. **A new top-level directory must be added to that zip list.** Bumping `version` is what cuts a release.
- Commits use Conventional-Commit prefixes (`fix:`, `feat:`, `refactor:`, `ci:`, `chore:`, `docs:`) because they become release notes.

## Module pattern (important)

No ES modules. Every file is an IIFE that destructures dependencies from the global `AutoMcGraw` namespace (created by `shared/namespace.js`) and assigns its exports to it (`AutoMcGraw.xyz = {...}`). Load order is defined in two places and must be kept in sync when adding or moving files:
- `manifest.json` `content_scripts[].js` arrays (one block per site: SmartBook, ezto, and each assistant site)
- `importScripts(...)` at the top of `background/service-worker.js`

Dependencies must come first in those lists. Note `AutoMcGraw.doubleCredit` is defined twice: `background/double-credit.js` (service worker) and `content/smartbook/double-credit.js` (page). They never load in the same context. The relay re-injects assistant content scripts by reading the file list out of the manifest, so the manifest is the single source of truth for assistant script lists.

## Layout

- `shared/`: loaded in every context. `messaging.js` (message types + dispatcher), `settings.js`, `assistants.js` (id/name/URL-match registry, default `chatgpt`), `wait.js` (`delay`/`waitFor`/`withTimeout`, all abort-signal aware; `waitFor` resolves `null` on timeout/abort rather than throwing), `dom.js` (`queryFirst` tolerant of invalid selectors, `setInputValue` using the native setter + input/change events so React sees it, `pressKey` synthetic keyboard events, `KEYS`).
- `background/`: `service-worker.js` (registers handlers), `relay.js`, `prompt.js`, `tabs.js` (retrying `sendMessage`, find most-recently-accessed tab for a URL match), `double-credit.js`.
- `content/mhe/`: code shared by both McGraw Hill sites: `automation.js`, `toolbar.js`, `text.js`.
- `content/smartbook/`, `content/ezto/`: site-specific logic.
- `content/assistant/`: `bridge.js`, `response.js`, and one adapter per chat site.
- `popup/`: settings UI.

## Message flow

All cross-context messaging goes through `shared/messaging.js`. `messaging.handle(type, fn)` registers a handler (one shared `onMessage` listener); a handler's return value/promise becomes the response, `undefined` → `{ok:true}`, a throw → `{ok:false,error}`. Types live in the `MessageType` enum.

1. **Ask**: the McGraw content script's `run.ask(question)` (`content/mhe/automation.js`) sends `ASK_QUESTION` with a fresh `requestId` and `{type, question, options, previousCorrection}`, registers a pending promise keyed by `requestId` (timeout 200s, retried once on non-fatal `AssistantError`).
2. **Relay** (`background/relay.js`): questions are serialized through a single promise `queue`. Finds the assistant tab for the `aiModel` setting; if none, replies a *fatal* error. Focuses the assistant tab (only if same window), `PING`s it and injects its content scripts via `chrome.scripting` if no reply, then sends `PROMPT_ASSISTANT {prompt, requestId, replyTo: sourceTabId}`. `background/prompt.js` builds the prompt text per question type and always demands a JSON code block with `answer` and `explanation`.
3. **Assistant tab** (`bridge.js`): waits for the chat to be idle, types the prompt into the composer, clicks send (Enter key fallback, 2 attempts), snapshots existing replies, then `assistantResponse.watch` (`response.js`) detects the *new* reply, extracts the first JSON object that has a non-empty `answer` (preferring ```json blocks, brace-matching scanner), and waits until generation stops (or 5s of stable candidate). Sends `ASSISTANT_ANSWER` / `ASSISTANT_ERROR` (3-minute timeout) with `replyTo`.
4. **Return**: relay forwards to the `replyTo` tab (re-activating that tab); the pending request resolves.

A new `PROMPT_ASSISTANT` cancels the previous watcher (`generation` counter).

## Assistant adapters

`content/assistant/{chatgpt,gemini,deepseek}.js` call `assistantBridge.register(id, adapter)`. Adapter fields: `inputSelectors`, `sendSelectors` (ordered fallback lists), `getResponses()`, `getMessageId(node)` (used to tell new replies from old ones, falls back to node identity/text), optional `isBusy`, `isGenerating(node)`, `userMessageSelector` (to confirm send), `findFallbackSendButton`. `bridge.js` rejects send buttons whose label matches voice/dictate/stop/cancel. Composer text is set via `setInputValue` for textarea/input and via `<p>` innerHTML + input events for contenteditable. **These selectors are the most fragile code**; ChatGPT has both legacy and new reply markup, DeepSeek relies on obfuscated class names (`.f6d670`, `.bf38813a`, `.f9bf7997`).

To add an assistant: entry in `shared/assistants.js`, `host_permissions` + a `content_scripts` block in `manifest.json` (bridge, response, shared deps, new adapter), an adapter file, and a radio option with `data-assistant="<id>"` in `popup/settings.html`.

## Automation loop (`content/mhe/automation.js`)

`automation.create({ step, onStateChange })` returns `{isRunning,start,stop}`. `start` creates an `AbortController` and loops `await step(run)` until aborted. `run` provides abort-aware `delay`, `waitFor`, `withTimeout`, `checkpoint()` (throws `AutomationStopped` if aborted), `ask`, `waitForUser(isDone)`, `pauseForManualAnswer(heading, lines, instructions, isDone)` (alerts with the AI answer, then polls until `isDone()`), and `stop(reason)` (alerts `Auto-McGraw stopped: …`). Uncaught errors stop the loop with an alert; `AssistantError` messages get a "make sure <assistant> is open…" suffix unless `fatal`. `ask` refuses to send a question with no readable content. `toolbar.js` builds the "Ask <AI>" / "Stop Automation" + gear buttons (styled per `smartbook`/`ezto` variant) and `keepMounted` re-attaches them via MutationObserver when the SPA re-renders.

`content/mhe/text.js` holds all answer-matching helpers used by both sites: `readableText` (DOM → plain text, tables/images/`<br>` handled), `normalizeChoiceText`, `isAnswerMatch`, `findChoiceIndex`/`resolveChoiceIndices` (exact, then "A"/"1" label, then label-stripped, fuzzy), `flattenAnswerValues`, `splitCompoundAnswer`, `extractChoicesFromCombined`, `dedupeAnswers`. When the AI's wording doesn't match choices, fix it here.

## SmartBook (`content/smartbook/`)

- `main.js`: `readPageState()` classifies the page as `overview` (Continue button), `forcedLearning` (error alert + reading button), `question`, `answered` (a `.next-button` is present), or `loading`. `step` polls `waitForActionableState` (clicks Next periodically if stuck on `answered`), then: clicks through overviews; runs `completeForcedLearning` (read → "to questions" → next); or `answerQuestion`: ask → verify the question didn't change (`questions.signature`) → `answers.apply` → optional double credit → optional `pauseBeforeSubmit` → `submit` (click confidence button, read the correction, click Next). If answers can't be applied it pauses for a manual answer. Confidence level is `high_confidence` unless `randomConfidence`. `pendingCorrection` (from `questions.extractCorrection` after an incorrect result) is passed into the next question's prompt as `previousCorrection`.
- `questions.js`: `.probe-container` / `.awd-probe-type-*` detection of `multiple_choice`, `true_false`, `multiple_select`, `fill_in_the_blank`, `select_text`, `matching`; `parse`, `isAnswerable`, `questionKey`/`signature`, and correct-answer scraping from review markup.
- `answers.js`: `apply(container, rawAnswer)` → `{applied, lines, heading}`; clicks radios/checkboxes, fills `input.fitb-input` blanks (splits a single string across multiple blanks), clicks select-text choices, delegates matching.
- `matching.js`: matching is react-beautiful-dnd drag-and-drop, done with **keyboard events** (focus handle, Space/Enter to lift, counted arrow presses, drop; tries both lift keys, up to 4 passes). Answers are normalized from many shapes (`"Prompt -> Choice"` strings, objects, numeric refs, loose ordered lists) in `resolveTargets`; incomplete resolution returns `false` so the loop falls back to showing suggestions and pausing.
- `double-credit.js` (content side): see below.

## ezto (`content/ezto/main.js`)

Self-contained (no `smartbook/*`). Only multiple choice, true/false and single-blank fill-in; question parsed from `.question`/`.answers--mc` etc. Stops itself when the progress heading ("N of M") shows N > M or when Next disappears; "Ask" button only mounts on quiz pages (`isQuizPage`). Unsupported question → stops with an alert (no manual-pause fallback for the unsupported-parse case).

## Double Credit Mode (SmartBook only)

After the answer is applied in the original tab, `submitInDuplicate` sends `OPEN_DUPLICATE {answer, questionKey}`. The service worker calls `chrome.tabs.duplicate`, stores a job in `chrome.storage.session` (`duplicateJob`), and on load the duplicate tab's `init()` calls `CLAIM_DUPLICATE` (claimable once, only by the duplicate tab id). The duplicate waits for an answerable question, checks `questionKey` matches, applies the answer, clicks confidence, and sends `DUPLICATE_FINISHED`. The worker closes it, re-activates the original and sends `DUPLICATE_COMPLETE {ok,error}`. The original waits up to 60s; failures only log and skip (automation continues); a timeout/failure sends `CANCEL_DUPLICATE`. `handleTabRemoved` handles either tab closing early.

## Settings (`shared/settings.js`, `popup/`)

Stored in `chrome.storage.sync`: `aiModel`, `doubleCreditMode`, `randomConfidence`, `pauseBeforeSubmit`, `humanDelay` + `delayMinSec`/`delayMaxSec` (random per-question wait via `run.humanPause()`, measured from when `run.ask` started), `humanAccuracy` + `accuracyPercent` (`run.ask` sometimes skips the AI and returns a random guess built by `randomGuess`/`maybeGuess` in `automation.js`; the guess rate is solved so overall accuracy ≈ the target, accounting for the 1/k chance a guess is right. Fill-in-the-blank is never guessed). Number inputs in the popup use `data-setting` too and are clamped in `popup/settings.js`. Content scripts call `settings.subscribe` to keep a local copy. `popup/settings.html` + `settings.js` is both the toolbar popup and a popup window opened by the `OPEN_SETTINGS` message (the gear button); it shows which assistant tabs are open and toggles settings via inputs with `data-setting="<key>"`. A new setting needs a default in `DEFAULTS` and a matching `data-setting` input. The popup also checks the latest GitHub release (`api.github.com`, cached 1h in `chrome.storage.local`) against the manifest version.
