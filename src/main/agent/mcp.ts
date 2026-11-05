import { runRelay } from './relay';

/**
 * The entry point of `carbon mcp` (out/main/mcp.js), run by the installed
 * app's Electron in node mode. See relay.ts and docs/MCP.md.
 */
void runRelay().then((code) => process.exit(code));
