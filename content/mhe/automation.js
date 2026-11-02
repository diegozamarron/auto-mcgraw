(() => {
  const { MessageType, messaging, settings, assistants, wait } = AutoMcGraw;

  const ANSWER_TIMEOUT_MS = 200000;
  const MAX_RETRIES = 1;
  const USER_POLL_MS = 400;
  const LOG_PREFIX = "[Auto-McGraw]";

  class AutomationStopped extends Error {}

  class AssistantError extends Error {
    constructor(message, fatal = false) {
      super(message);
      this.fatal = fatal;
    }
  }

  const pendingRequests = new Map();

  messaging.handle(MessageType.ASSISTANT_ANSWER, ({ requestId, answer }) => {
    pendingRequests.get(requestId)?.resolve(answer);
  });

  messaging.handle(
    MessageType.ASSISTANT_ERROR,
    ({ requestId, error, fatal }) => {
      pendingRequests
        .get(requestId)
        ?.reject(
          new AssistantError(
            error || "The assistant reported an error.",
            Boolean(fatal)
          )
        );
    }
  );

  function createRequestId() {
    return `${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
  }

  function requestAnswer(question, signal) {
    return new Promise((resolve, reject) => {
      const requestId = createRequestId();

      const settle = (callback, value) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        pendingRequests.delete(requestId);
        callback(value);
      };
      const onAbort = () => settle(reject, new AutomationStopped());
      const timer = setTimeout(
        () =>
          settle(
            reject,
            new AssistantError("No answer was received from the assistant.")
          ),
        ANSWER_TIMEOUT_MS
      );

      pendingRequests.set(requestId, {
        resolve: (answer) => settle(resolve, answer),
        reject: (error) => settle(reject, error),
      });
      signal.addEventListener("abort", onAbort, { once: true });

      messaging
        .send({ type: MessageType.ASK_QUESTION, question, requestId })
        .catch((error) => {
          const failure = messaging.isAvailable()
            ? new AssistantError(
                `Couldn't reach the extension (${messaging.errorMessage(
                  error
                )}).`
              )
            : new AssistantError(
                "Auto-McGraw was updated or reloaded. Refresh this page to keep using it.",
                true
              );
          settle(reject, failure);
        });
    });
  }

  async function currentAssistantName() {
    try {
      const { aiModel } = await settings.load();
      return assistants.get(aiModel).name;
    } catch {
      return assistants.get(assistants.DEFAULT_ID).name;
    }
  }

  async function describeFailure(error) {
    if (!(error instanceof AssistantError)) {
      console.error(LOG_PREFIX, error);
      return `Something went wrong while applying the answer (${messaging.errorMessage(
        error
      )}).`;
    }
    if (error.fatal) return error.message;

    const name = await currentAssistantName();
    return `${error.message}\n\nMake sure ${name} is open, signed in and not showing an error or popup, then click "Ask ${name}" to continue.`;
  }

  function hasQuestionContent({ question, options }) {
    if (question?.trim()) return true;
    if (Array.isArray(options)) return options.length > 0;
    return Boolean(options?.prompts?.length || options?.choices?.length);
  }

  function pickRandom(items) {
    return items[Math.floor(Math.random() * items.length)];
  }

  function shuffled(items) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  // Builds a random answer in the same shape the AI would return, plus the
  // chance (1/k) that such a guess happens to be right. Null = can't guess.
  function randomGuess({ type, options }) {
    if (type === "matching") {
      const prompts = options?.prompts || [];
      const choices = options?.choices || [];
      if (!prompts.length || choices.length < prompts.length) return null;
      const picks = shuffled(choices);
      let ways = 1;
      for (let i = 0; i < prompts.length; i += 1) {
        ways *= choices.length - i;
      }
      return {
        answer: prompts.map((prompt, i) => `${prompt} -> ${picks[i]}`),
        luck: 1 / ways,
      };
    }

    if (!Array.isArray(options) || options.length < 2) return null;
    if (type === "multiple_select") {
      let chosen = options.filter(() => Math.random() < 0.5);
      if (!chosen.length) chosen = [pickRandom(options)];
      return { answer: chosen, luck: 1 / (2 ** options.length - 1) };
    }
    if (type === "fill_in_the_blank") return null;
    return { answer: pickRandom(options), luck: 1 / options.length };
  }

  // Decides whether this question is a blind guess so overall accuracy lands
  // near `accuracy` (0-1). A guess is right with probability `luck`, so guess
  // with chance g where (1 - g) + g * luck = accuracy.
  function maybeGuess(question, accuracy) {
    const guess = randomGuess(question);
    if (!guess || !(accuracy >= 0)) return null;

    const chance = Math.min(1, Math.max(0, (1 - accuracy) / (1 - guess.luck)));
    if (Math.random() >= chance) return null;
    return { answer: guess.answer, explanation: "Random guess." };
  }

  function manualAnswerMessage(heading, lines, instructions) {
    const suggestion = lines?.length
      ? `AI answer:\n${lines.join("\n")}`
      : "The AI did not return a usable answer.";
    return `${heading}\n\n${suggestion}\n\n${instructions}`;
  }

  function create({ step, onStateChange }) {
    let controller = null;

    function isRunning() {
      return controller !== null;
    }

    function end(owner, message) {
      if (!owner || controller !== owner) return;
      controller = null;
      owner.abort();
      onStateChange();

      if (message) {
        console.warn(LOG_PREFIX, message);
        alert(message);
      }
    }

    function stopMessage(reason) {
      return reason ? `Auto-McGraw stopped: ${reason}` : null;
    }

    function createRun(owner) {
      const { signal } = owner;
      let askStartedAt = Date.now();

      function checkpoint() {
        if (signal.aborted) throw new AutomationStopped();
      }

      async function delay(ms) {
        await wait.delay(ms, signal);
        checkpoint();
      }

      async function waitFor(getter, options) {
        const value = await wait.waitFor(getter, { ...options, signal });
        checkpoint();
        return value;
      }

      async function withTimeout(promise, timeout) {
        const value = await wait.withTimeout(promise, { timeout, signal });
        checkpoint();
        return value;
      }

      async function ask(question) {
        if (!hasQuestionContent(question)) {
          throw new AssistantError(
            "Couldn't read the question on this page, so nothing was sent to the AI. This page layout may not be supported yet.",
            true
          );
        }

        askStartedAt = Date.now();
        const { humanAccuracy, accuracyPercent } = await settings.load();
        checkpoint();
        if (humanAccuracy) {
          const guess = maybeGuess(question, Number(accuracyPercent) / 100);
          if (guess) {
            console.log(LOG_PREFIX, "Guessing at random instead of asking the AI.");
            return guess;
          }
        }

        for (let attempt = 0; ; attempt += 1) {
          try {
            const answer = await requestAnswer(question, signal);
            checkpoint();
            return answer;
          } catch (error) {
            if (
              !(error instanceof AssistantError) ||
              error.fatal ||
              attempt >= MAX_RETRIES
            ) {
              throw error;
            }
            console.warn(LOG_PREFIX, "Retrying question after:", error.message);
          }
        }
      }

      // Waits out the rest of a random per-question "thinking" time, counted
      // from when the question was sent, so slow AI replies aren't padded.
      async function humanPause() {
        const { humanDelay, delayMinSec, delayMaxSec } = await settings.load();
        checkpoint();
        if (!humanDelay) return;

        const min = Math.max(0, Number(delayMinSec) || 0);
        const max = Math.max(min, Number(delayMaxSec) || 0);
        const targetMs = (min + Math.random() * (max - min)) * 1000;
        const remaining = targetMs - (Date.now() - askStartedAt);
        if (remaining > 0) await delay(remaining);
      }

      async function waitForUser(isDone) {
        await waitFor(isDone, { timeout: Infinity, interval: USER_POLL_MS });
        await delay(500);
      }

      async function pauseForManualAnswer(
        heading,
        lines,
        instructions,
        isDone
      ) {
        alert(manualAnswerMessage(heading, lines, instructions));
        checkpoint();
        await waitForUser(isDone);
      }

      function stop(reason) {
        end(owner, stopMessage(reason));
      }

      return {
        signal,
        checkpoint,
        delay,
        waitFor,
        withTimeout,
        ask,
        humanPause,
        waitForUser,
        pauseForManualAnswer,
        stop,
      };
    }

    async function loop(owner) {
      const run = createRun(owner);
      try {
        while (!owner.signal.aborted) {
          await step(run);
        }
      } catch (error) {
        if (error instanceof AutomationStopped || owner.signal.aborted) return;
        end(owner, stopMessage(await describeFailure(error)));
      }
    }

    function start() {
      if (controller) return;
      controller = new AbortController();
      onStateChange();
      loop(controller);
    }

    function stop(reason) {
      end(controller, stopMessage(reason));
    }

    return { isRunning, start, stop };
  }

  AutoMcGraw.automation = { create };
})();
