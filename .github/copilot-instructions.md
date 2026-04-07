# Snapscribe Project Guidelines

## Architecture
- This repo is a `pnpm` + `turbo` monorepo.
- The currently active product code lives in `apps/web` (`Next.js 16` App Router + `React 19`).
- Shared code belongs in `packages/ui`, `packages/eslint-config`, and `packages/typescript-config`.
- `CLAUDE.md` describes the broader product roadmap, but edits should follow the **current workspace structure first** unless the task explicitly asks for new apps/workers.

## Build and Verification
- Run commands from the repository root and use `pnpm`, not `npm`.
- Main commands:
  - `pnpm dev`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm build`
- There is **no test suite yet**, so validate code changes with the relevant lint, typecheck, and build commands.

## Frontend Conventions
- Prefer **Server Components by default** in `apps/web`; add `"use client"` only when a component needs hooks, browser APIs, or interactive state.
- Keep app-local imports under `@/…` and shared imports under `@workspace/ui/…`.
- Reuse the shared UI package instead of duplicating primitives inside the app.
- Follow the existing Tailwind + shadcn/ui style patterns, including `cn()` from `@workspace/ui/lib/utils` for class composition.

## Component Workflow
- For new shadcn/ui components, follow `README.md`: `pnpm dlx shadcn@latest add <component> -c apps/web`.
- Shared generated components should live in `packages/ui/src/components` and be imported from `@workspace/ui/components/...`.

## Practical Guidance
- Keep changes small and consistent with the scaffold already in the repo.
- When documenting or explaining the project, link to `README.md` for setup and `CLAUDE.md` for product vision instead of duplicating them here.
