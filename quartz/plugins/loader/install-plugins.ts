#!/usr/bin/env node
import fs from "fs"
import path from "path"
import YAML from "yaml"
import { installPlugins, parsePluginSource } from "./gitLoader.js"
import { PluginSource, QuartzPluginsJson } from "./types.js"

function readPluginsConfig(): QuartzPluginsJson | null {
  const candidates = [
    path.join(process.cwd(), "quartz.config.yaml"),
    path.join(process.cwd(), "quartz.plugins.json"),
    path.join(process.cwd(), "quartz.config.default.yaml"),
    path.join(process.cwd(), "quartz.plugins.default.json"),
  ]

  for (const configPath of candidates) {
    if (!fs.existsSync(configPath)) continue

    const raw = fs.readFileSync(configPath, "utf-8")
    if (configPath.endsWith(".yaml") || configPath.endsWith(".yml")) {
      return YAML.parse(raw) as QuartzPluginsJson
    }
    return JSON.parse(raw) as QuartzPluginsJson
  }

  return null
}

async function main() {
  const config = readPluginsConfig()
  const pluginSources: PluginSource[] =
    config?.plugins.filter((entry) => entry.enabled).map((entry) => entry.source) ?? []

  if (pluginSources.length === 0) {
    console.log("No external plugins to install.")
    return
  }

  console.log(`Installing ${pluginSources.length} plugin(s) from Git...`)

  const specs = pluginSources.map((source) => parsePluginSource(source))
  const installed = await installPlugins(specs, { verbose: true })

  if (installed.size === pluginSources.length) {
    console.log("✓ All plugins installed successfully")
  } else {
    console.error(`✗ Only ${installed.size}/${pluginSources.length} plugins installed`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("Failed to install plugins:", err)
  process.exit(1)
})
