# capman-mcp Quick Start

> **You do not need to be a developer to follow this guide.**
> Every step is explained in plain English. Every command is copy-paste ready.
> Jump to [When something goes wrong](#-when-something-goes-wrong) if you hit an error.

---

## What is capman-mcp?

Imagine your company has an app — a shop, a booking system, a CRM — and you want
Claude (the AI) to be able to work with it directly. Instead of copying and pasting
data between Claude and your app, Claude can look things up, check availability, and
retrieve information on your behalf.

capman-mcp is the bridge that makes this possible. It connects Claude to your app's
capabilities and enforces rules about what Claude is and is not allowed to do.

```
You → Claude → capman-mcp → your app
                   ↑
           (this is what you are setting up)
```

What makes capman-mcp different from a plain integration is that it comes with
built-in safety controls: capabilities are explicitly approved before Claude can use
them, sensitive operations are risk-rated and blocked by default, and every action
Claude takes is logged.

---

## ✅ What you need before starting

- [ ] **A computer running macOS or Windows**
- [ ] **Node.js 18 or newer** — open a terminal and type `node --version`.
  You should see `v18.x.x` or higher. If you see an error, download Node.js from
  [nodejs.org](https://nodejs.org) and install the LTS version.
- [ ] **Claude Desktop** — download from [claude.ai/download](https://claude.ai/download).
- [ ] **A terminal** — on macOS: `Cmd + Space`, type `Terminal`, press Enter.
  On Windows: press the Windows key, type `cmd`, press Enter.

---

## 🚀 Try it in 2 minutes — demo mode

This uses a built-in sample shop so you can see everything working before touching
your real app. No config, no API keys.

### Step 1 — Start the demo server

Paste this into your terminal and press Enter:

```bash
npx capman-mcp demo
```

You will see:

```
[capman-mcp] Demo server started (dryRun: true)
[capman-mcp] Connect Claude Desktop using: npx capman-mcp demo
[capman-mcp] Waiting for connections...
```

Leave this terminal window open.

### Step 2 — Connect Claude Desktop

Open your Claude Desktop config file:

**macOS** → Open Finder, press `Cmd + Shift + G`, paste this path, press Enter:
```
~/Library/Application Support/Claude/
```
Open `claude_desktop_config.json` with TextEdit.

**Windows** → Press `Windows + R`, type this, press Enter:
```
%APPDATA%\Claude\
```
Open `claude_desktop_config.json` with Notepad.

> 💡 If the file does not exist, create it now and leave it blank.

Replace the entire contents with:

```json
{
  "mcpServers": {
    "capman-demo": {
      "command": "npx",
      "args": ["capman-mcp", "demo"]
    }
  }
}
```

Save the file.

> ⚠️ If the file already has content, do not replace it. Add only the `"capman-demo"`
> block inside the existing `"mcpServers"` section.

### Step 3 — Restart Claude Desktop

Quit Claude Desktop completely and reopen it.

### Step 4 — Talk to Claude

In a new Claude conversation, type any of these:

```
get order ORD-456
list orders
show me product SKU-123
check availability for blue jacket
```

Claude will use the demo shop tools and return a result.

🎉 **It works.** When you are ready to connect your real app, continue below.

---

## 🔌 Connect your real app

You will need to work with your developer for this section. They will generate
the files capman-mcp needs; you configure Claude Desktop to use them.

### What to ask your developer for

Ask them to provide:

1. **The manifest file path** — something like
   `/Users/yourname/myapp/capman.manifest.json`
2. **Your app's API base URL** — something like `https://api.myapp.com`
3. **The list of capability IDs** to make available to Claude

### Step 1 — Create your config file

Create a new file called `capman-mcp.config.js`. You can save it anywhere —
your home folder or your project folder both work fine.

Paste this into it, replacing the three marked lines:

```js
module.exports = {
  manifest: '/absolute/path/to/capman.manifest.json',  // 👈 change this
  baseUrl:  'https://api.your-app.com',                 // 👈 change this
  mode:     'balanced',
  dryRun:   false,
  transport: 'stdio',

  allowedCapabilities: [
    { id: 'get_order' },         // 👈 change these to your capability IDs
    { id: 'list_products' },
    { id: 'check_availability' },
  ],

  audit: {
    enabled: true,
  },
}
```

> ⚠️ **Always use the full path** for `manifest`. A full path starts from the
> root of your computer:
> - macOS: `/Users/yourname/myapp/capman.manifest.json`
> - Windows: `C:\\Users\\yourname\\myapp\\capman.manifest.json`
>
> Do not use `./` or `../` — Claude Desktop will not be able to find the file.

### Step 2 — Test your config from the terminal

Before telling Claude Desktop about it, confirm the config loads correctly:

```bash
npx capman-mcp start --config /absolute/path/to/capman-mcp.config.js
```

You should see:

```
[capman-mcp] Loaded manifest: your-app (12 capabilities)
[capman-mcp] 8 tools registered
[capman-mcp] MCP server running on stdio
```

If you see an error, fix it before moving on. Common errors are in
[When something goes wrong](#-when-something-goes-wrong).

### Step 3 — Connect Claude Desktop

Open `claude_desktop_config.json` again and replace its contents with:

```json
{
  "mcpServers": {
    "my-app": {
      "command": "npx",
      "args": [
        "capman-mcp",
        "start",
        "--config",
        "/absolute/path/to/capman-mcp.config.js"
      ]
    }
  }
}
```

Replace `/absolute/path/to/capman-mcp.config.js` with the actual path.

### Step 4 — Restart Claude Desktop

Quit Claude Desktop completely and reopen it. Your app's tools are now available.

---

## 💬 What to say to Claude

No special syntax needed. Describe what you want in plain English.

| What you want | What to type |
|---|---|
| Look up a specific order | `"Show me order ORD-123"` |
| Check whether something is in stock | `"Is the blue jacket in stock?"` |
| Browse recent orders | `"Show me the last 10 orders"` |
| Get details about a product | `"What are the details for product SKU-789?"` |

Claude works out which tool to call from your words. If it is not confident, it
will describe what it intends to do and ask you to confirm.

> 💡 **If Claude says it does not have a tool for something:** the capability is
> either not in your `allowedCapabilities` list, or it is a high-risk operation
> that is blocked by default. Ask your developer to check both.

---

## 🛡️ What capman-mcp checks before every tool call

capman-mcp applies four checks before Claude can use any capability:

1. **Is it approved?** Only capabilities your operator explicitly listed are available.
2. **Is it public?** Capabilities that touch private user data or require admin access
   cannot be exposed to Claude.
3. **Is it active?** Deprecated capabilities are never surfaced.
4. **Is it safe?** Capabilities rated as high-risk (admin operations, financial
   actions) are blocked by default unless your operator has explicitly approved them.

These checks run on every tool call — not just at startup.

---

## 📋 For developers — registry mode

For teams managing capabilities across multiple services, capman-mcp supports a
registry-based workflow with a CLI.

### Publish capabilities

```bash
# Publish from a manifest (risk level computed automatically)
npx capman-mcp registry publish --manifest capman.manifest.json --owner ci-bot

# Publish for review — not yet approved for MCP
npx capman-mcp registry publish --manifest capman.manifest.json --no-approved-for-mcp
```

### Review and manage

```bash
# List all capabilities with risk and approval status
npx capman-mcp registry list

# See what would change before publishing
npx capman-mcp registry diff --manifest capman.manifest.json

# Find which capabilities depend on a given one
npx capman-mcp registry impact my-app/get_order

# Deprecate a capability
npx capman-mcp registry deprecate my-app/old_search --successor my-app/new_search
```

### Run the discovery catalog

```bash
# Start a read-only HTTP catalog on port 4001
npx capman-mcp catalog start --port 4001 --manifest capman.manifest.json
```

The catalog exposes a queryable API:

```bash
# List all capabilities
curl http://localhost:4001/capabilities

# Filter by risk level
curl "http://localhost:4001/capabilities?risk=high&approvedForMcp=false"

# Get the MCP compatibility badge for a capability (SVG)
curl http://localhost:4001/capabilities/my-app/get_order/badge

# See what depends on a capability
curl http://localhost:4001/capabilities/my-app/get_order/impact
```

---

## 🔧 When something goes wrong

### ❌ Claude Desktop shows no tools after restart

**Most common cause:** a relative path in `claude_desktop_config.json`.

**Fix:** open `claude_desktop_config.json`. Every path must start from the root —
`/` on macOS, `C:\` on Windows. Restart Claude Desktop after saving.

**To confirm:** paste the `npx capman-mcp start ...` command from your config
directly into a terminal and run it. If it starts without errors, the path is correct.

---

### ❌ `Error: config.manifest must be a non-empty string path`

Your `capman-mcp.config.js` is missing the `manifest` field, or the value is not a string.

**Fix:** open `capman-mcp.config.js` and make sure the first line inside
`module.exports` reads:

```js
manifest: '/Users/yourname/myapp/capman.manifest.json',
```

---

### ❌ `allowlist entry "X" not found in manifest`

A capability ID in your `allowedCapabilities` does not exist in the manifest.

**Fix:** run the following to see all valid IDs:

```bash
npx capman inspect
```

Update `allowedCapabilities` to use the correct IDs from that list.

---

### ❌ `allowlist entry "X" filtered out (non-public or deprecated)`

The capability exists but is either restricted to admin or user-owned data, or it
has been deprecated. It cannot be exposed to Claude.

**Fix:** speak to your developer. They can either change the capability's privacy
setting (if appropriate) or provide an alternative capability.

---

### ❌ Tool calls return `Missing required parameters: order_id`

Claude could not extract the required value from what you typed.

**Fix:** include the value explicitly. Instead of `"show me the order"`, try:

```
show me order ORD-123
```

---

### ❌ `Circular dependency detected`

A `registry publish` was rejected because the `dependsOn` declarations form a loop.

**Fix:** look at the cycle path in the error message. Remove one of the `dependsOn`
declarations that forms the loop.

---

### ❌ `npx: command not found`

Node.js is not installed, or it is not on your system path.

**Fix:**
1. Download and install Node.js from [nodejs.org](https://nodejs.org) — choose LTS.
2. Close your terminal completely and open a new one.
3. Run `node --version` to confirm the installation.
4. Try the original command again.

---

## 📖 Glossary

| Term | Meaning |
|---|---|
| **Terminal** | A window where you type commands. Also called Command Prompt on Windows. |
| **npm / npx** | Tools that come with Node.js. `npx` runs a package without installing it permanently. |
| **Manifest** | A file that lists everything your app can do — like a menu for Claude to choose from. Generated by capman. |
| **Capability** | One specific action your app can perform, such as "look up an order". Each becomes one tool Claude can call. |
| **Capability ID** | The short machine-readable name for a capability: `get_order`, `list_products`. Used in `allowedCapabilities`. |
| **MCP** | Model Context Protocol — the standard that Claude uses to call external tools. capman-mcp speaks this protocol. |
| **Config file** | `capman-mcp.config.js` — holds your settings: where the manifest is, which capabilities Claude can use, and how to connect. |
| **Registry** | A persistent file that tracks every published capability, its approval state, risk level, and dependencies. Used in team workflows. |
| **Absolute path** | The full location of a file from the root of your computer. Example: `/Users/alice/myapp/manifest.json`. Opposite of `./manifest.json`. |
| **dryRun** | A safety mode where capman-mcp plans what it would do but does not actually call your app. Set to `false` in production. |
| **Risk level** | Automatically assigned to each capability: `low` (read-only public), `medium` (writes or private data), `high` (admin or financial). High-risk capabilities are blocked by default. |
| **stdio** | The channel Claude Desktop uses to talk to capman-mcp. You do not need to configure this — just keep `transport: 'stdio'` in your config. |