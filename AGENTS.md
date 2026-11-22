# AGENTS.md

## Project Guidelines

- **No test suite**: Do not add unit test files, test frameworks, or `test/` directories. Keep the repository minimal and verify changes with `npm run typecheck` and direct checks in Pi.
- **Serial verification only**: Execute live probes against Sub2API sequentially to avoid triggering upstream rate limits or account bans.
- **Zero extra runtime dependencies**: Rely only on Pi's peer packages and Node.js built-ins.
- **Never commit secrets**: Never write API keys, admin keys, or gateway tokens into repository files or logs.
