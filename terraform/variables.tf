# ---------------------------------------------------------------------------
# OCI account + API auth
# ---------------------------------------------------------------------------

variable "tenancy_ocid" {
  type        = string
  description = "Tenancy OCID. OCI console → Profile → Tenancy."
}

variable "user_ocid" {
  type        = string
  description = "OCID of the user whose API key signs these calls. Profile → My profile."
}

variable "api_fingerprint" {
  type        = string
  description = "Fingerprint of the uploaded API public key (aa:bb:cc:...)."
}

variable "api_private_key" {
  type        = string
  sensitive   = true
  description = "PEM CONTENTS of the API private key (not a path). Must include the BEGIN/END lines."
}

variable "region" {
  type        = string
  description = "OCI region identifier, e.g. eu-frankfurt-1. Free-tier resources only exist in your tenancy's HOME region."
}

variable "compartment_ocid" {
  type        = string
  default     = ""
  description = "Compartment to build in. Empty means the tenancy root compartment, which is where a fresh free-tier account puts everything."
}

# ---------------------------------------------------------------------------
# Instance shape and placement
# ---------------------------------------------------------------------------

variable "instance_name" {
  type        = string
  default     = "plimsoll-agent"
  description = "Display name / hostname prefix for the instance and its volumes."
}

# Ampere A1 is the shape worth having: Always Free grants 4 OCPU + 24 GB across
# A1 instances, versus 1 OCPU + 1 GB on the x86 micro shape. The agent is one
# Node process, so 1 OCPU / 6 GB is ample and leaves 3 OCPU free for a second
# box. Its architecture is aarch64 — verified compatible, see README.
variable "instance_shape" {
  type        = string
  default     = "VM.Standard.A1.Flex"
  description = "Compute shape. VM.Standard.A1.Flex (arm64) or VM.Standard.E2.1.Micro (x86, fixed 1 OCPU/1 GB) are the Always Free options."
}

variable "instance_ocpus" {
  type        = number
  default     = 1
  description = "OCPUs. Flex shapes only — ignored on E2.1.Micro. Always Free ceiling across all A1 instances is 4."

  validation {
    condition     = var.instance_ocpus >= 1 && var.instance_ocpus <= 4
    error_message = "Always Free allows at most 4 A1 OCPUs in total; anything above 4 is billable."
  }
}

variable "instance_memory_gb" {
  type        = number
  default     = 6
  description = "Memory in GB. Flex shapes only. Always Free ceiling across all A1 instances is 24."

  validation {
    condition     = var.instance_memory_gb >= 1 && var.instance_memory_gb <= 24
    error_message = "Always Free allows at most 24 GB of A1 memory in total; anything above 24 is billable."
  }
}

variable "availability_domain_index" {
  type        = number
  default     = 0
  description = "Which AD to place the instance in. A1 capacity is genuinely scarce on free tier — if apply fails with 'Out of host capacity', try 1 and 2 (see README)."
}

variable "image_ocid" {
  type        = string
  default     = ""
  description = "Pin a specific base image. Empty means look up the newest Canonical Ubuntu that matches var.ubuntu_version and the chosen shape's architecture."
}

variable "ubuntu_version" {
  type        = string
  default     = "24.04"
  description = "Canonical Ubuntu release to look up when image_ocid is empty."
}

# 50 GB of the 200 GB Always Free block-storage allowance. The other 50 goes to
# the data volume below, leaving 100 GB spare.
variable "boot_volume_size_gb" {
  type        = number
  default     = 50
  description = "Boot volume size. Always Free totals 200 GB of block storage across ALL volumes, boot volumes included."
}

variable "data_volume_size_gb" {
  type        = number
  default     = 50
  description = "Size of the separate volume mounted at /data. Counts against the same 200 GB allowance."
}

# ---------------------------------------------------------------------------
# Access
# ---------------------------------------------------------------------------

variable "ssh_public_key" {
  type        = string
  description = "OpenSSH public key authorized for the 'ubuntu' user. The matching private key is the ONLY way onto the box — OCI creates no password."
}

# Defaulting this open would be the single worst thing in this config: an
# internet-reachable SSH port on a host holding a funded trading wallet. There is
# no default, so you have to state who may connect.
variable "ssh_allowed_cidr" {
  type        = string
  description = "CIDR permitted to reach port 22, e.g. 203.0.113.4/32. Use 0.0.0.0/0 only if you accept a world-reachable SSH port."

  validation {
    condition     = can(cidrnetmask(var.ssh_allowed_cidr))
    error_message = "Must be valid CIDR notation, e.g. 203.0.113.4/32."
  }
}

