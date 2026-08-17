# `aws/ec2/assign-elastic-ip`

Allocates a new Elastic IP and associates it with an existing instance,
tagged with a `ferry:integration-id` / `ferry:logical-name` pair so a re-run
finds it (and skips) instead of allocating a second one.

```bash
bun run bin/ferry.ts aws/ec2/assign-elastic-ip --dry-run
bun run bin/ferry.ts aws/ec2/assign-elastic-ip
```

## What it creates

| Step | Resource | Notes |
| --- | --- | --- |
| `assign-eip` | one Elastic IP, associated with `INSTANCE_ID` | One combined allocate+associate step — partial progress (allocated, not yet associated) is still `"missing"` |
| `verify` | reads the address back and confirms the association | |

## What it needs

**Root `.env`** — `credentials: ["aws"]` only.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `LOGICAL_NAME` | the `ferry:logical-name` identity tag `check()` matches on |
| `INSTANCE_ID` | must already exist |
| `TAGS` | optional JSON object of extra tags |

## Scope

**Only covers "allocate a new EIP and associate it."** There is no
`ALLOCATION_ID`/CIDR-pool param to attach an already-allocated Elastic IP to
an instance — that would be a different, simpler task, not built here.

## Gotchas

**`AllowReassociation: false` is a deliberate safety choice, not the API
default.** `AssociateAddress` defaults to silently moving an address that's
already attached elsewhere. This integration passes `AllowReassociation:
false` explicitly so that a target instance already holding a *different*
Elastic IP, or this address already associated elsewhere, fails loudly
instead of being silently re-pointed. `check()` mirrors this: an address
tagged with this run's identity but associated with a different instance is
reported `"conflict"`, not `"exists"`.

**Partial progress is still `"missing"`.** Allocation and association are
inseparable at the identity level here — an allocated-but-unassociated EIP
from this integration has no purpose on its own. If `create()` allocated the
address but died before associating it, the next run's `check()` still
reports `"missing"` and finishes the association rather than allocating a
second, redundant (and billed) EIP.

**Rollback disassociates then releases.** Only reached if this run's own
`create()` allocated it and a later step in the same run failed — a reused
(`"exists"`) address is never rolled back. Tolerant of the address already
being disassociated or released.
