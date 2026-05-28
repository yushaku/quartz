import fs from "fs"
import path from "path"
import { parse as parseYaml } from "yaml"
import { styleText } from "util"

const VAULT_PATH =
  process.env.QUARTZ_VAULT ??
  "/Users/nami/Library/Mobile Documents/iCloud~md~obsidian/Documents/phone notes"
const CONTENT_DIR = path.resolve("content")
const CACHE_FILE = path.resolve(".quartz-cache/vault-sync.json")

// Non-md files to always sync (relative path from vault root, e.g. "Notes/tasks.base")
const WHITELIST_FILES: string[] = [
  "🌏MOCs/Buddhism.canvas",
  "🌏MOCs/Metalearning.canvas",
  "🌏MOCs/Psychology.canvas",
  "BOOKSHELF.base"
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

// Strip leading emoji from each path segment: "🌏MOCs/file.md" → "MOCs/file.md"
function sanitizeRelPath(rel: string): string {
  return rel
    .split(path.sep)
    .map((seg) => seg.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]+/gu, "").trim())
    .join(path.sep)
}

function collectFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return collectFiles(full)
    if (e.isFile() && e.name.endsWith(".md")) return [full]
    return []
  })
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

  const whitelistAbs = new Set(WHITELIST_FILES.map((f) => path.join(VAULT_PATH, f)))
  const vaultFiles = [...collectFiles(VAULT_PATH), ...whitelistAbs].filter((f) =>
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
    const shouldSync = whitelistAbs.has(absPath)
      ? true
      : parseFrontmatter(fs.readFileSync(absPath, "utf-8"))["publish"] === "true"

    if (shouldSync) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(absPath, dest)
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
