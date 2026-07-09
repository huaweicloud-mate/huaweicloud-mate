#!/usr/bin/env node
import { runMetaStdioServer } from "./metamcp/mcp.js";

runMetaStdioServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
