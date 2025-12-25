# ACP Provider Agent Guide

1. **Build**: `npm run compile`; **watch**: `npm run watch`.
2. **Lint**: `npm run lint` (Prettier check); **format**: `npm run format`.
3. **Tests**: none defined; compile verifies types before publishing.
4. **Single test**: not available—run `npm run compile` for validation.
5. **Packaging**: `npm run package` builds the VSIX.
6. **Type safety**: Strict TS (`strict: true`, `esModuleInterop`, `ES2024`).
7. **Imports**: Prefer explicit relative paths within `src`; keep groupings (built-ins, deps, local) with blank lines.
8. **Formatting**: Use Prettier defaults (`.prettierrc`), 2 spaces, double quotes.
9. **Naming**: PascalCase for classes/types, camelCase for functions/variables, UPPER_SNAKE for constants.
10. **Types**: Avoid `any`; lean on SDK types and VS Code APIs.
11. **Error handling**: Surface user-friendly messages via `response.markdown` or VS Code UI; log details to output channels when available.
12. **Async**: Always `await` ACP client calls; respect cancellation tokens.
13. **Disposables**: Extend `DisposableBase` or `DisposableStore`, register disposables promptly.
14. **Permissions**: Use `PermissionPromptManager` to bind prompts per session; dispose contexts on cancellation.
15. **Session state**: Mutate `SessionState` via provided helpers; ensure cleanup when releasing sessions.
16. **File tree updates**: Keep chat response formatting user-friendly (see `acpChatParticipant.ts`).
17. **Commands**: Register under `vscodeAcpClient.*`; remember to add to `package.json` contributions.
18. **ACP config**: Agents defined in user settings (`acpClient.agents`); don’t hard-code paths.
19. **Docs**: Update `README.md` when adding commands or settings.
20. **No Cursor/Copilot rules**: None present in repo.
