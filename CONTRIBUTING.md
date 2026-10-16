# Contributing

Use `feat/req-<requirement-number>-<short-name>` branches (for example, `feat/req-202610-1250-init`). Do not commit directly to `main`.

Use imperative, concise commit subjects, optionally scoped; include the requirement number when relevant. Keep files preferably under 400 lines and split by responsibility. Comments should explain non-obvious intent or constraints, not restate code.

Run `npm test` and `npm run lint` from the repository root before submitting. Follow `.editorconfig`; backend JavaScript is formatted with Prettier. Kotlin conventions are documented in `android-client/README.md`.
