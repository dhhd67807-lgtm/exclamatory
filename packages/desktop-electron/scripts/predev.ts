import { $ } from "bun"

import { copyBinaryToSidecarFolder, getCurrentSidecar, windowsify } from "./utils"

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

const idx = process.argv.indexOf("--target")
const arg = idx >= 0 ? process.argv[idx + 1] : undefined
const raw = arg ?? Bun.env.RUST_TARGET
const sidecarConfig = getCurrentSidecar(raw)
process.env.RUST_TARGET = sidecarConfig.rustTarget
const binaryPath = windowsify(`../opencode/dist/${sidecarConfig.ocBinary}/bin/opencode`, sidecarConfig.rustTarget)

await (sidecarConfig.ocBinary.includes("-baseline")
  ? $`cd ../opencode && bun run build --single --baseline`
  : $`cd ../opencode && bun run build --single`)

await copyBinaryToSidecarFolder(binaryPath, sidecarConfig.rustTarget)