# The dashboard on Vercel fetches this endpoint from its SERVER side (see
# dashboard/lib/snapshot.ts), and Vercel's egress addresses are not fixed, so
# this realistically has to be open. It is a read-only JSON snapshot of trading
# state — the same state the public dashboard renders — and carries no secrets.
variable "snapshot_allowed_cidr" {
  type        = string
  default     = "0.0.0.0/0"
  description = "CIDR permitted to reach the read-only snapshot endpoint."

  validation {
    condition     = can(cidrnetmask(var.snapshot_allowed_cidr))
    error_message = "Must be valid CIDR notation."
  }
}

variable "snapshot_port" {
  type        = number
  default     = 8080
  description = "Host port the agent's read-only snapshot endpoint is published on. Point PLIMSOLL_SNAPSHOT_URL at http://<public_ip>:<this>."
}

# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

variable "container_image" {
  type        = string
  default     = "ghcr.io/niimer/twak-bot1:latest"
  description = "Image the instance pulls and runs. Must be built for the shape's architecture (arm64 for A1) — the deploy workflow builds both."
}

# `dev` is the safe default on purpose: real signals, real LLM, real on-chain
# quotes, but NOTHING is signed. Flipping to `live` is what starts spending money,
# so it should be a deliberate edit rather than something you inherit.
variable "plimsoll_mode" {
  type        = string
  default     = "dev"
  description = "dev = dry-run-live, nothing signed. live = real swaps and x402 payments from a funded wallet."

  validation {
    condition     = contains(["dev", "live"], var.plimsoll_mode)
    error_message = "plimsoll_mode must be exactly \"dev\" or \"live\"."
  }
}

variable "plimsoll_interval_ms" {
  type        = number
  default     = 300000
  description = "Milliseconds between decision cycles."
}

# --- secrets consumed by the agent (see .env.example for what each one is) ---

variable "anthropic_api_key" {
  type        = string
  sensitive   = true
  description = "Claude API key — the brain's proposer."
}

variable "llm_model" {
  type        = string
  default     = "claude-opus-4-8"
  description = "Model id passed to the Anthropic SDK."
}

variable "cmc_api_key" {
  type        = string
  sensitive   = true
  description = "CoinMarketCap key (free Basic tier is enough)."
}

variable "twak_access_id" {
  type        = string
  sensitive   = true
  description = "Trust Wallet Agent Kit access id."
}

variable "twak_hmac_secret" {
  type        = string
  sensitive   = true
  description = "Trust Wallet Agent Kit HMAC secret."
}

# There is no OS keychain on a server, so docker-entrypoint.sh rebuilds
# ~/.twak/{wallet,credentials}.json from these base64 blobs and signs with
# `twak swap --password`. Produce them with:
#   base64 -i ~/.twak/wallet.json | tr -d '\n'
variable "twak_wallet_json_b64" {
  type        = string
  sensitive   = true
  default     = ""
  description = "base64 of ~/.twak/wallet.json (the ENCRYPTED keystore). Required for mode=live."
}

variable "twak_credentials_json_b64" {
  type        = string
  sensitive   = true
  default     = ""
  description = "base64 of ~/.twak/credentials.json. Required for mode=live."
}

variable "twak_wallet_password" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Password decrypting the keystore above. Required for mode=live — unattended signing cannot prompt."
}

variable "bsc_rpc_url" {
  type        = string
  sensitive   = true
  default     = "https://bsc-dataseed.binance.org"
  description = "Primary BSC RPC. Use a keyed endpoint — public nodes rate-limit eth_getLogs, which is how DEX flow is read."
}

variable "bsc_rpc_fallback_url" {
  type        = string
  sensitive   = true
  default     = "https://bsc-dataseed.binance.org"
  description = "Failover RPC used when the primary blips."
}

variable "telegram_bot_token" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Telegram bot token for trade/error/heartbeat alerts. Empty disables alerting."
}

variable "telegram_chat_id" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Telegram chat id alerts are sent to."
}

# Escape hatch for anything in .env.example not modelled above (watchlist
# override, PLIMSOLL_RADAR_EVERY, qualifier tuning) without editing this file.
variable "extra_env" {
  type        = map(string)
  sensitive   = true
  default     = {}
  description = "Additional KEY = value pairs appended to the agent's env file. Overrides the keys set above on collision."
}
