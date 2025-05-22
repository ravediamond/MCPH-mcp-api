# MCPH-mcp-api

MCPHub is a public remote crate server for the Model Context Protocol (MCP). It supports real-time crate management and sharing via the MCP protocol..
MCP api implementation for MPCH

## Quick Start

- **SSE Endpoint:** `https://mcp.mcph.io/api/`
- **Web UI:** [mcph.io](https://mcph.io)
- **Crate Page:** `https://mcph.io/crate/[id]`

### Connect with mcp-remote

```sh
npx -y mcp-remote@latest https://mcp.mcph.io/ --header "Authorization: Bearer API_KEY" --transport http-only --allow-http
```

```json
{
  "mcpServers": {
    "mcph": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "http://mcp.mcph.io/",
        "--header",
        "Authorization: Bearer API_KEY",
        "--transport",
        "http-only"
      ]
    }
  }
}
```

### debug

```sh
npx -y -p mcp-remote@latest mcp-remote-client http://localhost:8080/ --header "Authorization: Bearer API_KEY" --transport http-only --allow-http
```

```sh
npx -y -p mcp-remote@latest mcp-remote-client http://mcp.mcph.io/ --header "Authorization: Bearer API_KEY" --transport http-only --allow-http
```

### Authentication

Pass your API key as a Bearer token in the `Authorization` header if required.

## Available MCP Tools (via SSE)

- **crates_list**: List all available crate.
  - Output: `{ crates: [ { id, fileName, ... }, ... ], content: [ { type: 'text', text: 'IDs: ...' } ] }`
- **crates_get**: Get the raw crates data for a specific crate by id.
  - Output: `{ crates: { ...meta }, content: [ { type: 'text', text: '...' } ] }` (binary files return a download link)
- **crates_get_metadata**: Get all metadata fields as text for a specific crate by id.
  - Output: `{ crate: { ...meta }, content: [ { type: 'text', text: 'key: value\n...' } ] }`
- **crates_search**: Search for crates by query string in fileName or description.
  - Output: `{ crates: [ ... ], content: [ { type: 'text', text: 'IDs: ...' } ] }`
- **crates_upload**: Upload a new crate. For binary files, returns a presigned upload URL. For text, uploads directly.
  - Output: `{ uploadUrl, fileId, gcsPath, message }` (binary) or `{ crate, message }` (text)
- **crates_share**: Make an crate shareable (public link) and optionally set/remove a password.
  - Output: `{ id, isShared, password, shareUrl, message }`

## How the SSE Endpoint Works

- Connect via SSE: `npx mcp-remote https://mcp.mcph.io/mcp`
- On connect, you receive an `endpoint` event with your session URL. All JSON-RPC requests must include your `sessionId` as a query parameter.
- Send JSON-RPC requests to the endpoint. Example for `crates/list`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "crates/list",
    "arguments": {}
  }
}
```

The response will be streamed as an SSE `message` event with the result.

## Learn More

- [MCP Protocol Overview](https://github.com/cloudflare/agents/tree/main/examples/mcp)
- [mcp-remote npm package](https://www.npmjs.com/package/mcp-remote)
- [mcph.io](https://mcph.io)

---

MCPHub is open for public use. For questions or feedback, visit [mcph.io](https://mcph.io).
