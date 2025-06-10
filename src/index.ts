import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
import {
  requireApiKeyAuth,
  apiKeyAuthMiddleware,
  AuthenticatedRequest,
} from "./lib/apiKeyAuth.js";
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
  deleteCrate,
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
const GetCrateByPresignedUrlParams = z.object({
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
  isPublic: z.boolean().optional().default(false),
  password: z.string().optional(),
});
const ShareCrateParams = z.object({
  id: z.string(),
  public: z.boolean().optional(),
  sharedWith: z.array(z.string()).optional(),
  passwordProtected: z.boolean().optional(),
});
const UnshareCrateParams = z.object({
  id: z.string(),
});
const DeleteCrateParams = z.object({
  id: z.string(),
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
            req.clientName,
          );
          console.log(
            `Tool usage incremented for user ${userId}: ${toolName}, client: ${req.clientName || "unknown"}, count: ${usage.count}, remaining: ${usage.remaining}`,
          );
        } else {
          console.warn(
            "DEBUG tool usage tracking: req.user or req.user.userId missing",
          );
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

    const crates: Array<
      Partial<Crate> & {
        id: string;
        expiresAt: string | null;
        contentType?: string;
        category?: CrateCategory;
      }
    > = snapshot.docs.map((doc) => {
      const data = doc.data();
      // Filter out unwanted properties
      const { embedding, searchField, gcsPath, ...filteredData } = data;
      return {
        id: doc.id,
        ...filteredData,
        contentType: data.mimeType, // Add contentType
        category: data.category, // Add category
        // Calculate expiration date if ttlDays is present
        expiresAt: data.ttlDays
          ? new Date(
            new Date(data.createdAt.toDate()).getTime() +
            data.ttlDays * 24 * 60 * 60 * 1000,
          ).toISOString()
          : null,
      };
    });

    return {
      crates,
      content: [
        {
          type: "text",
          text: crates
            .map(
              (c) =>
                `ID: ${c.id}\nTitle: ${c.title || "Untitled"}\n` +
                `Description: ${c.description || "No description"}\n` +
                `Category: ${c.category || "N/A"}\n` + // Add category
                `Content Type: ${c.contentType || "N/A"}\n` + // Add contentType
                `Tags: ${c.tags?.join(", ") || "None"}\n` +
                `Expires: ${c.expiresAt || "Never"}\n`,
            )
            .join("\n---\n"),
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
      const exp =
        typeof expiresInSeconds === "number"
          ? Math.max(1, Math.min(86400, expiresInSeconds))
          : 300;

      // Special handling for BINARY and DATA categories - direct user to use crates_get_by_presigned_url instead
      if (meta.category === CrateCategory.BINARY || meta.category === CrateCategory.DATA) {
        return {
          content: [
            {
              type: "text",
              text: `This crate contains ${meta.category.toLowerCase()} content. Please use the 'crates_get_by_presigned_url' tool to get a download link for this content.\n\nExample: { "id": "${meta.id}" }`,
            },
          ],
        };
      }

      // Get pre-signed URL regardless of type
      const url = await getSignedDownloadUrl(
        meta.id,
        meta.title,
        Math.ceil(exp / 60),
      );

      // Handle images differently with image content type
      if (meta.category === CrateCategory.IMAGE) {
        try {
          // Fetch the image content
          const result = await getCrateContent(meta.id);

          // Convert to base64
          const base64 = result.buffer.toString("base64");

          // Determine the correct MIME type or default to image/png
          const mimeType = meta.mimeType || "image/png";

          return {
            content: [
              {
                type: "image",
                data: base64,
                mimeType: mimeType,
              },
            ],
          };
        } catch (error) {
          console.error(`Error fetching image content for crate ${id}:`, error);
          // Fallback to URL if fetching content fails
          return {
            content: [
              {
                type: "text",
                text: `![${meta.title || "Image"}](${url})`,
              },
            ],
          };
        }
      }
      // For text-based categories like CODE, JSON, MARKDOWN, etc., return the actual content
      else {
        try {
          // Fetch the content
          const result = await getCrateContent(meta.id);

          // Convert buffer to text
          const textContent = result.buffer.toString("utf-8");

          return {
            content: [
              {
                type: "text",
                text: textContent,
              },
            ],
          };
        } catch (error) {
          console.error(`Error fetching content for crate ${id}:`, error);
          // Fallback to URL if fetching content fails
          return {
            resources: [
              {
                uri: `crate://${meta.id}`,
                contents: [
                  {
                    uri: url,
                    title: meta.title,
                    description: meta.description,
                    contentType: meta.mimeType,
                  },
                ],
              },
            ],
            content: [
              {
                type: "text",
                text: `Crate "${meta.title}" is available at crate://${meta.id}`,
              },
            ],
          };
        }
      }
    },
  );

  // crates/get_by_presigned_url
  server.tool(
    "crates_get_by_presigned_url",
    GetCrateByPresignedUrlParams.shape,
    async ({ id, expiresInSeconds }, extra) => {
      const meta = await getCrateMetadata(id);
      if (!meta) {
        throw new Error("Crate not found");
      }

      // Default expiration time (5 minutes) if not specified
      const exp =
        typeof expiresInSeconds === "number"
          ? Math.max(1, Math.min(86400, expiresInSeconds))
          : 300;

      // Get pre-signed URL regardless of type
      const url = await getSignedDownloadUrl(
        meta.id,
        meta.title,
        Math.ceil(exp / 60),
      );

      return {
        content: [
          {
            type: "text",
            text: `Download link for crate ${meta.title}: ${url}`,
          },
        ],
        url,
      };
    },
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
    const crates: Array<
      Partial<Crate> & {
        id: string;
        expiresAt: string | null;
        contentType?: string;
        category?: CrateCategory;
      }
    > = allCrates.map((doc) => {
      // Filter out unwanted properties
      const { embedding, searchField, gcsPath, ...filteredData } = doc;
      return {
        id: doc.id,
        ...filteredData,
        contentType: doc.mimeType, // Add contentType
        category: doc.category, // Add category
        // Calculate expiration date if ttlDays is present
        expiresAt:
          doc.ttlDays && doc.createdAt
            ? new Date(
              new Date(doc.createdAt.toDate()).getTime() +
              doc.ttlDays * 24 * 60 * 60 * 1000,
            ).toISOString()
            : null,
      };
    });

    return {
      crates,
      content: [
        {
          type: "text",
          text:
            crates.length > 0
              ? crates
                .map(
                  (c) =>
                    `ID: ${c.id}\nTitle: ${c.title || "Untitled"}\n` +
                    `Description: ${c.description || "No description"}\n` +
                    `Category: ${c.category || "N/A"}\n` + // Add category
                    `Content Type: ${c.contentType || "N/A"}\n` + // Add contentType
                    `Tags: ${c.tags?.join(", ") || "None"}\n` +
                    `Expires: ${c.expiresAt || "Never"}\n`,
                )
                .join("\n---\n")
              : `No crates found matching "${query}"`,
        },
      ],
    };
  });

  // crates/upload
  server.tool("crates_upload", UploadCrateParams.shape, async (args, extra) => {
    const {
      fileName, // Original fileName from args
      contentType,
      data,
      ttlDays,
      title, // Original title from args
      description,
      category, // Original category from args
      tags,
      metadata,
      isPublic,
      password,
    } = args;

    // Ensure we have a proper fileName for JSON content
    let effectiveFileName = fileName;
    if (
      (!effectiveFileName || effectiveFileName.trim() === "") &&
      contentType === "application/json"
    ) {
      const baseNameSource =
        title && title.trim() !== "" ? title.trim() : "untitled";
      effectiveFileName = `${baseNameSource.replace(/[/\\0?%*:|"<>.\\s]/g, "_")}.json`;
    } else if (!effectiveFileName || effectiveFileName.trim() === "") {
      const baseNameSource =
        title && title.trim() !== "" ? title.trim() : "untitled";
      // Sanitize, removing potentially problematic characters including dots from the base name
      const baseName = baseNameSource.replace(/[/\\0?%*:|"<>.\\s]/g, "_");

      let extension = "";
      if (category) {
        switch (category) {
          case CrateCategory.JSON:
            extension = ".json";
            break;
          case CrateCategory.IMAGE:
            extension = ".png";
            break;
          case CrateCategory.MARKDOWN:
            extension = ".md";
            break;
          case CrateCategory.CODE:
            extension = ".txt";
            break;
          case CrateCategory.BINARY:
            extension = ".bin";
            break;
          case CrateCategory.DATA:
            extension = ".dat";
            break;
          case CrateCategory.TODOLIST:
            extension = ".todolist";
            break;
          case CrateCategory.DIAGRAM:
            extension = ".mmd";
            break;
          default:
            extension = ".dat";
        }
      } else if (contentType) {
        if (contentType === "application/json") extension = ".json";
        else if (contentType === "image/jpeg" || contentType === "image/jpg")
          extension = ".jpg";
        else if (contentType === "image/png") extension = ".png";
        else if (contentType === "image/gif") extension = ".gif";
        else if (contentType === "image/webp") extension = ".webp";
        else if (contentType === "image/svg+xml") extension = ".svg";
        else if (contentType === "text/markdown") extension = ".md";
        else if (contentType === "text/csv") extension = ".csv";
        else if (contentType.includes("javascript")) extension = ".js";
        else if (contentType.includes("typescript")) extension = ".ts";
        else if (contentType.includes("python")) extension = ".py";
        else if (contentType.startsWith("text/")) extension = ".txt";
        else if (
          contentType.startsWith("application/octet-stream") ||
          contentType.startsWith("binary/")
        )
          extension = ".bin";
        else extension = ".dat";
      } else {
        extension = ".dat";
      }
      effectiveFileName = `${baseName}${extension}`;
    }

    // Create the partial crate data
    const partialCrate: Partial<Crate> = {
      title: title || effectiveFileName, // Use original title, or fallback to effectiveFileName
      description,
      ttlDays,
      ownerId: req?.user?.userId || "anonymous",
      shared: {
        public: isPublic,
        passwordProtected: !!password,
        password: password, // Store the actual password (or a hash of it)
      },
    };

    // Only add tags if they exist and are a non-empty array
    if (tags && Array.isArray(tags) && tags.length > 0) {
      partialCrate.tags = tags;
    }

    // Only add metadata if it exists
    if (metadata && Object.keys(metadata).length > 0) {
      partialCrate.metadata = metadata;
    }

    if (category) {
      partialCrate.category = category;
    }

    // Determine if we should return a presigned URL or directly upload
    const isBinaryOrDataCategory =
      category === CrateCategory.BINARY || category === CrateCategory.DATA;
    const isBinaryContentType =
      contentType.startsWith("application/") ||
      contentType === "binary/octet-stream";

    const isBigDataType =
      category === CrateCategory.DATA ||
      category === CrateCategory.BINARY ||
      contentType === "text/csv" ||
      contentType.startsWith("application/octet-stream") ||
      contentType.startsWith("binary/");

    if (isBigDataType && !data) {
      const { url, fileId, gcsPath } = await generateUploadUrl(
        effectiveFileName,
        contentType,
        ttlDays,
      );
      return {
        content: [
          {
            type: "text",
            text: `Upload your file using this URL with a PUT request: ${url}. Crate ID: ${fileId}`,
          },
        ],
        uploadUrl: url,
        crateId: fileId,
        gcsPath,
      };
    }

    if (!data) {
      return {
        content: [{ type: "text", text: "Missing data for direct upload" }],
        isError: true,
      };
    }

    const buffer = Buffer.from(data, "utf8");

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
      effectiveFileName,
      contentType,
      partialCrate,
    );

    // Store embedding in Firestore if present
    if (embedding && crate.id) {
      await db
        .collection(CRATES_COLLECTION)
        .doc(crate.id)
        .update({ embedding });
    }

    return {
      content: [
        {
          type: "text",
          text: `Crate uploaded successfully. Crate ID: ${crate.id}`,
        },
      ],
      crate,
    };
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
    if (typeof isPublic === "boolean")
      sharingUpdate["shared.public"] = isPublic;
    if (Array.isArray(sharedWith))
      sharingUpdate["shared.sharedWith"] = sharedWith;
    if (typeof passwordProtected === "boolean")
      sharingUpdate["shared.passwordProtected"] = passwordProtected;

    await crateRef.update(sharingUpdate);

    // Return the shareable link and status
    const shareUrl = `${process.env.NEXT_PUBLIC_BASE_URL || "https://mcph.io"}/crate/${id}`;
    return {
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

  // crates/unshare
  server.tool(
    "crates_unshare",
    UnshareCrateParams.shape,
    async (args, extra) => {
      const { id } = args;
      const crateRef = db.collection(CRATES_COLLECTION).doc(id);

      // Get current crate to validate ownership
      const crateDoc = await crateRef.get();
      if (!crateDoc.exists) {
        throw new Error("Crate not found");
      }

      const crateData = crateDoc.data();
      if (req?.user?.userId && crateData?.ownerId !== req.user.userId) {
        throw new Error("You don't have permission to unshare this crate");
      }

      // Update sharing settings to remove all sharing
      const sharingUpdate = {
        "shared.public": false,
        "shared.sharedWith": [],
        "shared.passwordProtected": false,
        // Optionally, clear the password if it's stored directly and not hashed
        // 'shared.password': null, // orFieldValue.delete() if you want to remove the field
      };

      await crateRef.update(sharingUpdate);

      return {
        content: [
          {
            type: "text",
            text: `Crate ${id} has been unshared. It is now private.`,
          },
        ],
        id,
      };
    },
  );

  // crates/delete
  server.tool("crates_delete", DeleteCrateParams.shape, async (args, extra) => {
    const { id } = args;

    try {
      // Check if the crate exists first
      const crate = await getCrateMetadata(id);
      if (!crate) {
        throw new Error("Crate not found");
      }

      // Check if the user has permission to delete this crate
      if (req?.user?.userId && crate.ownerId !== req.user.userId) {
        throw new Error("You don't have permission to delete this crate");
      }

      // Use the deleteCrate function from storageService
      const result = await deleteCrate(id, req?.user?.userId);

      if (!result) {
        throw new Error("Failed to delete crate");
      }

      return {
        content: [
          {
            type: "text",
            text: `Crate ${id} has been successfully deleted.`,
          },
        ],
        id,
      };
    } catch (error) {
      console.error("Error deleting crate:", error);
      // Type guard to handle 'unknown' error type
      if (error instanceof Error) {
        throw new Error(error.message);
      } else {
        throw new Error("Failed to delete crate");
      }
    }
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
  console.log(`MCPH ready to go!`);
});
