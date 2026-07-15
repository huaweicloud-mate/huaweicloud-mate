import type { KooCliArtifactBinding } from "./artifacts.js";

const officialBase =
  "https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest";

// The official page publishes a mutable `latest` object per platform. Each
// release pins the bytes by SHA-256: an upstream replacement fails closed until
// a new plugin release deliberately refreshes all bindings and evidence.
export const releasedKooCliArtifacts: readonly KooCliArtifactBinding[] = [
  {
    platform: "windows-amd64",
    version: "7.2.12",
    archive: "zip",
    url: `${officialBase}/huaweicloud-cli-windows-amd64.zip`,
    sha256: "sha256:c075509737ba63fa62b22b326f13655adcd92bc54b9ce0b7d1a0b25e5af7329e",
  },
  {
    platform: "linux-amd64",
    version: "7.2.12",
    archive: "tar.gz",
    url: `${officialBase}/huaweicloud-cli-linux-amd64.tar.gz`,
    sha256: "sha256:c0966baeb3975efb3e24f004b16a000919e509ebbb2262ab18690a008aa0d25e",
  },
  {
    platform: "linux-arm64",
    version: "7.2.12",
    archive: "tar.gz",
    url: `${officialBase}/huaweicloud-cli-linux-arm64.tar.gz`,
    sha256: "sha256:5726da5bfa1cb48ff093d808280d4ed581db0db287e41fad982ab01ef30fbe93",
  },
  {
    platform: "mac-amd64",
    version: "7.2.12",
    archive: "tar.gz",
    url: `${officialBase}/huaweicloud-cli-mac-amd64.tar.gz`,
    sha256: "sha256:42b258057963d847e6f7fcdd17e05b5a72f776de49f41e689ff4cc115650d69f",
  },
  {
    platform: "mac-arm64",
    version: "7.2.12",
    archive: "tar.gz",
    url: `${officialBase}/huaweicloud-cli-mac-arm64.tar.gz`,
    sha256: "sha256:17ff6dbf0375706d6c511e4e299672fce95e13d2c74b413b831753d22f463b68",
  },
];
