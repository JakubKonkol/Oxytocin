# Stage 07 — worktree maps and explicit agent guidance

Base revision: `26fa61b`. Windows, Node 24.16.0, Electron 44.4.5. No app windows were opened.

Ensemble registers each worktree after setup and restores existing registrations at startup. Main owns the checkout
registry, validates project opt-in before and after requests, inherits exclusions and always forces worktree data
to be ignored. Removing/finishing a worktree revokes its registration before closing the watcher and removing files;
a failed finish restores the registration. Role revocation cancels the HTTP session's in-flight reader. Role calls
ignore caller selectors and terminal headers. The normal Hub resolves registered worktree paths and terminal cwd
without falling back to the main checkout for missing worktrees.

The instruction block is changed only through an explicit settings action. The pure transform preserves BOM, EOL,
an original missing file and the original final-newline convention, using a small comment inside the generated block.
It refuses edited or ambiguous blocks. Host I/O is bounded, checks containment and refuses symlinks; main alone supplies
the authorized project root. No indexing is started when editing instructions of a disabled project.

## Regression coverage

- Real detached Git worktrees with divergent file hashes, independent graph generations and local `*` ignores.
- No root `.gitignore` edits in either worktree or the main repository.
- Already tracked and staged `.oxy` files remain outside Ensemble diffs and checkpoint commits. This case needs explicit
  Git path exclusions because `.gitignore` alone cannot exclude files tracked by the base commit.
- Two projects/checkout registrations: a caller cannot select a neighboring worktree; removal rejects an in-flight
  response and never substitutes the main map.
- Real HTTP role call with forged `cwd`, `project` and terminal header still reaches only its authenticated checkout.
  Revocation cancels its waiting query.
- Instruction insertion/reinsertion/removal, absent/empty/BOM/CRLF files, later content, edited/duplicate/incomplete
  markers and an escaping symlink (POSIX regression; skipped on Windows).

Focused validation passed: 62 unit tests / 1 platform skip and 4 live integration tests. Full `npm run check` passed:
1,360 unit tests / 4 skips, 67 integration tests / 66 platform/resource skips, 3 latency tests. `npm run build` passed.
Logs are `test-results/code-map-stage07-check.log` and `code-map-stage07-build.log`. Command-local temporary directory
and worker settings are the same as stage 06.

Added E2E covers the instruction buttons, a round trip restoring the exact original file, no implicit indexing and
an Ensemble task with its own `.oxy/code-map/graph.json`. App E2E remains unexecuted because Docker/WSL are unavailable;
the user's explicit exception to the commit gate continues to apply. Earlier performance/release gates remain open.
