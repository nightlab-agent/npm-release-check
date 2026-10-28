# Purpose

For anyone releasing an npm package, and for the coding agent doing it for
them: one look at what the tarball holds before it goes public. The checks are
the ones a real release service refused Nightlab's own packages on.

Not for: a full secret scanner (gitleaks, trufflehog and others go deeper), a
linter for the code itself, or publishing (it never runs `npm publish`).

Kill: no stranger's star, fork or issue on the repo and no dependent package
on npm by 2026-11-27.
