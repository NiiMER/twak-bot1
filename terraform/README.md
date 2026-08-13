# PLIMSOLL on Oracle Cloud (Always Free)

Terraform for running the agent 24/7 on an OCI Always Free instance, replacing
the Railway deployment. The dashboard stays on Vercel — only the agent moves.

## What it builds

| Resource | Notes |
|---|---|
| VCN + public subnet + internet gateway + route table | Dedicated, not the tenancy default |
| Security list | Ingress: SSH from **your** CIDR, snapshot port from anywhere, ICMP for PMTUD |
| Compute instance | `VM.Standard.A1.Flex`, 1 OCPU / 6 GB, Ubuntu 24.04 **arm64** |
| Block volume, 50 GB | Mounted at `/data` — decision ledger, learned weights, peak-equity mark |
| cloud-init | Docker, log rotation, `/data` mount, firewall, `plimsoll.service` |

The instance pulls `ghcr.io/<owner>/<repo>:latest` and runs it under systemd with
`Restart=always`.

**Always Free budget used:** 1 of 4 A1 OCPUs, 6 of 24 GB RAM, 100 of 200 GB block
storage (50 boot + 50 data). The `instance_ocpus` and `instance_memory_gb`
variables have validation that refuses anything above the free ceiling.

### Why arm64 is safe

The one native dependency in the image is `@napi-rs/keyring`, pulled in by
`@trustwallet/cli`. It publishes a `linux-arm64-gnu` prebuild, and `node:22-slim`
is Debian/glibc — so the Ampere shape works with no source compilation. That is
worth 4× the CPU and 24× the RAM of the x86 free shape.

If you would rather stay on x86, set `instance_shape = "VM.Standard.E2.1.Micro"`.
The `shape_config` block is conditional, so no other change is needed.

## One-time setup

### 1. OCI API key

Console → Profile → My profile → API keys → **Add API key** → download the
private key. The console then shows a config preview containing your
`tenancy_ocid`, `user_ocid`, `fingerprint` and `region`.

### 2. State bucket

`terraform apply` from CI needs remote state, or every run starts blank and
builds a *second* copy of everything (see `backend.tf`).

1. Console → Storage → Buckets → **Create Bucket**, e.g. `plimsoll-tfstate`.
2. Note the **namespace** shown on the bucket page.
3. Profile → My profile → **Customer secret keys** → *Generate secret key*.
   This gives an access-key/secret pair that speaks the S3 API.

## Deploying

### From GitHub Actions

`.github/workflows/deploy.yml`. Plans run automatically on changes under
`terraform/`; **apply and destroy only run from a manual `workflow_dispatch`**
with the action chosen explicitly, because this creates and destroys a host
holding a funded wallet.

Add these under Settings → Secrets and variables → Actions.

**OCI account**

| Secret | Value |
|---|---|
| `OCI_TENANCY_OCID` | `ocid1.tenancy.oc1..…` |
| `OCI_USER_OCID` | `ocid1.user.oc1..…` |
| `OCI_FINGERPRINT` | API key fingerprint |
| `OCI_PRIVATE_KEY` | Full PEM **contents**, including BEGIN/END lines |
| `OCI_REGION` | e.g. `eu-frankfurt-1` — must be your tenancy's **home** region |
| `OCI_COMPARTMENT_OCID` | Optional; empty = tenancy root |

**State backend**

| Secret | Value |
|---|---|
| `OCI_STATE_BUCKET` | Bucket name |
| `OCI_NAMESPACE` | Object Storage namespace |
| `OCI_S3_ACCESS_KEY_ID` | Customer secret key — access key |
| `OCI_S3_SECRET_ACCESS_KEY` | Customer secret key — secret |

**Host access**

| Secret | Value |
|---|---|
| `SSH_PUBLIC_KEY` | Public key authorized for the `ubuntu` user |
| `SSH_ALLOWED_CIDR` | Who may reach port 22, e.g. `203.0.113.4/32` |
| `SSH_PRIVATE_KEY` | Optional — only for the auto-redeploy job, see caveat below |

