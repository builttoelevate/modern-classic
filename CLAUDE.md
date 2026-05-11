# CLAUDE.md

Project-wide instructions for Claude Code sessions in this repo.

## Workflow

- After every push to a non-main branch, output the Vercel preview URL in chat as a tappable markdown link so Bill can open it on his phone for review. The URL is unpredictable (Vercel truncates the branch slug and appends a per-deploy hash) — read it from Vercel's PR comment via the GitHub MCP (`pull_request_read` / `get_comments`), don't try to guess from the branch name.
- Never push directly to main. All changes go through a preview branch first.
- Production deploys only happen when Bill explicitly merges to main.
