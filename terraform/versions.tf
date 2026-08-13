terraform {
  required_version = ">= 1.6.0"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.0"
    }
  }
}

# Credentials arrive as values, never as file paths: CI has secrets in env, not
# on disk. `private_key` takes the PEM contents directly (TF_VAR_api_private_key),
# which is the same key `oci setup config` writes to ~/.oci/oci_api_key.pem.
provider "oci" {
  tenancy_ocid = var.tenancy_ocid
  user_ocid    = var.user_ocid
  fingerprint  = var.api_fingerprint
  private_key  = var.api_private_key
  region       = var.region
}
