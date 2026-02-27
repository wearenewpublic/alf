# Contributing to ALF

Thank you for your interest in ALF! This document explains how to contribute effectively, what to expect from the review process, and the standards we hold contributions to.

ALF is maintained by a small team with limited bandwidth. Please read this guide before opening issues or pull requests — it helps us spend our time on the things that matter most.

ALF is a [New_ Public](https://newpublic.org) project, built as part of [Roundabout](https://joinroundabout.com).

---

## Forks are welcome

Forking ALF is a completely valid and encouraged way to build on top of it. If you need features that don't fit the core project's scope, or want to take ALF in a different direction, please fork freely.

**If you fork ALF, we ask that you credit the original project** — a link back to this repository in your README or documentation is appreciated and helps others find the upstream source.

---

## What kinds of contributions are welcome

In rough priority order:

1. **Bug reports** — accurate, reproducible reports of broken behavior
2. **Documentation improvements** — clarifications, corrections, examples
3. **Bug fixes** — confirmed bugs with a clear fix
4. **Small improvements** — quality-of-life changes with a clear motivation

Large new features, architectural changes, and integrations are best discussed as issues before any code is written. We may not be able to take them on.

---

## Reporting a bug

Please open a [GitHub Issue](https://github.com/your-org/alf/issues) with:

- **ALF version** (from `package.json` or the Docker image tag)
- **Environment** (OS, Node.js version, SQLite or Postgres)
- **Steps to reproduce** — what you did, what you expected, what actually happened
- **Relevant logs** — scheduler logs, HTTP response bodies, etc.

One bug per issue. If you've found two bugs, open two issues.

---

## Proposing a new feature

Before writing any code, open an issue describing:

- What problem you're trying to solve
- Why it belongs in ALF rather than a fork or wrapper
- What you're thinking of building

Wait for a maintainer to agree before proceeding. This saves everyone time — we'd rather say "this isn't the right direction" in an issue than in a pull request review.

---

## Pull request guidelines

- **One concern per PR.** A PR that fixes a bug and refactors a module is two PRs.
- **Link to an issue.** Every PR should close or reference an open issue.
- **Keep diffs small.** Small PRs get reviewed faster and merge more cleanly.
- **Don't send unsolicited PRs for features.** If there's no issue, there's no agreement.

---

## Code standards

All three of these must pass before a PR can be reviewed:

```sh
npm run lint       # ESLint
npm test           # Jest — 100% coverage is enforced
npm run typecheck  # TypeScript strict mode
```

If `npm test` fails due to coverage dropping below 100%, add tests before submitting.

We don't enforce a particular code style beyond what the linter catches. Match the style of the surrounding code.

---

## Commit message conventions

Use the imperative mood, present tense:

- `Fix scheduler retry loop for failed drafts`
- `Add OAUTH_SUCCESS_REDIRECT config option`
- not `Fixed the scheduler` or `Adding redirect support`

One subject line is preferred. For complex changes, add a blank line and a short paragraph body explaining *why*, not *what* (the diff explains what).

---

## Code of conduct

We are committed to providing a welcoming and respectful environment for everyone who participates in this project.

**Expected behavior:**
- Use welcoming, inclusive language
- Respect differing viewpoints and experiences
- Accept constructive criticism gracefully
- Focus on what is best for the community and the project

**Unacceptable behavior:**
- Harassment, personal attacks, or discriminatory language
- Publishing others' private information without consent
- Sustained disruptive behavior in issues or PRs
- Any conduct that a reasonable person would find inappropriate in a professional setting

**Enforcement:** Project maintainers will remove, edit, or reject comments, commits, issues, and other contributions that violate these standards. Repeated or severe violations may result in a temporary or permanent ban.

If you experience or witness unacceptable behavior, please report it by opening a GitHub Issue marked `[conduct]` or by contacting a maintainer directly.

This project follows the spirit of the [Contributor Covenant](https://www.contributor-covenant.org).

---

## Thank you

ALF is open source because we believe the ATProto ecosystem is better when developers can build on shared infrastructure. Every bug report, documentation fix, and thoughtful PR makes the project better. We appreciate you taking the time to contribute.
