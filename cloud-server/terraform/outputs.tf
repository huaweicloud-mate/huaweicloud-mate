output "cluster_id" { value = huaweicloud_cce_cluster.agent_cluster.id }
output "eip" { value = huaweicloud_vpc_eip.agent_eip.address }
output "obs_bucket" { value = huaweicloud_obs_bucket.agent_bucket.bucket }
output "swr_org" { value = huaweicloud_swr_organization.agent_org.name }
