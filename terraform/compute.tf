resource "oci_core_instance" "agent" {
  compartment_id      = local.compartment_id
  availability_domain = local.availability_domain
  display_name        = var.instance_name
  shape               = var.instance_shape

  # E2.1.Micro is a fixed shape and REJECTS shape_config; only flex shapes take
  # an OCPU/memory pair. This block is what lets one config serve both.
  dynamic "shape_config" {
    for_each = local.is_flex_shape ? [1] : []

    content {
      ocpus         = var.instance_ocpus
      memory_in_gbs = var.instance_memory_gb
    }
  }

  source_details {
    source_type             = "image"
    source_id               = local.image_id
    boot_volume_size_in_gbs = var.boot_volume_size_gb
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    display_name     = "${var.instance_name}-vnic"
    assign_public_ip = true
    hostname_label   = local.dns_label
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data           = base64encode(local.cloud_init)
  }

  freeform_tags = {
    project = "plimsoll"
    role    = "trading-agent"
  }

  lifecycle {
    precondition {
      condition     = var.plimsoll_mode != "live" || local.live_signing_ready
      error_message = "plimsoll_mode=\"live\" needs all three of twak_wallet_json_b64, twak_credentials_json_b64 and twak_wallet_password. Without them the agent runs but every real swap fails at signing."
    }

    precondition {
      condition     = var.image_ocid != "" || length(data.oci_core_images.ubuntu.images) > 0
      error_message = "No Canonical Ubuntu ${var.ubuntu_version} image found for shape ${var.instance_shape} in ${var.region}. Check the shape exists in this region, or pin one with image_ocid."
    }

    # A new image OCID gets published every time Canonical rebuilds. Without
    # this, an unrelated `terraform apply` months from now would silently
    # DESTROY the running agent to rebuild it on a newer base image. Replacing
    # the box should be a deliberate act: change image_ocid, or taint it.
    ignore_changes = [source_details[0].source_id]
  }
}

# Kept separate from the boot volume on purpose. /data holds the decision ledger,
# the learned per-regime weights and the peak-equity mark that the drawdown
# kill-switch measures against. Equity itself is re-read from chain on restart,
# but the learning history is not reconstructible — losing it silently resets the
# agent's caution to neutral. A separate volume survives rebuilding the instance.
resource "oci_core_volume" "data" {
  compartment_id      = local.compartment_id
  availability_domain = local.availability_domain
  display_name        = "${var.instance_name}-data"
  size_in_gbs         = var.data_volume_size_gb

  freeform_tags = {
    project = "plimsoll"
    role    = "agent-state"
  }
}

resource "oci_core_volume_attachment" "data" {
  # Paravirtualized rather than iSCSI: it appears as an ordinary block device at
  # boot with no iscsiadm login dance in cloud-init.
  attachment_type = "paravirtualized"
  instance_id     = oci_core_instance.agent.id
  volume_id       = oci_core_volume.data.id
}
