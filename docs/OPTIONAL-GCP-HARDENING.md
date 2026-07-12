# Optional GCP Org-Policy Hardening — OFFERED, not auto-applied

> The fleet deploy does **not** set org policies. It runs on a stock org and touches nothing
> org-wide. This doc lists hardening an operator MAY apply to their **own** org as a supervised
> decision. Each row names the attack vector it closes. Apply the "safe-by-default" set first;
> treat "supervised-relax" as deliberate trade-offs that can lock you out if applied blindly.
> Always test in a throwaway project first: `... --organization=<ORG_ID>`.

## Why this is offered, not automated
Org policies are org-wide. You may not know what your lab already depends on (we didn't).
The wrong one — requireOsLogin, vmExternalIpAccess — can cut off access to your own VMs.
So: offered here, enforced nowhere by the installer.

## Safe-by-default (low blast radius; recommended)
| Constraint | Vector it closes |
|---|---|
| iam.disableServiceAccountKeyCreation | Long-lived exported SA keys — the #1 GCP credential-leak vector (keys end up in git/CI). Forces keyless / ADC / Workload Identity. |
| iam.disableServiceAccountKeyUpload | Same, for externally-generated keys pasted in. |
| iam.automaticIamGrantsForDefaultServiceAccounts | Stops a new project's default SA from auto-getting Editor — silent over-privilege. |
| iam.allowedPolicyMemberDomains | Blocks granting IAM to principals outside your domain — closes the "invite/leave an external account on a resource" backdoor. (This is the one that quietly bit us: granting @domain on a rogue project pulled the project into the org.) |
| storage.uniformBucketLevelAccess | Removes per-object ACLs — the classic "public object via one stray ACL" leak. |
| storage.publicAccessPrevention | Hard-blocks public buckets entirely. |
| sql.restrictPublicIp | No public IP on Cloud SQL instances. |
| compute.requireShieldedVm | Every VM boots Secure Boot + vTPM + integrity monitoring (Titan-rooted) — closes boot-level rootkit/tamper. We set this per-launch already; the policy makes it org-wide and unbypassable. |
| compute.skipDefaultNetworkCreation | No auto "default" VPC (with its wide-open firewall) on new projects. |
| compute.vmCanIpForward (deny) | A compromised VM can't quietly act as a router/pivot. |
| essentialcontacts.allowedContactDomains | Security/billing alerts can't be redirected to an outside address. |
| gcp.resourceLocations | Pins resources to your regions — closes "spin up in an unmonitored region" (crypto-mining abuse pattern). |

## Supervised-relax (WILL change access — decide per environment)
| Constraint | Closes / why you might NOT set it |
|---|---|
| compute.requireOsLogin | Centralizes SSH via IAM, drops metadata SSH keys (kills stale-key access). **Breaks** our current SSH-key operator pipe until migrated to OS Login. |
| compute.vmExternalIpAccess | Denies public IPs on VMs (forces IAP / LB front). **Breaks** the mirror's public IP + any direct-IP path — we front with the LB instead. |
| iam.disableServiceAccountCreation | No new SAs at all — strong, but stops self-service automation. |
| compute.disableSerialPortAccess | Closes the serial-console backdoor — but you may want serial for break-glass recovery. |
| CMEK-required (gcp.restrictNonCmekCryptoKeyProjects) | Forces customer-managed keys — operationally heavier. |

## Apply (per policy, test project first)
```
gcloud resource-manager org-policies describe <constraint> --organization=<ORG_ID> --effective
gcloud resource-manager org-policies enable-enforce <constraint> --organization=<ORG_ID>
```

## Beyond org policies (turn on — no lock-out risk)
- **Security Command Center** (Standard tier is free) — surfaces misconfig + our Cloud Armor L7 findings.
- **Cloud Audit Logs**: enable Data Access logs on IAM + Secret Manager.
- **Cloud Armor** in front of every public endpoint. (Done for mcp.example.com: allow Anthropic egress 160.79.104.0/21, default-deny 403, adaptive protection → SCC.)
- **VPC Service Controls** perimeter around Secret Manager / GCS if you store sensitive data (supervised — can break egress).
