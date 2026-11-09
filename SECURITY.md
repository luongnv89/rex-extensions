# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue, please report it responsibly.

### How to Report

1. **Do NOT** open a public GitHub issue for security vulnerabilities
2. Email your findings to contact@luongnv.com
3. Include detailed steps to reproduce the vulnerability
4. Allow up to 48 hours for an initial response

### What to Include

- Type of vulnerability
- Full paths of affected source files
- Location of the affected source code (tag/branch/commit or direct URL)
- Step-by-step instructions to reproduce
- Proof-of-concept or exploit code (if possible)
- Impact of the issue

### What to Expect

- Acknowledgment of your report within 48 hours
- Regular updates on our progress
- Credit in the security advisory (if desired)
- Notification when the issue is fixed

## Security Best Practices

When contributing to this project:

- Never commit secrets, API keys, or credentials
- Use environment variables for sensitive configuration
- Follow secure coding practices
- Report any security concerns immediately

## Scope

Rex runs `init.lua`, these extensions and their panels as your user, with no sandbox. Reports we especially want:

- **install.js:** anything that makes it write outside the `init.lua` it resolves (`REX_CONFIG`, `$XDG_CONFIG_HOME/rex/init.lua`, `~/.config/rex/init.lua`) or its `.bak-rex-<extension>` backup, or that injects Lua through a path or key argument.
- **github panel:** anything in a pull request, issue, label, branch name or URL from GitHub/GitLab that runs a command, escapes the terminal, or opens something other than an `http(s)` URL. Also anything in Resolve/Review that puts remote text into the agent's prompt.
- **sshtab:** anything that makes it type a command other than the ssh command of the tab it was opened from, or type into a pane that a script or agent created.
- **mcc panel:** anything that exposes an account's OAuth token. The panel itself sends nothing; `mcc` does the lookups.

The github and mcc READMEs list exactly what they run and write, under "What it runs"; the tabs and sshtab READMEs describe their background watcher and the files it keeps under `~/.cache/`. A behaviour not described there is a bug worth reporting.
