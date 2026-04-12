import fs from "fs/promises"
import path from "path"
import stripAnsi from "strip-ansi"
import z from "zod"
import { Instance } from "@/project/instance"
import { Ripgrep } from "@/file/ripgrep"
import { Filesystem } from "@/util/filesystem"
import { Tool } from "./tool"
import { assertExternalDirectory } from "./external-directory"
import DESCRIPTION from "./log_scan.txt"

const DEF_GLOB = [
  "**/*.log",
  "**/*.err",
  "**/*.out",
  "**/logs/**/*.log",
  "**/log/**/*.log",
  "**/npm-debug.log*",
  "**/yarn-error.log*",
  "**/pnpm-debug.log*",
  "**/bun-debug.log*",
  "**/vite*.log",
  "**/tauri*.log",
  "**/electron*.log",
  "**/jest*.log",
  "**/pytest*.log",
  "**/playwright*.log",
  "**/cargo*.log",
]
const DEF_SKIP = [
  "!**/.git/**",
  "!**/node_modules/**",
  "!**/.next/**",
  "!**/.turbo/**",
  "!**/.cache/**",
  "!**/dist/**",
  "!**/build/**",
  "!**/target/**",
  "!**/coverage/**",
]
const RX_ERR = /\b(error|exception|fatal|panic|traceback|failed|failure|unhandled)\b/i
const RX_WRN = /\b(warn|warning|deprecated|retry|timeout|slow)\b/i
const DEF_SCAN = 500
const DEF_FILES = 12
const DEF_BYTES = 120_000
const DEF_LINES = 30

const parameters = z.object({
  path: z.string().optional().describe("Directory to scan. Defaults to the current working directory."),
  include: z.array(z.string()).optional().describe("Optional glob patterns for log files."),
  regex: z.string().optional().describe("Optional regex filter applied to log lines."),
  level: z.enum(["all", "error", "warning"]).optional().describe("Filter lines by severity."),
  since_minutes: z
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 30)
    .optional()
    .describe("Only include files modified within this many minutes."),
  scan_limit: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .describe("Maximum candidate files to inspect before truncating discovery."),
  file_limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum files to analyze after discovery."),
  tail_bytes: z
    .number()
    .int()
    .min(4096)
    .max(2_000_000)
    .optional()
    .describe("Bytes to read from the end of each log file."),
  lines_per_file: z
    .number()
    .int()
    .min(1)
    .max(400)
    .optional()
    .describe("Maximum matching lines to return per file."),
})

type FileInfo = {
  path: string
  mtime: number
  size: number
}

type FileHit = {
  path: string
  mtime: number
  size: number
  clipped: boolean
  errors: number
  warnings: number
  matches: number
  lines: string[]
}

function stat(file: string): FileInfo | undefined {
  const info = Filesystem.stat(file)
  if (!info?.isFile()) return
  const size = typeof info.size === "bigint" ? Number(info.size) : info.size
  return {
    path: file,
    mtime: info.mtime.getTime(),
    size,
  }
}

function join(root: string, rel: string) {
  const file = path.resolve(root, rel)
  if (process.platform !== "win32") return file
  return Filesystem.normalizePath(file)
}

function parse(rx?: string) {
  if (!rx) return
  try {
    return new RegExp(rx, "i")
  } catch {
    throw new Error(`Invalid regex: ${rx}`)
  }
}

function score(line: string) {
  const error = RX_ERR.test(line)
  const warning = RX_WRN.test(line)
  return { error, warning }
}

function keep(line: string, rx: RegExp | undefined, level: "all" | "error" | "warning") {
  if (rx && !rx.test(line)) return false
  if (level === "all") return true
  const sev = score(line)
  if (level === "error") return sev.error
  return sev.warning
}

function hint(lines: string[]) {
  const text = lines.join("\n").toLowerCase()
  const out: string[] = []
  if (text.includes("eaddrinuse")) out.push("Port already in use. Check running dev servers and free the conflicting port.")
  if (text.includes("module_not_found") || text.includes("cannot find module")) {
    out.push("Dependency/module resolution failure. Verify installs and import paths.")
  }
  if (text.includes("econnrefused")) out.push("Connection refused. Ensure dependent service is started and reachable.")
  if (text.includes("permission denied")) out.push("Permission issue. Check file permissions and execution rights.")
  if (text.includes("out of memory") || text.includes("heap out of memory")) {
    out.push("Memory pressure detected. Reduce workload or increase memory limits.")
  }
  return out
}

