variable "region" { default = "cn-north-4" }
variable "cluster_name" { default = "huaweicloud-agent" }
variable "cluster_version" { default = "v1.29" }
variable "node_count" { default = 3 }
variable "node_flavor" { default = "s6.xlarge.2" }  # 4C8G
variable "node_os" { default = "EulerOS 2.9" }
variable "vpc_cidr" { default = "10.0.0.0/16" }
variable "subnet_cidr" { default = "10.0.1.0/24" }
