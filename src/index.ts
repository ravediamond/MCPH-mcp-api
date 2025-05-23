import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
import { requireApiKeyAuth, apiKeyAuthMiddleware } from "./lib/apiKeyAuth.js";
import {
  getFileMetadata,
  FILES_COLLECTION,
  incrementUserToolUsage,
  db,
} from "./services/firebaseService.js";
import {
  getSignedDownloadUrl,
  getFileContent,
  generateUploadUrl,
  uploadFile,
} from "./services/storageService.js";
import { getEmbedding } from "./lib/vertexAiEmbedding.js";
import util from "util";

// Global error handlers for better diagnostics
process.on("unhandledRejection", (reason, promise) => {
  console.error(
    "Unhandled Rejection at:",
    promise,
    "reason:",
    reason instanceof Error
      ? reason.stack || reason.message
      : util.inspect(reason, { depth: null }),
  );
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error(
    "Uncaught Exception:",
    err instanceof Error
      ? err.stack || err.message
      : util.inspect(err, { depth: null }),
  );
  process.exit(1);
});

// Load environment variables
dotenv.config({ path: ".env.local" });

const app = express();
app.use(express.json());

// Add CORS headers for API endpoints
app.use(function (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-authorization",
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  next();
});

// Zod schemas for tool arguments
const ListCratesParams = z.object({});
const GetCrateParams = z.object({
  id: z.string(),
  expiresInSeconds: z.number().int().min(1).max(86400).optional(),
});
const UploadCrateParams = z.object({
  fileName: z.string(),
  contentType: z.string(),
  data: z.string().optional(), // base64-encoded if present
  ttlDays: z.number().int().min(1).max(365).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  fileType: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});
const ShareCrateParams = z.object({
  id: z.string(),
  isShared: z.boolean().optional(),
  password: z.string().optional(),
});
const SearchParams = z.object({
  query: z.string(),
});

