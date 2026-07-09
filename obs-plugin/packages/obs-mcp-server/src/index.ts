#!/usr/bin/env node
import { runStdioServer } from "./server/mcp.js";

runStdioServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
