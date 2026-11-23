#!/usr/bin/env python3
"""Drive a Claude Desktop build the way the app does: stream-json over stdio, the MCP server served by the host (SDK transport).

Usage: fence-probe-desktop.py <claude> <server> <marker-file> [prompt]. Prints one line: listed called denied ran searched found (searched/found count ToolSearch calls and those that returned the tool).
"""
import json, subprocess, sys, os, threading
claude, server, marker = sys.argv[1], sys.argv[2], sys.argv[3]
prompt = sys.argv[4] if len(sys.argv) > 4 else f"Call the tool mcp__{server}__ping once with no arguments, then report in one line what happened."
p = subprocess.Popen([claude, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                      "--model", "haiku", "--permission-mode", "bypassPermissions", "--max-turns", "4", "--await-initialize", "--setting-sources", "user,project,local", "--permission-prompt-tool", "stdio", "--replay-user-messages", "--include-partial-messages"] + (["--resume", os.environ["RESUME"]] if os.environ.get("RESUME") else []),
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
def send(o): p.stdin.write(json.dumps(o) + "\n"); p.stdin.flush()
send({"type": "control_request", "request_id": "init", "request": {"subtype": "initialize", "sdkMcpServers": [server]}})
send({"type": "user", "message": {"role": "user", "content": prompt}})
called = denied = listed = 0
ping_ids = set(); search_ids = set(); searched = found = 0; outcome = ''; said = ''
threading.Timer(150, p.kill).start()
for line in p.stdout:
    try: j = json.loads(line)
    except ValueError: continue
    t = j.get("type")
    if t == "control_request" and j["request"].get("subtype") == "mcp_message":
        m = j["request"]["message"]; method = m.get("method"); rid = m.get("id")
        if rid is None: resp = {"jsonrpc": "2.0", "result": {}}
        elif method == "initialize": resp = {"jsonrpc": "2.0", "id": rid, "result": {"protocolVersion": m["params"].get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}}, "serverInfo": {"name": "probe", "version": "1"}}}
        elif method == "tools/list": resp = {"jsonrpc": "2.0", "id": rid, "result": {"tools": [{"name": "ping", "description": "Records a call.", "inputSchema": {"type": "object", "properties": {}}}]}}
        elif method == "tools/call":
            open(marker, "a").write("ran\n"); resp = {"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": "pong"}]}}
        else: resp = {"jsonrpc": "2.0", "id": rid, "result": {}}
        send({"type": "control_response", "response": {"subtype": "success", "request_id": j["request_id"], "response": {"mcp_response": resp}}})
    elif t == "system" and j.get("subtype") == "init":
        listed = sum(1 for n in j.get("tools", []) if n == f"mcp__{server}__ping")
    elif t == "assistant":
        for b in j["message"].get("content", []):
            if b.get("type") == "tool_use" and b.get("name") == f"mcp__{server}__ping": called += 1; ping_ids.add(b.get("id"))
            if b.get("type") == "tool_use" and b.get("name") == "ToolSearch": searched += 1; search_ids.add(b.get("id"))
            if b.get("type") == "text": said = b["text"]
    elif t == "user":
        c = j["message"].get("content")
        for b in c if isinstance(c, list) else []:
            if b.get("type") == "tool_result" and "guardrails" in json.dumps(b.get("content")): denied += 1
            if b.get("type") == "tool_result" and b.get("tool_use_id") in search_ids and f"mcp__{server}__ping" in json.dumps(b.get("content")): found += 1
            if b.get("type") == "tool_result" and b.get("tool_use_id") in ping_ids: outcome = json.dumps(b.get("content"))[:120]
    elif t == "result": break
p.stdin.close(); p.terminate()
print(f"listed={listed} called={called} denied={denied} ran={os.path.exists(marker)}", file=sys.stderr)
print(f"result={outcome!r} said={said[:200]!r}", file=sys.stderr)
print(f"listed={listed} called={called} denied={denied} ran={os.path.exists(marker)} searched={searched} found={found}")