async function tail(file: FileInfo, max: number) {
  const start = Math.max(0, file.size - max)
  const size = file.size - start
  const fd = await fs.open(file.path, "r").catch(() => undefined)
  if (!fd) return
  const buf = Buffer.alloc(size)
  const read = await fd.read(buf, 0, size, start).catch(() => undefined)
  await fd.close().catch(() => undefined)
  if (!read) return
  const text = buf.toString("utf8")
  return {
    text,
    clipped: start > 0,
  }
}

async function read(
  file: FileInfo,
  max: number,
  rx: RegExp | undefined,
  level: "all" | "error" | "warning",
  count: number,
) {
  const data = await tail(file, max)
  if (!data) return
  if (data.text.includes("\u0000")) return
  const lines = stripAnsi(data.text)
    .split(/\r?\n/g)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
  if (lines.length === 0) return

  const info = lines.reduce(
    (acc, line) => {
      const sev = score(line)
      return {
        errors: acc.errors + (sev.error ? 1 : 0),
        warnings: acc.warnings + (sev.warning ? 1 : 0),
      }
    },
    { errors: 0, warnings: 0 },
  )
  const matched = lines.filter((line) => keep(line, rx, level))
  if (matched.length === 0) return

  return {
    path: file.path,
    mtime: file.mtime,
    size: file.size,
    clipped: data.clipped,
    errors: info.errors,
    warnings: info.warnings,
    matches: matched.length,
    lines: matched.slice(-count),
  } satisfies FileHit
}

export const LogScanTool = Tool.define("log_scan", {
  description: DESCRIPTION,
  parameters,
  async execute(input, ctx) {
    const rootRaw = input.path ?? Instance.directory
    const root = path.isAbsolute(rootRaw) ? rootRaw : path.resolve(Instance.directory, rootRaw)
    await assertExternalDirectory(ctx, root, { kind: "directory" })

    const all = process.platform === "win32" ? Filesystem.normalizePathPattern(path.join(root, "*")) : path.join(root, "*").replaceAll("\\", "/")
    await ctx.ask({
      permission: "read",
      patterns: [all],
      always: ["*"],
      metadata: {
        path: root,
      },
    })

    const inc = input.include && input.include.length > 0 ? input.include : DEF_GLOB
    const globs = [...inc, ...DEF_SKIP]
    const scan = input.scan_limit ?? DEF_SCAN
    const lim = input.file_limit ?? DEF_FILES
    const bytes = input.tail_bytes ?? DEF_BYTES
    const lines = input.lines_per_file ?? DEF_LINES
    const level = input.level ?? "all"
    const rx = parse(input.regex)
    const min = input.since_minutes ? Date.now() - input.since_minutes * 60_000 : 0

    const seen = new Set<string>()
    const found: FileInfo[] = []
    let cut = false
    for await (const rel of Ripgrep.files({ cwd: root, glob: globs, follow: true, hidden: true, signal: ctx.abort })) {
      if (found.length >= scan) {
        cut = true
        break
      }
      const file = join(root, rel)
      if (seen.has(file)) continue
      seen.add(file)
      const info = stat(file)
      if (!info) continue
      if (min && info.mtime < min) continue
      found.push(info)
    }

    const ordered = found.sort((a, b) => b.mtime - a.mtime).slice(0, lim)
    const done = await Promise.all(ordered.map((file) => read(file, bytes, rx, level, lines)))
    const files = done.filter((item): item is FileHit => Boolean(item)).sort((a, b) => b.errors - a.errors || b.mtime - a.mtime)
    const errors = files.reduce((sum, item) => sum + item.errors, 0)
    const warnings = files.reduce((sum, item) => sum + item.warnings, 0)
    const snippets = files.flatMap((item) => item.lines.slice(-5))
    const hints = Array.from(new Set(hint(snippets)))

    const output = {
      root,
      level,
      regex: input.regex ?? null,
      discovered: found.length,
      analyzed: ordered.length,
      matched: files.length,
      discovery_truncated: cut,
      totals: {
        errors,
        warnings,
      },
      hints,
      files: files.map((item) => ({
        path: item.path,
        mtime: item.mtime,
        size: item.size,
        clipped: item.clipped,
        errors: item.errors,
        warnings: item.warnings,
        matches: item.matches,
        lines: item.lines,
      })),
    }

    return {
      title: `Log scan ${path.relative(Instance.worktree, root) || "."}`,
      output: JSON.stringify(output, null, 2),
      metadata: {
        path: root,
        discovered: found.length,
        matched: files.length,
        errors,
        warnings,
        truncated: cut,
        description: `Scanning logs in ${path.relative(Instance.worktree, root) || "."}`,
      },
    }
  },
})
