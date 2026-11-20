# AGENTS.md

## Project Guidelines

- **No test suite**: Do not add unit test files, test frameworks, or `test/` directories. Keep the repository minimal and verify changes with `npm run typecheck` and direct checks in Pi.
- **Serial verification only**: Never run parallel requests against Sub2API / Antigravity during verification or debugging, to avoid triggering Antigravity rate limits or account bans. Always execute live probes sequentially one at a time.
- **Zero extra runtime dependencies**: Rely only on Pi's peer packages and Node.js built-ins.
- **Never commit secrets**: Never write API keys, admin keys, or gateway tokens into repository files or logs.
