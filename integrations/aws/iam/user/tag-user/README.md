# `aws/iam/user/tag-user`

Sets an IAM user's tags to an exact desired set on a user that already
exists. Does not create the user; run `aws/iam/user/create-user` first if it
doesn't exist yet.

```bash
bun run bin/ferry.ts aws/iam/user/tag-user --dry-run
bun run bin/ferry.ts aws/iam/user/tag-user
```

## What it does

| Step | Notes |
| --- | --- |
| `iam-user-exists` | aborts in the plan phase if the user doesn't exist |
| `user-tags` | always reconciles — the desired set depends on `TAGS_JSON` |
| `verify` | reads the user's tags back and confirms every desired pair is present |

## Gotchas

**`TagUser` merges, it does not replace.** Like `TagRole`, AWS's own docs
describe a `TagUser` call as overwriting only the keys you send — tags on the
user that this integration doesn't mention are left alone by default.

**Additive-by-default, prune is opt-in.** Leaving `PRUNE_UNMANAGED_TAGS=false`
(the default) means this integration only ever adds/updates keys named in
`TAGS_JSON` — it never silently deletes a tag some other process or console
user set, matching the project's general "never drift-manage beyond
presence" ethos. Set `PRUNE_UNMANAGED_TAGS=true` to converge fully: any key on
the user that isn't in `TAGS_JSON` is removed via `UntagUser`. This is a real
design choice, not an AWS-mandated behavior — pick prune mode deliberately.

**Leaving `TAGS_JSON` empty means "don't touch tags at all"** — regardless of
the prune setting.

**Rollback restores the pre-run snapshot exactly.** Keys this run introduced
are stripped with `UntagUser`; keys this run overwrote have their prior value
restored with `TagUser`; keys this run pruned (if `PRUNE_UNMANAGED_TAGS` was
on) are restored the same way. All three use the full tag set captured at the
start of this run — never a guess.
