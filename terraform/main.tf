data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

# Resolved rather than hardcoded: image OCIDs differ per region and Canonical
# republishes them, so a pinned OCID rots and fails in a way that reads like an
# auth error. Filtering by shape also picks the right architecture automatically
# — aarch64 for A1, x86_64 for E2.1.Micro.
data "oci_core_images" "ubuntu" {
  compartment_id           = local.compartment_id
  operating_system         = "Canonical Ubuntu"
  operating_system_version = var.ubuntu_version
  shape                    = var.instance_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

locals {
  compartment_id = var.compartment_ocid != "" ? var.compartment_ocid : var.tenancy_ocid

  # VCN/subnet DNS labels are alphanumeric-only, must start with a letter, and
  # cap at 15 characters — instance_name is free-form, so strip it down.
  dns_label = substr(replace(lower(var.instance_name), "/[^a-z0-9]/", ""), 0, 15)

  is_flex_shape       = endswith(var.instance_shape, ".Flex")
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[var.availability_domain_index].name
  image_id            = var.image_ocid != "" ? var.image_ocid : data.oci_core_images.ubuntu.images[0].id

  # Signing is only reachable when the keystore, its credentials AND the password
  # are all present. Missing any one of them in live mode means the agent boots,
  # trades on paper for hours, and every real swap fails at the signature — a
  # failure worth catching at plan time instead of in the Telegram feed.
  live_signing_ready = alltrue([
    trimspace(var.twak_wallet_json_b64) != "",
    trimspace(var.twak_credentials_json_b64) != "",
    trimspace(var.twak_wallet_password) != "",
  ])

  base_env = {
    PLIMSOLL_MODE        = var.plimsoll_mode
    PLIMSOLL_INTERVAL_MS = tostring(var.plimsoll_interval_ms)
    PLIMSOLL_STATE_DIR   = "/data"

    # The container's own listener. The host publishes var.snapshot_port onto
    # this, so changing the external port never touches the app.
    PORT = "8080"

    ANTHROPIC_API_KEY = var.anthropic_api_key
    LLM_MODEL         = var.llm_model

    CMC_API_KEY   = var.cmc_api_key
    CMC_MCP_URL   = "https://mcp.coinmarketcap.com/mcp"
    CMC_REST_BASE = "https://pro-api.coinmarketcap.com"
    CMC_X402_BASE = "https://pro-api.coinmarketcap.com/x402"

    TWAK_ACCESS_ID            = var.twak_access_id
    TWAK_HMAC_SECRET          = var.twak_hmac_secret
    TWAK_WALLET_JSON_B64      = var.twak_wallet_json_b64
    TWAK_CREDENTIALS_JSON_B64 = var.twak_credentials_json_b64
    TWAK_WALLET_PASSWORD      = var.twak_wallet_password

    BSC_RPC_URL          = var.bsc_rpc_url
    BSC_RPC_FALLBACK_URL = var.bsc_rpc_fallback_url
    BSC_CHAIN_ID         = "56"

    TELEGRAM_BOT_TOKEN = var.telegram_bot_token
    TELEGRAM_CHAT_ID   = var.telegram_chat_id
  }

  agent_env = merge(local.base_env, var.extra_env)

  # docker --env-file has no quoting or escaping: it splits on the first `=` and
  # takes the rest of the line verbatim. Values must therefore be single-line,
  # which every value here is (the wallet blobs are base64). Empty values are
  # dropped rather than written as KEY= , so an unset Telegram token reads as
  # absent to the agent instead of as an empty-string token.
  env_file = join("\n", [
    for k in sort(keys(local.agent_env)) :
    "${k}=${local.agent_env[k]}" if trimspace(local.agent_env[k]) != ""
  ])

  cloud_init = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    env_file_b64    = base64encode(local.env_file)
    container_image = var.container_image
    snapshot_port   = var.snapshot_port
    instance_name   = var.instance_name
  })
}