**Agent**

| Secret | Required |
|---|---|
| `ANTHROPIC_API_KEY` | yes |
| `CMC_API_KEY` | yes |
| `TWAK_ACCESS_ID` | yes |
| `TWAK_HMAC_SECRET` | yes |
| `TWAK_WALLET_JSON_B64` | for `live` |
| `TWAK_CREDENTIALS_JSON_B64` | for `live` |
| `TWAK_WALLET_PASSWORD` | for `live` |
| `BSC_RPC_URL` | recommended |
| `BSC_RPC_FALLBACK_URL` | recommended |
| `TELEGRAM_BOT_TOKEN` | optional |
| `TELEGRAM_CHAT_ID` | optional |

Produce the wallet blobs with:

```bash
base64 -i ~/.twak/wallet.json      | tr -d '\n'
base64 -i ~/.twak/credentials.json | tr -d '\n'
```

Mode is a repository **variable**, not a secret: `PLIMSOLL_MODE` = `dev` or
`live`. It defaults to `dev`, which runs everything for real except signing.

### From your machine

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars   # fill it in; it is gitignored
terraform init -backend-config=backend.hcl     # or omit for local state
terraform plan
terraform apply
```

## After the first apply

```bash
terraform output snapshot_url     # → http://<ip>:8080
curl "$(terraform output -raw health_url)"    # → ok
```

Set `PLIMSOLL_SNAPSHOT_URL` in the dashboard's Vercel environment to the
snapshot URL. Plain HTTP is fine: `dashboard/lib/snapshot.ts` fetches from the
Next **server**, not the browser, so there is no mixed-content problem.

On the box:

```bash
sudo systemctl status plimsoll
sudo docker logs -f plimsoll
sudo plimsoll-deploy          # pull the newest image and restart
sudo cat /var/log/cloud-init-output.log   # first-boot provisioning
```

## Caveats worth knowing before you run this

**A1 capacity is genuinely scarce.** `Out of host capacity` on apply is common
and is not a config error. Try `availability_domain_index = 1`, then `2`, then
retry later, or fall back to `VM.Standard.E2.1.Micro`.

**State contains your secrets in plaintext.** Every `TF_VAR_*` above ends up in
the state file. That is why it lives in a private bucket and why `.gitignore`
excludes `*.tfstate`. Anyone who can read that bucket can read the wallet
password.

**Secrets also sit in instance metadata.** They reach the host through
cloud-init `user_data`, so anything that can run code on the box — or reach
`169.254.169.254` from it — can read them. That is the standard trade-off for
this shape of deployment; OCI Vault would be the upgrade if the wallet ever
holds a meaningful balance.

**State is unlocked.** OCI Object Storage offers no locking primitive the S3
backend can use, so `-lock=false` is set and a `concurrency` group in the
workflow is the only thing preventing two simultaneous writers. Don't apply from
a laptop while a deploy run is in flight.

**The auto-redeploy job needs SSH reachability.** If `SSH_ALLOWED_CIDR` is
locked to your home IP — as it should be — GitHub's runners cannot connect and
that job will time out. Either leave `redeploy` off and run `plimsoll-deploy`
yourself, or widen the CIDR while it runs. Redeploy is not needed after `apply`
on a *new* instance; cloud-init already pulls the current image.

**cloud-init runs once.** Changing `plimsoll_mode` or any secret updates the
rendered `user_data`, but an existing instance will not re-read it. Either
`terraform taint oci_core_instance.agent` to rebuild (the `/data` volume
survives — it is a separate resource), or edit `/etc/plimsoll/plimsoll.env` on
the box and `sudo systemctl restart plimsoll`.

**The image is never replaced by Terraform.** `ignore_changes` on the source
image OCID means a newer Canonical publish will not silently destroy a running
agent. To move to a new base image, set `image_ocid` deliberately.
