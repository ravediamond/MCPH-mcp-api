import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
import { requireApiKeyAuth, apiKeyAuthMiddleware, AuthenticatedRequest } from "./lib/apiKeyAuth.js";
import {
  getCrateMetadata,
  CRATES_COLLECTION,
  incrementUserToolUsage,
  db,
} from "./services/firebaseService.js";
import {
  getSignedDownloadUrl,
  getCrateContent,
  generateUploadUrl,
  uploadCrate,
} from "./services/storageService.js";
import { getEmbedding } from "./lib/vertexAiEmbedding.js";
import util from "util";
import { Crate, CrateCategory } from "./types/crate.js";

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
  category: z.nativeEnum(CrateCategory).optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  shared: z.object({
    public: z.boolean(),
    sharedWith: z.array(z.string()).optional(),
    passwordProtected: z.boolean().optional()
  }).optional(),
});
const ShareCrateParams = z.object({
  id: z.string(),
  public: z.boolean().optional(),
  sharedWith: z.array(z.string()).optional(),
  passwordProtected: z.boolean().optional(),
});
const SearchParams = z.object({
  query: z.string(),
});

// Helper to create a new MCP server instance with real tools
function getServer(req?: AuthenticatedRequest) {
  const server = new McpServer({
    name: "MCPH-mcp-server",
    description: "MCPH server for handling crates and tools.",
    version: "1.0.0",
  });

  // --- WRAP TOOL REGISTRATION FOR USAGE TRACKING ---
  const originalTool = server.tool;
  server.tool = function (...args: any[]) {
    const toolName = args[0];
    let handler: any;
    if (args.length === 3) {
      handler = args[2];
    } else if (args.length >= 4) {
      handler = args[args.length - 1];
    }
    if (!handler) return (originalTool as any).apply(server, args);
    const wrappedHandler = async (toolArgs: any, ...rest: any[]) => {
      try {
        if (req?.user && req.user.userId) {
          const userId = req.user.userId;
          const usage = await incrementUserToolUsage(
            userId,
            toolName,
            req.clientName
          );
          console.log(
            `Tool usage incremented for user ${userId}: ${toolName}, client: ${req.clientName || 'unknown'}, count: ${usage.count}, remaining: ${usage.remaining}`
          );
        } else {
          console.warn('DEBUG tool usage tracking: req.user or req.user.userId missing');
        }
      } catch (err) {
        console.error("Error incrementing tool usage:", err);
      }
      return handler(toolArgs, ...rest);
    };
    if (args.length === 3) {
      args[2] = wrappedHandler;
    } else {
      args[args.length - 1] = wrappedHandler;
    }
    return (originalTool as any).apply(server, args);
  };

  // crates/list
  server.tool("crates_list", {}, async () => {
    const snapshot = await db
      .collection(CRATES_COLLECTION)
      .where("createdAt", ">", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)) // Filter to last 30 days
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();

    const crates: Array<Partial<Crate> & { id: string; expiresAt: string | null; contentType?: string; category?: CrateCategory }> = snapshot.docs.map((doc) => {
      const data = doc.data();
      // Filter out unwanted properties
      const { embedding, searchField, gcsPath, ...filteredData } = data;
      return {
        id: doc.id,
        ...filteredData,
        contentType: data.mimeType, // Add contentType
        category: data.category, // Add category
        // Calculate expiration date if ttlDays is present
        expiresAt: data.ttlDays ? new Date(
          new Date(data.createdAt.toDate()).getTime() +
          (data.ttlDays * 24 * 60 * 60 * 1000)
        ).toISOString() : null
      };
    });

    return {
      crates,
      content: [
        {
          type: "text",
          text: crates.map(c =>
            `ID: ${c.id}\nTitle: ${c.title || 'Untitled'}\n` +
            `Description: ${c.description || 'No description'}\n` +
            `Category: ${c.category || 'N/A'}\n` + // Add category
            `Content Type: ${c.contentType || 'N/A'}\n` + // Add contentType
            `Tags: ${c.tags?.join(', ') || 'None'}\n` +
            `Expires: ${c.expiresAt || 'Never'}\n`
          ).join('\n---\n')
        },
      ],
    };
  });

  // crates/get
  server.tool(
    "crates_get",
    GetCrateParams.shape,
    async ({ id, expiresInSeconds }, extra) => {
      const meta = await getCrateMetadata(id);
      if (!meta) {
        throw new Error("Crate not found");
      }

      // Default expiration time (5 minutes) if not specified
      const exp = typeof expiresInSeconds === "number"
        ? Math.max(1, Math.min(86400, expiresInSeconds))
        : 300;

      // Get pre-signed URL regardless of type
      const url = await getSignedDownloadUrl(
        meta.id,
        meta.title,
        Math.ceil(exp / 60)
      );

      // Handle images differently with image content type
      if (meta.category === CrateCategory.IMAGE) {
        try {
          // Fetch the image content
          const result = await getCrateContent(meta.id);

          // Convert to base64
          const base64 = result.buffer.toString('base64');

          // Determine the correct MIME type or default to image/png
          const mimeType = meta.mimeType || 'image/png';

          return {
            content: [
              {
                type: "image",
                data: base64,
                mimeType: mimeType
              }
            ]
          };
        } catch (error) {
          console.error(`Error fetching image content for crate ${id}:`, error);
          // Fallback to URL if fetching content fails
          return {
            content: [
              {
                type: "text",
                text: `![${meta.title || 'Image'}](${url})`
              }
            ]
          };
        }
      }
      // For generic binary files and data files, just send a link
      else if (meta.category === CrateCategory.BINARY || meta.category === CrateCategory.DATA) {
        return {
          content: [
            {
              type: "text",
              text: `[${meta.title || id}](${url}) (Download link valid for ${exp} seconds)`
            }
          ]
        };
      }
      // For text-based categories like CODE, JSON, MARKDOWN, etc., return the actual content
      else {
        try {
          // Fetch the content
          const result = await getCrateContent(meta.id);

          // Convert buffer to text
          const textContent = result.buffer.toString('utf-8');

          return {
            content: [
              {
                type: "text",
                text: textContent
              }
            ]
          };
        } catch (error) {
          console.error(`Error fetching content for crate ${id}:`, error);
          // Fallback to URL if fetching content fails
          return {
            resources: [
              {
                uri: `crate://${meta.id}`,
                contents: [{
                  uri: url,
                  title: meta.title,
                  description: meta.description,
                  contentType: meta.mimeType
                }]
              }
            ],
            content: [
              {
                type: "text",
                text: `Crate "${meta.title}" is available at crate://${meta.id}`
              }
            ]
          };
        }
      }
    }
  );

  // crates/search
  server.tool("crates_search", SearchParams.shape, async ({ query }) => {
    const embedding = await getEmbedding(query);
    let topK = 5;
    const cratesRef = db.collection(CRATES_COLLECTION);
    // 1. Vector search
    const vectorQuery = cratesRef.findNearest("embedding", embedding, {
      limit: topK,
      distanceMeasure: "DOT_PRODUCT",
    });
    const vectorSnapshot = await vectorQuery.get();
    const vectorCrates = vectorSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    // 2. Classical search (searchField prefix, case-insensitive)
    const textQuery = query.toLowerCase();
    const classicalSnapshot = await cratesRef
      .where("searchField", ">=", textQuery)
      .where("searchField", "<=", textQuery + "\uf8ff")
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
    const allCrates = Array.from(allCratesMap.values());

    // Format crates to match the list schema
    const crates: Array<Partial<Crate> & { id: string; expiresAt: string | null; contentType?: string; category?: CrateCategory }> = allCrates.map((doc) => {
      // Filter out unwanted properties
      const { embedding, searchField, gcsPath, ...filteredData } = doc;
      return {
        id: doc.id,
        ...filteredData,
        contentType: doc.mimeType, // Add contentType
        category: doc.category, // Add category
        // Calculate expiration date if ttlDays is present
        expiresAt: doc.ttlDays && doc.createdAt ? new Date(
          new Date(doc.createdAt.toDate()).getTime() +
          (doc.ttlDays * 24 * 60 * 60 * 1000)
        ).toISOString() : null
      };
    });

    return {
      crates,
      content: [
        {
          type: "text",
          text: crates.length > 0
            ? crates.map(c =>
              `ID: ${c.id}\nTitle: ${c.title || 'Untitled'}\n` +
              `Description: ${c.description || 'No description'}\n` +
              `Category: ${c.category || 'N/A'}\n` + // Add category
              `Content Type: ${c.contentType || 'N/A'}\n` + // Add contentType
              `Tags: ${c.tags?.join(', ') || 'None'}\n` +
              `Expires: ${c.expiresAt || 'Never'}\n`
            ).join('\n---\n')
            : `No crates found matching "${query}"`
        },
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
      category,
      tags,
      metadata,
      shared,
    } = args;

    // Create the partial crate data
    const partialCrate: Partial<Crate> = {
      title: title || fileName,
      description,
      ttlDays,
      ownerId: req?.user?.userId || "anonymous",
      tags,
      metadata,
      shared: shared || { public: false }
    };

    if (category) {
      partialCrate.category = category;
    }

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
        crateId: fileId,
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
        const tagsString = tags ? tags.join(" ") : "";
        const concatText = [title, description, tagsString, metaString]
          .filter(Boolean)
          .join(" ");
        if (concatText.trim().length > 0) {
          embedding = await getEmbedding(concatText);
        }
      } catch (e) {
        console.error("Failed to generate embedding:", e);
      }

      const crate = await uploadCrate(
        buffer,
        fileName,
        contentType,
        partialCrate
      );

      // Store embedding in Firestore if present
      if (embedding && crate.id) {
        await db
          .collection(CRATES_COLLECTION)
          .doc(crate.id)
          .update({ embedding });
      }
      return {
        structuredContent: {},
        content: [{ type: "text", text: "Crate uploaded successfully." }],
        crate,
      };
    }
  });

  // crates/share
  server.tool("crates_share", ShareCrateParams.shape, async (args, extra) => {
    const { id, public: isPublic, sharedWith, passwordProtected } = args;
    const crateRef = db.collection(CRATES_COLLECTION).doc(id);

    // Get current crate to validate ownership
    const crateDoc = await crateRef.get();
    if (!crateDoc.exists) {
      throw new Error("Crate not found");
    }

    const crateData = crateDoc.data();
    if (req?.user?.userId && crateData?.ownerId !== req.user.userId) {
      throw new Error("You don't have permission to share this crate");
    }

    // Update sharing settings
    const sharingUpdate: any = {};
    if (typeof isPublic === 'boolean') sharingUpdate['shared.public'] = isPublic;
    if (Array.isArray(sharedWith)) sharingUpdate['shared.sharedWith'] = sharedWith;
    if (typeof passwordProtected === 'boolean') sharingUpdate['shared.passwordProtected'] = passwordProtected;

    await crateRef.update(sharingUpdate);

    // Return the shareable link and status
    const shareUrl = `${process.env.NEXT_PUBLIC_BASE_URL || "https://mcph.io"}/crate/${id}`;
    return {
      structuredContent: {},
      content: [
        {
          type: "text",
          text: `Crate ${id} sharing settings updated. ${isPublic ? "Public link" : "Private link"}: ${shareUrl}`,
        },
      ],
      id,
      isPublic,
      passwordProtected,
      shareUrl,
    };
  });

  return server;
}

// Stateless MCP endpoint (modern Streamable HTTP, stateless)
app.post("/", apiKeyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
  console.log(
    `[${new Date().toISOString()}] Incoming POST / from ${req.ip || req.socket.remoteAddress}`,
  );
  console.log("Request body:", JSON.stringify(req.body));
  try {
    // Extract client name from the initialize params if available
    let clientName: string | undefined = undefined;

    // Check if this is an initialize request with name parameter
    if (req.body && req.body.method === "initialize" && req.body.params?.name) {
      clientName = req.body.params.name;
      // Store the client name on the request object for future reference
      req.clientName = clientName;
    }
    // For other jsonrpc methods, try to extract from params
    else if (req.body && req.body.params?.name) {
      clientName = req.body.params.name;
      req.clientName = clientName;
    }

    // Create a new server instance for this request
    const server = getServer(req);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
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

