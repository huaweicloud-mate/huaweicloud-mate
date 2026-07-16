/**
 * KooCLI Installer — 启动时自动安装 KooCLI，兼容 Linux / macOS / Windows
 *
 * 平台支持:
 *   Linux   amd64 / arm64  → .tar.gz → tar xzf
 *   macOS   amd64 / arm64  → .tar.gz → tar xzf
 *   Windows amd64          → .zip    → unzip
 */
import { createWriteStream, existsSync, mkdirSync, chmodSync, createReadStream } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { execSync } from "child_process";

const KooCLI_VERSION = "7.2.12";

// 平台检测
const PLATFORM = process.platform;   // "linux" | "darwin" | "win32"
const ARCH = process.arch === "arm64" ? "arm64" : "amd64";
const IS_WIN = PLATFORM === "win32";

// 由平台决定包格式 + 二进制名
const PKG_EXT = IS_WIN ? "zip" : "tar.gz";
const BINARY_NAME = IS_WIN ? "hcloud.exe" : "hcloud";

const KooCLI_CONFIG = {
  version: KooCLI_VERSION,
  installDir: join(homedir(), ".hcloud-agent", "koocli", "current"),
  baseUrl: "https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest",
  binaryName: BINARY_NAME,

  get platformLabel(): string {
    if (PLATFORM === "darwin") return "mac";
    if (PLATFORM === "win32") return "windows";
    return "linux";
  },

  get downloadUrl(): string {
    return `${KooCLI_CONFIG.baseUrl}/huaweicloud-cli-${KooCLI_CONFIG.platformLabel}-${ARCH}.${PKG_EXT}`;
  },

  get sha256Url(): string {
    return `${KooCLI_CONFIG.downloadUrl}.sha256`;
  },

  get binaryPath(): string {
    return join(KooCLI_CONFIG.installDir, KooCLI_CONFIG.binaryName);
  },
};

export const KooCLI_BINARY_PATH = KooCLI_CONFIG.binaryPath;

export interface InstallResult {
  success: boolean;
  alreadyInstalled: boolean;
  version?: string;
  path: string;
  error?: string;
}

export async function ensureKooCLI(): Promise<InstallResult> {
  if (existsSync(KooCLI_CONFIG.binaryPath)) {
    try {
      // pipe 'y' 处理首次运行的隐私政策提示
      const versionCmd = IS_WIN
        ? `cmd /c "echo y | "${KooCLI_CONFIG.binaryPath}" version 2>&1"`
        : `echo 'y' | "${KooCLI_CONFIG.binaryPath}" version 2>&1`;
      const version = execSync(versionCmd, { timeout: 5000 }).toString().trim();
      const match = version.match(/(\d+\.\d+\.\d+)/);
      const installedVersion = match ? match[1] : "unknown";

      if (installedVersion === KooCLI_CONFIG.version) {
        process.stderr.write(`[koocli] Already installed v${installedVersion} ${String.fromCodePoint(0x2705)}\n`);
        return { success: true, alreadyInstalled: true, version: installedVersion, path: KooCLI_CONFIG.binaryPath };
      }

      process.stderr.write(
        `[koocli] Version mismatch: ${installedVersion} vs ${KooCLI_CONFIG.version}. Reinstalling...\n`
      );
    } catch (err: any) {
      process.stderr.write(`[koocli] Installed binary broken: ${err.message}. Reinstalling...\n`);
    }
  }
  return downloadAndInstall();
}

async function downloadAndInstall(): Promise<InstallResult> {
  const tmpDir = join(homedir(), ".hcloud-agent", "koocli", "tmp");
  mkdirSync(KooCLI_CONFIG.installDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  const pkgPath = join(tmpDir, `hcloud.${PKG_EXT}`);
  const shaPath = join(tmpDir, `hcloud.${PKG_EXT}.sha256`);
  const extractDir = join(tmpDir, "extract");

  try {
    // 下载
    process.stderr.write(`[koocli] Downloading ${KooCLI_CONFIG.downloadUrl}...\n`);
    await downloadFile(KooCLI_CONFIG.downloadUrl, pkgPath);
    await downloadFile(KooCLI_CONFIG.sha256Url, shaPath);

    // SHA256 校验
    process.stderr.write("[koocli] Verifying SHA256...\n");
    const expectedHash = require("fs").readFileSync(shaPath, "utf-8").split(/\s+/)[0].trim();
    const actualHash = await sha256File(pkgPath);
    if (expectedHash !== actualHash) {
      throw new Error(`SHA256 mismatch! Expected: ${expectedHash}, Got: ${actualHash}`);
    }
    process.stderr.write(`[koocli] SHA256 OK ${String.fromCodePoint(0x2705)}\n`);

    // 解压
    process.stderr.write("[koocli] Extracting...\n");
    mkdirSync(extractDir, { recursive: true });

    if (IS_WIN) {
      // Windows: unzip
      execSync(`powershell -Command "Expand-Archive -Path '${pkgPath}' -DestinationPath '${extractDir}'"`, { timeout: 30000 });
    } else {
      // Linux / macOS: tar
      execSync(`tar xzf "${pkgPath}" -C "${extractDir}"`, { timeout: 30000 });
    }

    // 安装
    const extractedBinary = join(extractDir, BINARY_NAME);
    if (!existsSync(extractedBinary)) {
      // 某些版本可能命名为 hcloud 而非 hcloud.exe
      const altBinary = join(extractDir, IS_WIN ? "hcloud" : "hcloud.exe");
      if (existsSync(altBinary)) {
        require("fs").copyFileSync(altBinary, KooCLI_CONFIG.binaryPath);
      } else {
        throw new Error(`KooCLI binary not found in archive (expected: ${BINARY_NAME})`);
      }
    } else {
      require("fs").copyFileSync(extractedBinary, KooCLI_CONFIG.binaryPath);
    }

    // Linux/macOS: 设置可执行权限
    if (!IS_WIN) {
      chmodSync(KooCLI_CONFIG.binaryPath, 0o755);
    }

    // 验证 + 接受隐私政策
    const versionCmd = IS_WIN
      ? `cmd /c "echo y | "${KooCLI_CONFIG.binaryPath}" version 2>&1"`
      : `echo 'y' | "${KooCLI_CONFIG.binaryPath}" version 2>&1`;
    const version = execSync(versionCmd, { timeout: 5000 }).toString().trim();
    process.stderr.write(`[koocli] Installed ${version} ${String.fromCodePoint(0x2705)}\n`);

    return { success: true, alreadyInstalled: false, version, path: KooCLI_CONFIG.binaryPath };
  } catch (err: any) {
    process.stderr.write(`[koocli] Install FAILED: ${err.message}\n`);
    return { success: false, alreadyInstalled: false, path: KooCLI_CONFIG.binaryPath, error: err.message };
  } finally {
    try { require("fs").rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const { get } = url.startsWith("https") ? require("https") : require("http");
    const file = createWriteStream(dest);
    get(url, (response: any) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        return reject(new Error(`Download failed: HTTP ${response.statusCode}`));
      }
      response.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", (err: Error) => {
      require("fs").unlink(dest, () => {});
      reject(err);
    });
  });
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (data) => hash.update(data));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
