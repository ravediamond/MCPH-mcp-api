import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import dotenv from "dotenv";
import { randomUUID } from "crypto";

// Load environment variables
dotenv.config({ path: ".env.local" });

const app = express();
app.use(express.json());

// Helper to create a new MCP server instance with a dummy tool
function getServer() {
    const server = new McpServer({
        name: "Dummy MCP Server",
        version: "1.0.0"
    });

    // Dummy tool: returns a static message
    server.tool(
        "dummy-tool",
        { input: z.string().optional() },
        async ({ input }) => ({
            content: [
                { type: "text", text: `Hello from dummy-tool! Input was: ${input ?? "<none>"}` }
            ]
        })
    );

    return server;
}

// Stateless MCP endpoint (modern Streamable HTTP, stateless)
app.post("/mcp", async (req, res) => {
    console.log(`[${new Date().toISOString()}] Incoming POST /mcp from ${req.ip || req.socket.remoteAddress}`);
    console.log("Request body:", JSON.stringify(req.body));
    try {
        const server = getServer();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined // stateless
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
                    message: "Internal server error"
                },
                id: null
            });
        }
    }
});

// Optionally, reject GET/DELETE on /mcp for clarity
app.get("/mcp", (req, res) => {
    res.status(405).json({
        jsonrpc: "2.0",
        error: {
            code: -32000,
            message: "Method not allowed."
        },
        id: null
    });
});
app.delete("/mcp", (req, res) => {
    res.status(405).json({
        jsonrpc: "2.0",
        error: {
            code: -32000,
            message: "Method not allowed."
        },
        id: null
    });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Dummy MCP server listening on http://localhost:${PORT}/mcp`);
});
