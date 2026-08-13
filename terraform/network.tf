# A dedicated VCN rather than the tenancy default: this box holds a funded
# trading wallet, and its ingress rules should be readable in one screen and not
# shared with whatever else the account grows later.

resource "oci_core_vcn" "main" {
  compartment_id = local.compartment_id
  display_name   = "${var.instance_name}-vcn"
  cidr_blocks    = ["10.0.0.0/16"]
  dns_label      = local.dns_label
}

resource "oci_core_internet_gateway" "main" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.instance_name}-igw"
  enabled        = true
}

resource "oci_core_route_table" "public" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.instance_name}-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.main.id
  }
}

resource "oci_core_security_list" "agent" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.instance_name}-sl"

  # Unrestricted egress: the agent must reach CMC, the Anthropic API, BSC RPC,
  # Telegram, and ghcr.io. Narrowing this to IP ranges would break on their next
  # CDN change, so the security boundary here is the risk kernel and the
  # allowlist, not the firewall.
  egress_security_rules {
    destination      = "0.0.0.0/0"
    destination_type = "CIDR_BLOCK"
    protocol         = "all"
  }

  ingress_security_rules {
    source      = var.ssh_allowed_cidr
    source_type = "CIDR_BLOCK"
    protocol    = "6" # TCP
    description = "SSH administration"

    tcp_options {
      min = 22
      max = 22
    }
  }

  ingress_security_rules {
    source      = var.snapshot_allowed_cidr
    source_type = "CIDR_BLOCK"
    protocol    = "6" # TCP
    description = "Read-only agent snapshot endpoint, consumed by the dashboard"

    tcp_options {
      min = var.snapshot_port
      max = var.snapshot_port
    }
  }

  # Path MTU discovery. Without this, large responses from an RPC or the
  # Anthropic API can black-hole instead of failing loudly — the kind of fault
  # that looks like a hung agent rather than a network problem.
  ingress_security_rules {
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    protocol    = "1" # ICMP
    description = "Destination unreachable / fragmentation needed (PMTUD)"

    icmp_options {
      type = 3
      code = 4
    }
  }
}

resource "oci_core_subnet" "public" {
  compartment_id             = local.compartment_id
  vcn_id                     = oci_core_vcn.main.id
  display_name               = "${var.instance_name}-subnet"
  cidr_block                 = "10.0.1.0/24"
  route_table_id             = oci_core_route_table.public.id
  security_list_ids          = [oci_core_security_list.agent.id]
  dns_label                  = "public"
  prohibit_public_ip_on_vnic = false
}
