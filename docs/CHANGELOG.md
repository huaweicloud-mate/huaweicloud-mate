# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-07-31

### Added
- Initial public release
- Three login modes: anonymous, long-term AK/SK, temporary STS credentials
- 5 MCP tools: `huaweicloud_auth`, `huaweicloud_set_credentials`, `huaweicloud_voucher_status`, `huaweicloud_voucher_claim`, `huaweicloud_invoke`
- K8s-based ephemeral sandbox for secure cloud operations
- DCS Redis + MySQL RDS persistence layer
- Incentive/coupon API integration
- Local MCP stdio proxy (`hc-devkit` CLI)

### Changed
- Restructured repository to follow OSS standards
- Moved cloud server code to `cloud-server/`
- Moved local proxy to `scripts/`
- Moved `huaweicloud-mate` router to `packages/`
