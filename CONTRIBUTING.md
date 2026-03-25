# Contributing to audit-chain

Thank you for your interest in contributing to audit-chain.

## Getting Started

```bash
git clone https://github.com/Stackbilt-dev/audit-chain.git
cd audit-chain
npm install
npm run typecheck
```

## Development

- **TypeScript strict mode** is enforced. All code must pass `npm run typecheck`.
- **Zero production dependencies.** The library uses only the Web Crypto API and Cloudflare Worker bindings (R2, D1). Do not add runtime dependencies.
- **Keep core logic under 200 LOC.** The value of this library is simplicity and auditability.

## Pull Requests

1. Fork the repo and create a branch from `main`.
2. Make your changes and ensure `npm run typecheck` passes.
3. Write a clear PR description explaining the why, not just the what.
4. One logical change per PR.

## Code Style

- No external linter config (yet). Follow existing patterns.
- Prefer explicit types over inference for public APIs.
- Document all exported functions with JSDoc.

## Reporting Issues

Open an issue on GitHub. Include:
- What you expected to happen
- What actually happened
- Minimal reproduction steps

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
