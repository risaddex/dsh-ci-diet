# CI Diet (plugin Claude Code / Codex)

Plugin do fork [risaddex/dsh-ci-diet](https://github.com/risaddex/dsh-ci-diet) com suporte a
**Gitea Actions**. O CLI vai empacotado em `bin/cli.mjs` (gerado por `bun run bundle:plugin`
na raiz do fork; não é editado à mão).

Gitea: defina `GITEA_URL` e `GITEA_TOKEN` no ambiente e rode
`ci-diet sync --network --provider gitea`. Veja `skills/ci-diet/SKILL.md`.
