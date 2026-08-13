output "public_ip" {
  value       = oci_core_instance.agent.public_ip
  description = "Public IPv4 of the agent host."
}

output "ssh_command" {
  value       = "ssh ubuntu@${oci_core_instance.agent.public_ip}"
  description = "How to get onto the box. OCI's Ubuntu images use the 'ubuntu' user, not 'opc'."
}

# This is the value the dashboard needs: set it as PLIMSOLL_SNAPSHOT_URL in
# Vercel. Plain HTTP is fine because dashboard/lib/snapshot.ts fetches from the
# Next server, not the browser, so there is no mixed-content constraint.
output "snapshot_url" {
  value       = "http://${oci_core_instance.agent.public_ip}:${var.snapshot_port}"
  description = "Agent snapshot endpoint. Set this as PLIMSOLL_SNAPSHOT_URL in the dashboard's Vercel env."
}

output "health_url" {
  value       = "http://${oci_core_instance.agent.public_ip}:${var.snapshot_port}/health"
  description = "Liveness probe. Returns 'ok' once the container is up, even before the first snapshot exists."
}

output "instance_ocid" {
  value       = oci_core_instance.agent.id
  description = "OCID of the instance."
}

output "data_volume_ocid" {
  value       = oci_core_volume.data.id
  description = "OCID of the /data volume holding the ledger and learned weights. Keep this if you ever rebuild the instance."
}

output "effective_image_ocid" {
  value       = local.image_id
  description = "Base image actually used. Pin this as image_ocid to make future applies reproducible."
}
