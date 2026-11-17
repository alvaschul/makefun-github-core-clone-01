# makefun-github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/alvaschul/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/alvaschul/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node program, standard library only — no dependencies, no git binary. It implements git smart HTTP (protocol v0 and v2 advertisements, ls-refs, packfiles with delta resolution, shallow fetch and deepen, receive-pack with report-status), the REST v3 surface (repositories, branches, commits, contents, labels, issues, comments, pull requests with squash merges), a GraphQL v4 endpoint with introspection and mutations, and an MCP endpoint whose tools act on the same store the REST surface reads.

## Run it

```sh
node --experimental-strip-types main.ts
```

The program expects `MAKEFUN_ENV_URL` (the harness it registers its ephemeral port with) and `MAKEFUN_SHOP_TOKEN` (the bearer token every API call must carry) in its environment, as the make.fun trial provides them.

---

<sub>Entered on [make.fun](https://make.fun/?ref=amcc02ae&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
