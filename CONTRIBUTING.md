# Contributing

Thanks for helping. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Developer Certificate of Origin

Every commit must be signed off, which certifies the
[Developer Certificate of Origin](https://developercertificate.org/): you wrote the change,
or have the right to submit it under the project's license (AGPL-3.0).

```sh
git commit -s -m "feat(engine): add log price scale"
```

## Workflow

1. Pick an unchecked item in [docs/ROADMAP.md](docs/ROADMAP.md), or open an issue first for
   anything larger.
2. Keep pull requests focused. Include tests: Vitest for TypeScript packages, pytest for the API.
3. Before pushing, all of these must pass:
   ```sh
   pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
   cd api && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest
   ```
4. Use [Conventional Commits](https://www.conventionalcommits.org/) for messages.

## Ground rules

- Do not copy code, icons, or assets from reference or other proprietary products.
  Implement features from public descriptions and your own work.
- No script compatibility. Custom indicators use our own documented API.
- All Yahoo Finance access goes through the API's provider adapter, never the browser.
