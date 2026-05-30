import fs from "fs"
import path from "path"
import { parse as parseYaml } from "yaml"
import { styleText } from "util"

const VAULT_PATH =
  process.env.QUARTZ_VAULT ??
  "/Users/nami/Library/Mobile Documents/iCloud~md~obsidian/Documents/phone notes"
const CONTENT_DIR = path.resolve("content")
const CACHE_FILE = path.resolve(".quartz-cache/vault-sync.json")

// Non-md files to always sync (relative path from vault root)
// - single file: "Notes/tasks.base"
// - whole folder: "🏛️ Assets/images" (syncs all files inside, recursively)
const WHITELIST: string[] = [
  "🌏MOCs/Buddhism.canvas",
  "🌏MOCs/Metalearning.canvas",
  "🌏MOCs/Psychology.canvas",
  "BOOKSHELF.base",
  "🏛️ Assets/images",
]

type Cache = Record<string, number> // relPath → mtime

function parseFrontmatter(raw: string): Record<string, unknown> {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  try {
    return (parseYaml(m[1]) as Record<string, unknown>) ?? {}
  } catch {
    return {}
  }
}

function readCache(): Cache {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"))
  } catch {
    return {}
  }
}

// Strip emoji / variation selectors from each path segment.
// "🏛️ Assets/images/x.png" → "Assets/images/x.png"
function normalizePathSegment(seg: string): string {
  return seg
    .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D\s]+/gu, "")
    .replace(/[\uFE0F\u200D]/g, "")
    .trim()
}

function sanitizeRelPath(rel: string): string {
  return rel
    .split(path.sep)
    .map(normalizePathSegment)
    .filter(Boolean)
    .join(path.sep)
}

function sanitizeVaultPath(vaultPath: string): string {
  return vaultPath
    .split(/[/\\]/)
    .map(normalizePathSegment)
    .filter(Boolean)
    .join("/")
}

function transformCanvasContent(raw: string): string {
  try {
    const data = JSON.parse(raw) as { nodes?: { type?: string; file?: string }[] }
    for (const node of data.nodes ?? []) {
      if (node.type === "file" && typeof node.file === "string") {
        node.file = sanitizeVaultPath(node.file)
      }
    }
    return JSON.stringify(data, null, "\t")
  } catch {
    return raw
  }
}

function isIgnoredDir(name: string): boolean {
  return name.startsWith(".")
}

function collectFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) {
      if (isIgnoredDir(e.name)) return []
      return collectFiles(path.join(dir, e.name))
    }
    if (e.isFile() && e.name.endsWith(".md")) return [path.join(dir, e.name)]
    return []
  })
}

function collectAllFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) {
      if (isIgnoredDir(e.name)) return []
      return collectAllFiles(path.join(dir, e.name))
    }
    if (e.isFile()) return [path.join(dir, e.name)]
    return []
  })
}

function expandWhitelist(vaultPath: string): { files: Set<string>; dirs: string[] } {
  const files = new Set<string>()
  const dirs: string[] = []

  for (const entry of WHITELIST) {
    const abs = path.join(vaultPath, entry)
    if (!fs.existsSync(abs)) continue

    if (fs.statSync(abs).isDirectory()) {
      dirs.push(entry)
      for (const f of collectAllFiles(abs)) files.add(f)
    } else {
      files.add(abs)
    }
  }

  return { files, dirs }
}

function isWhitelisted(rel: string, whitelistDirs: string[]): boolean {
  return whitelistDirs.some((dir) => rel === dir || rel.startsWith(dir + path.sep))
}

async function sync() {
  if (!fs.existsSync(VAULT_PATH)) {
    console.error(styleText("red", `[sync-vault] Vault not found: ${VAULT_PATH}`))
    process.exit(1)
  }

  const cache = readCache()
  const nextCache: Cache = {}

  fs.mkdirSync(CONTENT_DIR, { recursive: true })
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })

  const { files: whitelistFiles, dirs: whitelistDirs } = expandWhitelist(VAULT_PATH)
  const vaultFiles = [...collectFiles(VAULT_PATH), ...whitelistFiles].filter((f) =>
    fs.existsSync(f),
  )
  const vaultRelPaths = new Set(vaultFiles.map((f: string) => path.relative(VAULT_PATH, f)))

  let copied = 0,
    skipped = 0,
    removed = 0

  for (const absPath of vaultFiles) {
    const rel = path.relative(VAULT_PATH, absPath)
    const dest = path.join(CONTENT_DIR, sanitizeRelPath(rel))
    const mtime = fs.statSync(absPath).mtimeMs

    if (cache[rel] === mtime) {
      // mtime không đổi → giữ nguyên, không cần đọc file
      nextCache[rel] = mtime
      skipped++
      continue
    }

    // file mới hoặc đã thay đổi
    const shouldSync = whitelistFiles.has(absPath) || isWhitelisted(rel, whitelistDirs)
      ? true
      : parseFrontmatter(fs.readFileSync(absPath, "utf-8"))["publish"] === "true"

    if (shouldSync) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      if (rel.endsWith(".canvas")) {
        fs.writeFileSync(dest, transformCanvasContent(fs.readFileSync(absPath, "utf-8")))
      } else {
        fs.copyFileSync(absPath, dest)
      }
      copied++
    } else if (fs.existsSync(dest)) {
      // đã bị unpublish → xóa khỏi content/
      fs.rmSync(dest)
      removed++
    }

    nextCache[rel] = mtime
  }

  // file đã xóa khỏi vault → xóa khỏi content/
  for (const rel of Object.keys(cache)) {
    if (!vaultRelPaths.has(rel)) {
      const dest = path.join(CONTENT_DIR, sanitizeRelPath(rel))
      if (fs.existsSync(dest)) {
        fs.rmSync(dest)
        removed++
      }
    }
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(nextCache, null, 2))
  console.log(
    styleText("green", "[sync-vault]") + ` ${copied} copied, ${skipped} skipped, ${removed} removed`,
  )
}

sync().catch((err) => {
  console.error(styleText("red", "[sync-vault] Error:"), err.message)
  process.exit(1)
})