// Helper to create a new MCP server instance with real tools
function getServer() {
  const server = new McpServer({
    name: "MCPH-mcp-server",
    description: "MCPH server for handling crates and tools.",
    version: "1.0.0",
  });

  // crates/list
  server.tool("crates_list", {}, async () => {
    const snapshot = await db
      .collection(FILES_COLLECTION)
      .orderBy("uploadedAt", "desc")
      .limit(100)
      .get();
    const crates = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return {
      crates,
      content: [
        { type: "text", text: `IDs: ${crates.map((a) => a.id).join(", ")}` },
      ],
    };
  });

  // crates/get
  server.tool(
    "crates_get",
    GetCrateParams.shape,
    async ({ id, expiresInSeconds }) => {
      const meta = await getFileMetadata(id);
      if (!meta) {
        throw new Error("Crate not found");
      }
      let contentText = "";
      let contentType = meta.contentType || "";
      if (meta.fileType === "file") {
        let exp = 300;
        if (typeof expiresInSeconds === "number") {
          exp = Math.max(1, Math.min(86400, expiresInSeconds));
        }
        const url = await getSignedDownloadUrl(
          meta.id,
          meta.fileName,
          Math.ceil(exp / 60),
        );
        contentText = `Download link (valid for ${exp} seconds): ${url}`;
      } else {
        try {
          const { buffer } = await getFileContent(meta.id);
          contentText = buffer.toString("utf-8");
        } catch (e) {
          contentText = "[Error reading file content]";
        }
      }
      return {
        crate: meta,
        content: [{ type: "text", text: contentText }],
      };
    },
  );

  // crates/get_metadata
  server.tool(
    "crates_get_metadata",
    GetCrateParams.shape,
    async ({ id, expiresInSeconds }) => {
      const meta = await getFileMetadata(id);
      if (!meta) {
        throw new Error("Crate not found");
      }
      return {
        crate: meta,
        content: [
          {
            type: "text",
            text: Object.entries(meta)
              .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
              .join("\n"),
          },
        ],
      };
    },
  );

  // crates/search
  server.tool("crates_search", SearchParams.shape, async ({ query }) => {
    const embedding = await getEmbedding(query);
    let topK = 5;
    const filesRef = db.collection(FILES_COLLECTION);
    // 1. Vector search
    const vectorQuery = filesRef.findNearest("embedding", embedding, {
      limit: topK,
      distanceMeasure: "DOT_PRODUCT",
    });
    const vectorSnapshot = await vectorQuery.get();
    const vectorCrates = vectorSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    // 2. Classical search (searchText prefix, case-insensitive)
    const textQuery = query.toLowerCase();
    const classicalSnapshot = await filesRef
      .where("searchText", ">=", textQuery)
      .where("searchText", "<=", textQuery + "\uf8ff")
      .limit(topK)
      .get();
    const classicalCrates = classicalSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    // Merge and deduplicate by id
    const allCratesMap = new Map();
    for (const a of vectorCrates) allCratesMap.set(a.id, a);
    for (const a of classicalCrates) allCratesMap.set(a.id, a);
    const crates = Array.from(allCratesMap.values());
    return {
      crates,
      content: [
        { type: "text", text: `IDs: ${crates.map((a) => a.id).join(", ")}` },
      ],
    };
  });

  // crates/upload
  server.tool("crates_upload", UploadCrateParams.shape, async (args, extra) => {
    const {
      fileName,
      contentType,
      data,
      ttlDays,
      title,
      description,
      fileType,
      metadata,
    } = args;
    if (
      contentType.startsWith("application/") ||
      contentType === "binary/octet-stream"
    ) {
      // Binary: return presigned upload URL
      const { url, fileId, gcsPath } = await generateUploadUrl(
        fileName,
        contentType,
        ttlDays,
      );
      return {
        structuredContent: {},
        content: [
          {
            type: "text",
            text: `Upload your file using this URL with a PUT request: ${url}`,
          },
        ],
        uploadUrl: url,
        fileId,
        gcsPath,
      };
    } else {
      // Text: upload directly
      if (!data) {
        return {
          structuredContent: {},
          content: [{ type: "text", text: "Missing data for text upload" }],
          isError: true,
        };
      }
      const buffer = Buffer.from(data, "base64");
      // --- EMBEDDING GENERATION ---
      let embedding = undefined;
      try {
        const metaString = metadata
          ? Object.entries(metadata)
            .map(([k, v]) => `${k}: ${v}`)
            .join(" ")
          : "";
        const concatText = [title, description, metaString]
          .filter(Boolean)
          .join(" ");
        if (concatText.trim().length > 0) {
          embedding = await getEmbedding(concatText);
        }
      } catch (e) {
        console.error("Failed to generate embedding:", e);
      }
      const fileMeta = await uploadFile(
        buffer,
        fileName,
        contentType,
        ttlDays,
        title,
        description,
        fileType,
        metadata,
      );
      // Store embedding in Firestore if present
      if (embedding && fileMeta.id) {
        await db
          .collection(FILES_COLLECTION)
          .doc(fileMeta.id)
          .update({ embedding });
      }
      return {
        structuredContent: {},
        content: [{ type: "text", text: "Text crate uploaded successfully." }],
        crate: fileMeta,
      };
    }
  });

  // crates/share
  server.tool("crates_share", ShareCrateParams.shape, async (args, extra) => {
    const { id, isShared, password } = args;
    const fileRef = db.collection(FILES_COLLECTION).doc(id);
    const update = {} as any;
    if (typeof isShared === "boolean") update.isShared = isShared;
    if (typeof password === "string") update.password = password;
    await fileRef.update(update);
    // Return the shareable link and status
    const shareUrl = `${process.env.NEXT_PUBLIC_BASE_URL || "https://mcph.io"}/crate/${id}`;
    return {
      structuredContent: {},
      content: [
        {
          type: "text",
          text: `Crate ${id} is now ${update.isShared ? "shared" : "private"}. Shareable link: ${shareUrl}`,
        },
      ],
      id,
      isShared: update.isShared,
      password: !!update.password,
      shareUrl,
    };
  });

  return server;
}

// Stateless MCP endpoint (modern Streamable HTTP, stateless)
app.post("/", apiKeyAuthMiddleware, async (req, res) => {
  console.log(
    `[${new Date().toISOString()}] Incoming POST / from ${req.ip || req.socket.remoteAddress}`,
  );
  console.log("Request body:", JSON.stringify(req.body));
  try {
    const server = getServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    // Add event listener for tool calls to track usage
    server.on("toolCall", async (toolName: string) => {
      try {
        if (req.user && req.user.userId) {
          const userId = req.user.userId;
          const usage = await incrementUserToolUsage(userId);
          console.log(`Tool usage incremented for user ${userId}: ${toolName}, count: ${usage.count}, remaining: ${usage.remaining}`);
        }
      } catch (err) {
        console.error("Error incrementing tool usage:", err);
      }
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

// Optionally, reject GET/DELETE on / for clarity
app.get("/", (req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed.",
    },
    id: null,
  });
});
app.delete("/", (req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed.",
    },
    id: null,
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`MCPH listening on http://localhost:${PORT}/`);
});
