import { execFile } from "node:child_process"
import { copyFileSync, existsSync, readdirSync, unlinkSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { AfterPackContext, Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
const updateOwner = process.env.OPENCODE_UPDATE_OWNER ?? "dhhd67807-lgtm"
const updateRepo = process.env.OPENCODE_UPDATE_REPO ?? "exclamatory"
const artifact =
  process.env.EXCLAMTOY_ARTIFACT_NAME ?? process.env.EXCLAMATORY_ARTIFACT_NAME ?? "exclamtoy-desktop-${os}-${arch}"
const sidecars: Record<string, string> = {
  "darwin:arm64": "opencode-darwin-arm64",
  "darwin:x64": "opencode-darwin-x64-baseline",
  "win32:arm64": "opencode-windows-arm64",
  "win32:x64": "opencode-windows-x64-baseline",
  "linux:arm64": "opencode-linux-arm64",
  "linux:x64": "opencode-linux-x64-baseline",
}

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

function name(arch: number) {
  if (arch === 3) return "arm64"
  if (arch === 1) return "x64"
  throw new Error(`Unsupported target arch: ${arch}`)
}

function sidecar(platform: string, arch: number) {
  const id = sidecars[`${platform}:${name(arch)}`]
  if (!id) throw new Error(`Unsupported sidecar target: ${platform}/${name(arch)}`)
  const ext = platform === "win32" ? ".exe" : ""
  const a = path.join(rootDir, "packages", "opencode", "dist", id, "bin", `opencode${ext}`)
  if (existsSync(a)) return a
  const b = path.join(rootDir, "packages", "desktop-electron", "resources", `opencode-cli${ext}`)
  if (existsSync(b)) return b
  throw new Error(`Missing sidecar binary. Checked ${a} and ${b}.`)
}

function syncSidecar(context: AfterPackContext) {
  const source = sidecar(context.electronPlatformName, context.arch)
  const dir =
    context.electronPlatformName === "darwin"
      ? path.join(
          context.appOutDir,
          readdirSync(context.appOutDir).find((name) => name.endsWith(".app")) ?? "",
          "Contents",
          "Resources",
        )
      : path.join(context.appOutDir, "resources")
  if (!existsSync(dir)) {
    throw new Error(`Missing app resources directory: ${dir}`)
  }
  const file = context.electronPlatformName === "win32" ? "opencode-cli.exe" : "opencode-cli"
  const old = context.electronPlatformName === "win32" ? path.join(dir, "opencode-cli") : path.join(dir, "opencode-cli.exe")
  if (existsSync(old)) unlinkSync(old)
  copyFileSync(source, path.join(dir, file))
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const getBase = (): Configuration => ({
  artifactName: `${artifact}.\${ext}`,
  afterPack: syncSidecar,
  asar: true,
  compression: "maximum",
  removePackageScripts: true,
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "resources/**/*", "!**/*.map"],
  extraResources: [
    {
      from: "resources/",
      to: "",
      filter: ["opencode-cli*"],
    },
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: process.env.HAS_APPLE_API_KEY === "true",
    target: ["dmg"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "Exclamtoy",
    schemes: ["exclamtoy", "exclamatory"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
  },
  nsis: {
    oneClick: true,
    allowToChangeInstallationDirectory: false,
    shortcutName: "Exclamtoy",
    uninstallDisplayName: "Exclamtoy",
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const base = getBase()

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId: "ai.exclamatory.desktop.dev",
        productName: "Exclamtoy",
        executableName: "exclamtoy-dev",
        rpm: { packageName: "opencode-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "ai.exclamatory.desktop.beta",
        productName: "Exclamtoy Beta",
        executableName: "exclamtoy-beta",
        protocols: { name: "Exclamtoy Beta", schemes: ["exclamtoy", "exclamatory"] },
        publish: { provider: "github", owner: updateOwner, repo: updateRepo, channel: "latest" },
        rpm: { packageName: "opencode-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "ai.exclamatory.desktop",
        productName: "Exclamtoy",
        executableName: "exclamtoy",
        protocols: { name: "Exclamtoy", schemes: ["exclamtoy", "exclamatory"] },
        publish: { provider: "github", owner: updateOwner, repo: updateRepo, channel: "latest" },
        rpm: { packageName: "opencode" },
      }
    }
  }
}

export default getConfig()
