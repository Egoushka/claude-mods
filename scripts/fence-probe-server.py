#!/usr/bin/env python3
"""A stand-in MCP server for scripts/probe-fence.sh: one tool, `ping`, that records that it ran.

Speaks newline-delimited JSON-RPC on stdio. argv[1] is the marker file `ping` appends to.
"""
import json, sys

marker = sys.argv[1]
for line in sys.stdin:
    try:
        req = json.loads(line)
    except ValueError:
        continue
    method, rid = req.get("method"), req.get("id")
    if rid is None:
        continue
    if method == "initialize":
        result = {"protocolVersion": req["params"].get("protocolVersion", "2025-06-18"),
                  "capabilities": {"tools": {}}, "serverInfo": {"name": "fence-probe", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "ping", "description": "Records a call. Call it once when asked.",
                             "inputSchema": {"type": "object", "properties": {}}}]}
    elif method == "tools/call":
        with open(marker, "a") as f:
            f.write("ran\n")
        result = {"content": [{"type": "text", "text": "pong"}]}
    else:
        result = {}
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}) + "\n")
    sys.stdout.flush()
