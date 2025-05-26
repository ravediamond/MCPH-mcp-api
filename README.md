# MCPH-mcp-api

MCPHub is a public remote crate server for the Model Context Protocol (MCP). It supports real-time crate management and sharing via the MCP protocol.
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

## Infrastructure as Code with Terraform

This project uses Terraform to define and manage cloud infrastructure resources on Google Cloud Platform (GCP). This includes resources like Google Artifact Registry (for Docker images) and Google Cloud Run (for serving the application).

For detailed information on Terraform setup, workspaces, and variable management, please see [terraform/environments.md](./terraform/environments.md).

### Prerequisites for Infrastructure Management

*   **Google Cloud SDK (`gcloud`):** Required for interacting with GCP. Ensure you are authenticated.
*   **Terraform CLI:** Version `~> 1.5.0` (or as specified in `terraform/versions.tf`).
*   **Docker:** Required for building container images.

## Local Development

For local development, the application is typically run directly on your machine. The local development environment does **not** use or interact with the Terraform-managed cloud resources by default.

## Deployment

Deployments to the **production environment** are automated via GitHub Actions.

### CI/CD Pipeline (GitHub Actions)

*   **On Pull Requests to `master`:**
    1.  The application is built and tested.
    2.  `terraform plan` is executed for the `prod` workspace to show proposed infrastructure changes. The plan output is commented on the Pull Request.
*   **On Pushes to `master`:**
    1.  `terraform apply` is executed for the `prod` workspace to provision or update cloud infrastructure.
    2.  A Docker image is built and pushed to Google Artifact Registry.
    3.  The Google Cloud Run service is updated with the new Docker image.

### Required GitHub Secrets for CI/CD:

The following secrets must be configured in the GitHub repository settings for the Actions workflow:

*   `GCP_SA_KEY`: JSON key for the GCP Service Account. This account needs permissions to manage Terraform state in GCS, Artifact Registry, Cloud Run, and related IAM settings.
*   `GCP_PROJECT_ID`: Your Google Cloud Project ID.
*   `REGION`: The GCP region for resources (e.g., `europe-west1`).
*   `ARTIFACT_REGISTRY_REPO`: Name of the Artifact Registry repository (e.g., `mcph`).
*   `IMAGE_NAME`: Name of the Docker image (e.g., `mcph`).
*   `RUN_SERVICE_NAME`: Name of the Cloud Run service (e.g., `mcph-prod`).
*   `TERRAFORM_STATE_BUCKET_NAME`: The globally unique name of the GCS bucket used for storing Terraform state.
*   *(Optional)* `TF_VAR_vertexai_embedding_model`, `TF_VAR_gcs_bucket_name_env`, `TF_VAR_gcs_default_bucket_location_env`: If you need to override Terraform variable defaults for these via secrets.

### Manual Deployment (Utility Script)

The `deploy.sh` script is a utility for manually building, pushing a Docker image, and updating an *existing* Cloud Run service with that new image. It does not manage infrastructure configuration (like environment variables or public access), as these are handled by Terraform.

**Usage:**
Ensure the following environment variables are set before running the script:
*   `GCP_PROJECT_ID`
*   `REGION`
*   `ARTIFACT_REGISTRY_REPO`
*   `IMAGE_NAME`
*   `RUN_SERVICE_NAME`

Then execute:
```bash
./deploy.sh
```

### Cloud Resources Managed by Terraform

The following GCP resources are defined and managed by Terraform for the `prod` environment:

*   Google Cloud Storage (GCS) bucket: For storing Terraform state.
*   Google Artifact Registry: Docker repository for application images.
*   Google Cloud Run v2 Service: For running the application.
*   IAM Binding for Cloud Run: To allow public (unauthenticated) invocations to the service.

Please refer to the files in the `terraform/` directory for the specific definitions.

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
