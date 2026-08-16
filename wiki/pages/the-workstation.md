---
page: the-workstation
title: The workstation
section: operate
status: live
audience: public
owner: unassigned
generated_by: starter-edition
verified_at: "2026-08-10"
verified_by: starter-edition
watch:
  - "lake:shared/wiki/_release.txt@71b8aebd9209c5b60ca8ccc1ef4bb906ec2a7a5e39d77743e915866794b5d323"
---

# The workstation

A workstation is an optional Compute Engine VM in your project with a desktop, a
browser, and the Claude desktop app preinstalled. It exists so an agent has somewhere
to *be* -- a machine with a real browser session, rather than a request-scoped
container.

The installer asked whether to create one at step 5d and **defaulted to no**. That
default is deliberate: a VM bills whether or not anything uses it.

## Creating one later

From the release directory:

```
bash workstation.sh                    # prompts: none / linux / windows
bash workstation.sh linux              # non-interactive
bash workstation.sh windows
bash workstation.sh --project P --region R windows
```

Every script in the release is invoked with `bash <script>`, never `./<script>`. The
files ship without an executable bit, deliberately -- a mode that some ways of getting
the tree carry and others do not is a mode that makes a re-cut of the release differ
from the committed one for a reason that has nothing to do with its contents. One
extra word costs nothing and cannot drift.

It derives what it can and asks for nothing the install already knows. Project comes
from `gcloud config get-value project`; region from `gcloud config get-value
compute/region`. The zone is derived by listing zones in that region that are `UP`
and taking the first -- never composed by gluing `-a` onto the region name. Both are
overridable with `--project` / `--region` or the `PC_PROJECT` / `PC_REGION`
environment variables. If the project cannot be derived it prompts, and an EOF there
is a hard stop rather than a guess.

The script is **safe to re-run**. On a second run it adopts the existing instance:
five read-only gcloud calls, zero mutations, nothing created, nothing re-imaged,
nothing destroyed. It prints the status, machine type, boot disk size, and the OS the
instance actually reports.

Instances are named per flavour -- one for Linux, one for Windows -- so the two
cannot collide. Both can exist at once, and they share the router, the NAT and the
service account rather than duplicating them.

When it finishes it prints the exact `gcloud run services update ... --update-env-vars
WS_VM=...,WS_ZONE=...` line you need. Run it, or the `vm_*` tools have no machine to
drive. **The `vm_*` tools drive one machine at a time**, even when both flavours
exist.

## Linux vs Windows

| | Linux | Windows |
|---|---|---|
| access | IAP TCP tunnel, SSH | IAP TCP tunnel, RDP |
| public IP | none | none, and refused |
| Chrome | apt repo, signing key fingerprint pinned | enterprise MSI, Authenticode verified |
| setup after boot | one manual desktop step | two manual steps |

Pick Linux unless you specifically need Windows.

## Windows is IAP-only, with no public IP, and that is not negotiable

The Windows instance is created with **no external address**. The script hard-refuses
to create one with a public IP -- it is not a warning you can click past.

The reason is blunt: an RDP port on a public IP is scanned within minutes of
existing, and a Windows desktop with a browser signed into your accounts is the most
valuable thing in the project. So RDP is reachable only through an IAP TCP tunnel,
which means Google authenticates you before a packet reaches the machine.

```
gcloud compute start-iap-tunnel <instance-name> 3389 \
  --local-host-port=localhost:3389 \
  --zone <your-zone> --project <your-project>
```

Then point an RDP client at `localhost:3389`. Same shape for Linux with port 22, or
just use `gcloud compute ssh --tunnel-through-iap`.

Egress is through a Cloud NAT the script creates, so the machine can reach the
internet outbound while being unreachable inbound.

## The manual steps, and why they cannot be automated

Some things are done by hand after the box boots. This is not laziness.

**Setting the Windows password.** Google's Windows password reset generates a
credential and hands it to you once, in your own console session. Baking a password
into a startup script would put a plaintext credential in instance metadata, which is
readable by anything on the box and by anything with project-level read. So:

```
gcloud compute reset-windows-password <instance-name> \
  --zone <your-zone> --project <your-project>
```

Copy it into your password manager. It is shown once.

**Signing into Chrome Remote Desktop, if you use it.** CRD authorisation is an OAuth
consent tied to a Google account, completed in a browser, and it produces a host
token. There is no unattended flow that does not amount to storing your Google
credentials on the VM. You open a browser on the machine (over RDP or over the
IAP-tunnelled desktop), sign in, and set the PIN yourself.

The general rule: **anything that mints a long-lived credential for a human identity
is a human step.** Automating it means storing the credential that would have been
minted, which is a worse position than the manual step you were trying to avoid.

**Signing into the Claude desktop app.** Same category. The app is installed and
verified for you; the sign-in is yours.

## The Chrome extension

Both flavours force-install a Chrome extension by enterprise policy -- the Windows
registry `ExtensionInstallForcelist` key, and the Linux managed policy JSON -- and the
installer writes the published Claude extension id onto the instance as the
`pc-claude-ext-id` metadata value, so it **is** installed.

The id is a value, not a hardcode. The startup scripts read it from instance metadata,
validate it to be exactly 32 characters in the range a-p, and skip-and-log rather than
guess when it is absent. So all three of these work:

- `PC_CLAUDE_EXT_ID=<id>` when you run the installer, to force-install your own.
- `PC_CLAUDE_EXT_ID=` (explicitly empty), to ship the machine with **nothing**
  force-installed.
- After the fact, on one instance:

```
gcloud compute instances add-metadata <instance-name> \
  --zone <your-zone> --project <your-project> \
  --metadata pc-claude-ext-id=THE_EXTENSION_ID
```

An extension id is a capability: whoever owns it gets code running in the browser on
the pages the extension asks for, and a forcelist entry means the user cannot remove
it. That is why it is validated, why it is overridable per install and per instance,
and why an unset value installs nothing instead of guessing.

## Cost

A workstation bills for the instance, the boot disk, and NAT egress, whether or not
anyone is using it. Stop it when you are not:

```
gcloud compute instances stop <instance-name> --zone <your-zone> --project <your-project>
```

The `vm_stop` tool does the same thing through the gate, which costs you an approval
tap but leaves an auditable record of who stopped it and when.
