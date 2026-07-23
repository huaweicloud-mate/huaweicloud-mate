terraform {
  required_providers {
    huaweicloud = { source = "huaweicloud/huaweicloud", version = ">= 1.70" }
  }
}

provider "huaweicloud" { region = var.region }

# VPC + Subnet
resource "huaweicloud_vpc" "agent_vpc" {
  name = "${var.cluster_name}-vpc"
  cidr = var.vpc_cidr
}
resource "huaweicloud_vpc_subnet" "agent_subnet" {
  name       = "${var.cluster_name}-subnet"
  vpc_id     = huaweicloud_vpc.agent_vpc.id
  cidr       = var.subnet_cidr
  gateway_ip = cidrhost(var.subnet_cidr, 1)
}

# EIP for CCE cluster
resource "huaweicloud_vpc_eip" "agent_eip" {
  publicip { type = "5_bgp" }
  bandwidth {
    name        = "${var.cluster_name}-eip"
    size        = 10
    share_type  = "PER"
    charge_mode = "traffic"
  }
}

# NAT Gateway + SNAT (CCE Pod 出公网访问 DeepSeek API)
resource "huaweicloud_nat_gateway" "agent_nat" {
  name      = "${var.cluster_name}-nat"
  spec      = "1"
  vpc_id    = huaweicloud_vpc.agent_vpc.id
  subnet_id = huaweicloud_vpc_subnet.agent_subnet.id
}

# EIP for NAT
resource "huaweicloud_vpc_eip" "nat_eip" {
  publicip { type = "5_bgp" }
  bandwidth {
    name        = "${var.cluster_name}-nat-eip"
    size        = 10
    share_type  = "PER"
    charge_mode = "traffic"
  }
}

resource "huaweicloud_nat_snat_rule" "agent_snat" {
  nat_gateway_id = huaweicloud_nat_gateway.agent_nat.id
  floating_ip_id = huaweicloud_vpc_eip.nat_eip.id
  subnet_id      = huaweicloud_vpc_subnet.agent_subnet.id
}

# CCE Cluster
resource "huaweicloud_cce_cluster" "agent_cluster" {
  name                   = var.cluster_name
  flavor_id              = "cce.s1.small"
  cluster_type           = "VirtualMachine"
  cluster_version        = var.cluster_version
  vpc_id                 = huaweicloud_vpc.agent_vpc.id
  subnet_id              = huaweicloud_vpc_subnet.agent_subnet.id
  container_network_type = "overlay_l2"
  eip                    = huaweicloud_vpc_eip.agent_eip.address
}

# CCE Node Pool
resource "huaweicloud_cce_node_pool" "agent_nodes" {
  cluster_id = huaweicloud_cce_cluster.agent_cluster.id
  name       = "agent-nodes"
  initial_node_count = var.node_count

  flavor_id = var.node_flavor
  os        = var.node_os
  password  = "Huawei@123456"

  root_volume {
    size       = 40
    volumetype = "SSD"
  }

  data_volumes {
    size       = 100
    volumetype = "SSD"
  }
}

# OBS Bucket for Audit + TF State
resource "huaweicloud_obs_bucket" "agent_bucket" {
  bucket = "${var.cluster_name}-audit"
  acl    = "private"
}

# SWR Organization
resource "huaweicloud_swr_organization" "agent_org" {
  name = "huaweicloud-agent"
}

# Builder ECS (amd64, 用于构建 Docker 镜像)
resource "huaweicloud_compute_instance" "builder" {
  name       = "agent-builder"
  image_name = "Ubuntu 22.04 server 64bit"
  flavor_id  = "s6.large.2"
  admin_pass = "Huawei@123456"

  network {
    uuid = huaweicloud_vpc_subnet.agent_subnet.id
  }

  system_disk_type = "SSD"
  system_disk_size = 40

  user_data = <<-EOT
#!/bin/bash
sed -i "s/PasswordAuthentication no/PasswordAuthentication yes/" /etc/ssh/sshd_config
sed -i "s/#PermitRootLogin prohibit-password/PermitRootLogin yes/" /etc/ssh/sshd_config
systemctl restart sshd
curl -fsSL https://get.docker.com | bash
systemctl enable docker --now
mkdir -p /etc/docker
echo '{"registry-mirrors":["https://docker.m.daocloud.io"]}' > /etc/docker/daemon.json
systemctl restart docker
EOT
}

# EIP for builder
resource "huaweicloud_vpc_eip" "builder_eip" {
  publicip { type = "5_bgp" }
  bandwidth {
    name        = "agent-builder-eip"
    size        = 5
    share_type  = "PER"
    charge_mode = "traffic"
  }
}

resource "huaweicloud_compute_eip_associate" "builder_eip_assoc" {
  public_ip   = huaweicloud_vpc_eip.builder_eip.address
  instance_id = huaweicloud_compute_instance.builder.id
}
