# Issue tracker: GitHub

Issues and PRDs for this repository live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, including its labels.
- **List issues**: `gh issue list` with appropriate label and state filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- **Close an issue**: `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Publishing

When a skill says to publish to the issue tracker, create a GitHub issue.

When a skill says to fetch the relevant ticket, run `gh issue view <number> --comments`.
