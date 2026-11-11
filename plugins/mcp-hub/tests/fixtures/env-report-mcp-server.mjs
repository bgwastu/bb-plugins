process.stderr.write(`HAS_LEAK=${process.env.MCP_TEST_LEAK_MARKER !== undefined}\n`);
process.stderr.write(`PATH=${process.env.PATH ?? ""}\n`);
