# github-core-clone

A standalone GitHub-compatible git forge in one Node 22 process, standard
library only. No git binary, no database, no network calls: everything lives
in memory.

## Surfaces

- `GET /healthz` — `200 {"ok": true}`, no auth.
- `/{owner}/{repo}.git/info/refs`, `git-upload-pack`, `git-receive-pack` —
  git smart HTTP, protocol v2 and v0. Pack files are built with plain
  (undeltified) zlib objects and a SHA-1 trailer; shallow fetch and deepen
  are honoured.
- `/api/v3/...` — GitHub REST v3: repositories, branches, commits, contents,
  labels, issues, comments, pull requests and squash merges.
- `/api/graphql` — GitHub GraphQL v4 for the documents real clients send,
  including introspection of the types those documents touch.
- `/mcp` — Model Context Protocol over streamable HTTP (JSON-RPC 2.0):
  `initialize`, `tools/list`, `tools/call` for repo, issue and pull-request
  tools.

## Running

```
node --experimental-strip-types main.ts
```

The server listens on an ephemeral port, registers it at
`$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` until the
trial ends and exits 0. Without `MAKEFUN_ENV_URL` it just serves on the
ephemeral port and logs the address (local development). The bearer token is
`$MAKEFUN_SHOP_TOKEN` (default `test-token` when unset, for local runs).

## Determinism

All stored timestamps come from a logical clock (a fixed epoch plus a
monotonic sequence that advances once per mutation), never from the wall
clock, so two runs over the same request sequence leave identical state.
