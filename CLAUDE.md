# CLAUDE.md

Project-wide instructions for Claude Code sessions in this repo.

## Workflow

- After every push to a non-main branch, output the Vercel preview URL in chat as a tappable markdown link so Bill can open it on his phone for review. The URL is unpredictable (Vercel truncates the branch slug and appends a per-deploy hash) — read it from Vercel's PR comment via the GitHub MCP (`pull_request_read` / `get_comments`), don't try to guess from the branch name.
- Never push directly to main. All changes go through a preview branch first.
- Production deploys only happen when Bill explicitly merges to main.

## Operator instructions for Bill

- Bill works from his phone over Tailscale most of the time. Anytime a PR or feature requires Bill to do something himself — set an env var, paste a value into an admin form, run a curl, click a button, walk a list, anything — present it as **numbered step-by-step instructions** with every copy-pasteable value (URL, path, command, button label, env var name, etc.) in its own fenced code block so he can long-press-and-copy on his phone. Don't bury operator actions inside prose paragraphs. If there's nothing to do, say so explicitly.
