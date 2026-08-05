-- 001: Initialize hc-devkit database schema
-- Author: hc-devkit team
-- Date: 2026-08-04

CREATE TABLE IF NOT EXISTS voucher_records (
  domain_id  VARCHAR(32)  PRIMARY KEY,
  ak_hash    VARCHAR(64)  NOT NULL,
  voucher_id VARCHAR(64),
  amount     INT          DEFAULT 10,
  status     TINYINT      DEFAULT 1,
  claimed_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ak_hash (ak_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tasks (
  id          VARCHAR(36)  PRIMARY KEY,
  user_id     VARCHAR(16)  NOT NULL,
  description TEXT         NOT NULL,
  status      VARCHAR(16)  DEFAULT 'pending',
  progress    INT          DEFAULT 0,
  currentStep VARCHAR(64)  DEFAULT '',
  artifacts   JSON,
  output      MEDIUMTEXT,
  error       TEXT,
  created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
