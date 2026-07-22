terraform {
  required_providers {
    huaweicloud = { source = "huaweicloud/huaweicloud", version = ">= 1.70" }
    random = { source = "hashicorp/random" }
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

# EIP
resource "huaweicloud_vpc_eip" "agent_eip" {
  publicip { type = "5_bgp" }
  bandwidth {
    name        = "${var.cluster_name}-eip"
    size        = 10
    share_type  = "PER"
    charge_mode = "traffic"
  }
}

# CCE Cluster
resource "huaweicloud_cce_cluster" "agent_cluster" {
  name                   = var.cluster_name
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

  root_volume {
    size       = 40
    volumetype = "SSD"
  }

  data_volumes {
    size       = 100
    volumetype = "SSD"
  }

  runtime {
    name = "containerd"
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
