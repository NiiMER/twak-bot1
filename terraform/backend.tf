# Remote state, deliberately.
#
# The workflow in .github/workflows/deploy.yml runs `terraform apply` on an
# ephemeral runner. With local state, every run would start from an empty state
# file and try to CREATE a second instance, a second VCN, a second everything —
# while the real ones keep running, unmanaged and un-destroyable. Remote state is
# what makes CI-driven apply correct rather than destructive.
#
# OCI Object Storage speaks the S3 API, and 10 GB of it is Always Free, so state
# lives in the same tenancy as the infrastructure. The block is intentionally
# EMPTY — every value is supplied by `-backend-config` at init time (see the
# workflow and terraform/README.md), because a backend block cannot read
# variables.
#
# NOTE ON LOCKING: OCI's S3-compatible endpoint does not implement the
# conditional-write semantics the s3 backend's `use_lockfile` relies on, and
# there is no DynamoDB equivalent, so this state is UNLOCKED. Two concurrent
# applies can corrupt it. The workflow enforces single-writer discipline with a
# concurrency group; if you also apply from a laptop, do not do it while a
# deploy run is in flight.
#
# To run with purely local state instead (fine for a first bring-up from your
# own machine), comment this block out and run `terraform init` with no
# -backend-config flags.
terraform {
  backend "s3" {}
}
