# Writing E2E tests

The E2E suite (`tests/e2e`, Playwright driving the built Electron app) gates every release on Windows and Linux CI
runners. Runners are slower and noisier than a developer's machine, Windows runners have a 1024×768 screen, and every
release depends on all of them passing. Most failures in the suite's history were not bugs in the app but tests that
assumed something about the machine: a screen size, a timing, a free port, an environment variable. These rules
come from those failures and from Playwright's own guidance (web-first assertions, isolation, no fixed waits).

## Rules

1. **Wait for a state, never for a time.** Use web-first assertions (`await expect(locator).toHaveText(…)`) and
   `expect.poll(() => …)` for anything that is not in the DOM (terminal text, `agents:list`, files). A
   `waitForTimeout` that waits for something to happen is a race that a slower runner loses. The only acceptable
   use is a short pause before asserting that something does **not** happen.
2. **Type into a terminal only when it waits for input.** `waitForTerminal` waits for the shell's first prompt;
   after a command, `waitForPrompt`; after Ctrl+C, `interrupt`. For an agent, wait for its state to be `idle`
   (`agents:list`) before typing. PowerShell drops keys typed before its prompt is drawn, and an agent's output can
   interleave with the echo of what you type.
3. **Assert on content, not on layout.** Terminal lines wrap at a width that depends on the window and the font:
   compare text with line breaks removed or use `toContain` on a distinctive part. Do not assert pixel positions
   unless the test is about layout.
4. **No timing budgets as hard assertions.** Measure latencies with `withinBudget` (`helpers/perf.ts`): the value is
   recorded in `perf-results.json` and annotated when over budget, and the test fails only on a gross regression.
5. **Every test owns its world.** `launchApp` gives each test a fresh user data folder, a fresh project folder and an
   environment without the runner's AI agent variables; pass what the test needs through `env` and fixture files.
   Never use fixed ports (ask the OS for a free one), the real home folder or anything left by another test.
6. **Make background UI deterministic.** Toasts and dialogs can cover what a test clicks on a small screen: wait for
   them to go away or dismiss them before clicking underneath.
7. **One user story per test.** A test launches the app once (1–3 s) and walks through a feature the way a user
   would. Rules of a single function belong in unit tests, and service behavior in integration tests: they run in
   milliseconds and never flake. Prefer extending an existing E2E test over adding one that starts the app again.
8. **Fakes, not real services.** Agents are the fake CLIs in `tests/fixtures/agents` (they print `ARGS:` and
   `PROMPT:` and follow simple stdin commands); network services are local servers on free ports.
9. **A flaky test is a bug.** CI retries a failed test twice and reports it as flaky; fix the cause (usually one of
   the rules above) instead of raising a timeout.

## Running

- `xvfb-run -a npm run e2e` (Linux), `npm run e2e` (Windows/macOS): builds, then runs the whole suite.
- One file: `npm run e2e -- tests/e2e/task.spec.ts` (builds first); once built, `npx playwright test <file>` alone.
- Checking a test for flakiness: `npx playwright test <file> --repeat-each=5`.
- CI (`full-tests.yml`) splits the suite into three shards per platform (`--shard=n/3`), each on its own machine, and
  records a trace only when a failed test is retried (`test-results/`, uploaded on failure).
