<!-- SPDX-License-Identifier: Apache-2.0 -->
# Contributing

Thanks for considering it. This is a small project run by a small number of
people and outside eyes are genuinely welcome — especially on the security
surface, which is where the interesting parts are.

## There is no CLA. There never will be.

**You do not have to sign anything to contribute here.**

This project used to require a Contributor License Agreement. It was dropped in
v3, deliberately, and the reasoning is worth stating plainly because the earlier
version stated the opposite just as plainly.

A CLA has exactly one real function for a project like this: it lets the
maintainer **relicense the code in the future** without asking every past
contributor. Dropping it closes that door, and we are closing it on purpose.
**This code is Apache-2.0 and it stays Apache-2.0.** Once outside contributions
land, relicensing would need each contributor's individual consent, and some of
them will be unreachable in five years. That is the point. It is a promise you
can verify rather than one you have to trust.

**You are not giving up any protection by there being no CLA.** Apache-2.0
section 5 already does the work:

> Unless You explicitly state otherwise, any Contribution intentionally
> submitted for inclusion in the Work by You to the Licensor shall be under the
> terms and conditions of this License, without any additional terms or
> conditions.

Inbound equals outbound, by the licence you are already reading. That is the
normal arrangement for an Apache-2.0 project and it needs no separate paperwork.

**What has NOT changed:**

- You keep your copyright. You always did — a CLA never took it.
- Everything already published under Apache-2.0 stays published. That grant is
  irrevocable and no licence decision, past or future, can claw it back.
- Trademarks are still reserved separately (see `NOTICE`). Apache-2.0 §6 does not
  grant trademark rights, and dropping the CLA does not change that. Fork it,
  rebrand it, sell it — just do not use our marks to name your fork or to imply
  we endorse it.
- A hosted offering is still possible. Apache-2.0 has no network copyleft, so
  running a service on this code never required a CLA in the first place. The CLA
  was only ever about relicensing, and that is the one thing we have given up.

## Sign your commits (`git commit -s`)

We use the [Developer Certificate of Origin](https://developercertificate.org) —
the same one the Linux kernel uses. It is **not** an agreement you sign with us
and there is no document, no PDF, no email, no bot account. It is one line that
`git` adds for you:

    git commit -s -m "your message"

which appends:

    Signed-off-by: Your Name <you@example.com>

By adding it you are stating that you wrote the change, or that you have the
right to submit it under Apache-2.0. That is all it is: you asserting you are
allowed to give us the code. It protects you and every downstream user from
someone pasting in code they did not have the rights to, which is a real problem
that costs real projects real money.

If you forget it, we will ask — `git commit --amend -s` fixes it.

## Before a big change, open an issue

For a typo or an obvious bug, just send the PR. For anything structural, open an
issue first so you don't spend an evening on something that conflicts with work
already in flight.

## Practical stuff

- **Small PRs.** One change, one PR. A 2,000-line PR gets reviewed slowly or not
  at all.
- **Say what you changed and why.** Apache-2.0 §4(b) requires modified files to
  carry a notice that you changed them; a clear commit message is the easy way.
- **Add an SPDX header** to any new file: `SPDX-License-Identifier: Apache-2.0`.
  The pre-publish gate refuses a release where one is missing, so a PR without it
  will fail CI rather than fail quietly.
- **New dependency? Add it to NOTICE.** Including anything loaded from a CDN at
  runtime — those are invisible to tooling pointed at `package.json`, and we have
  been bitten by exactly that.
- **Never commit a secret.** Not in code, not in a test fixture, not in an
  example. If one lands, say so immediately — rotating quickly is cheap,
  discovering it later is not.

## Security issues

**Do not open a public issue for a vulnerability.** See `SECURITY.md` for how to
report privately. We would much rather hear it from you first.

## What we care about in review

- Does it fail closed? A control that fails open is worse than no control,
  because it reads as coverage it doesn't have.
- Does it remove someone's way back? Any change that deletes a rollback path gets
  pushed back on, even if the change itself is right.
- Is the claim verified against what actually runs, not against source that might
  not be deployed? "It should work" and "I ran it and here is the output" are
  different things.

Those three come from real mistakes made in this codebase. They are not
rhetorical.
