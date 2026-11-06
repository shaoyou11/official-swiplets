"""Back up or deploy only the skip-chinese-ads Swiplet; no capture APIs."""
import json
import os
from pathlib import Path
import struct
import sys
import urllib.request

PLUGIN = "skip-chinese-ads"
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def varint(n):
    out = bytearray()
    while n > 127:
        out.append((n & 127) | 128)
        n >>= 7
    out.append(n)
    return bytes(out)

def value(data, offset):
    n = shift = 0
    while True:
        part = data[offset]
        offset += 1
        n |= (part & 127) << shift
        if part < 128:
            return n, offset
        shift += 7

def fields(data):
    result = {}
    offset = 0
    while offset < len(data):
        tag, offset = value(data, offset)
        field, wire = tag >> 3, tag & 7
        if wire == 0:
            item, offset = value(data, offset)
        elif wire == 2:
            size, offset = value(data, offset)
            item = data[offset:offset + size]
            offset += size
        else:
            raise ValueError("Unsupported wire type")
        result.setdefault(field, []).append(item)
    return result

def string(field, text):
    data = text.encode() if isinstance(text, str) else text
    return varint(field * 8 + 2) + varint(len(data)) + data

def rpc(method, body=b""):
    request = urllib.request.Request(
        os.environ["SWIPT_URL"] + "/swipt.SwipletService/" + method,
        data=b"\0" + struct.pack(">I", len(body)) + body,
        headers={"Authorization": "Bearer " + os.environ["SWIPT_TOKEN"],
                 "Content-Type": "application/grpc-web+proto", "X-Grpc-Web": "1"})
    with opener.open(request, timeout=40) as response:
        data = response.read()
    offset = 0
    messages = []
    trailers = None
    while offset < len(data):
        flag, size = struct.unpack(">BI", data[offset:offset + 5])
        offset += 5
        payload = data[offset:offset + size]
        offset += size
        if flag & 128:
            trailers = dict(line.split(":", 1) for line in payload.decode().splitlines() if ":" in line)
        else:
            messages.append(fields(payload))
    if trailers is None or trailers.get("grpc-status", "").strip() != "0":
        raise RuntimeError("RPC failed: " + str(trailers))
    return messages

def state():
    for reply in rpc("ListSwiplets"):
        for entry in reply.get(1, []):
            item = fields(entry)
            if item[1][0].decode() == PLUGIN:
                service = fields(item.get(6, [b""])[0])
                return {"version": item.get(3, [b""])[0].decode(),
                        "enabled": bool(service.get(1, [0])[0]),
                        "status": service.get(2, [0])[0],
                        "error": bool(service.get(3))}
    raise RuntimeError("Plugin not installed")

def enable(enabled):
    rpc("SetServiceEnabled", string(1, PLUGIN) + b"\x10" + bytes([enabled]))

if __name__ == "__main__":
    action = sys.argv[1]
    before = state()
    if action == "status":
        print(json.dumps(before))
    elif action == "backup":
        dest = Path(sys.argv[2])
        dest.mkdir(parents=True, exist_ok=False)
        enable(False)
        try:
            count = 0
            for reply in rpc("ListDataFiles", string(1, PLUGIN) + b"\x18\x01"):
                for encoded in reply.get(1, []):
                    info = fields(encoded)
                    if info.get(2, [0])[0]:
                        continue
                    relative = Path(info[1][0].decode())
                    if relative.is_absolute() or ".." in relative.parts:
                        raise ValueError("Unsafe file path")
                    target = dest / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    size = 0
                    with target.open("xb") as output:
                        for message in rpc("ReadDataFile", string(1, PLUGIN) + string(2, str(relative))):
                            if 2 in message:
                                chunk = fields(message[2][0])
                                assert chunk.get(2, [0])[0] == size
                                payload = chunk.get(3, [b""])[0]
                                output.write(payload)
                                size += len(payload)
                    assert size == info.get(3, [0])[0]
                    count += 1
            (dest / "backup-state.json").write_text(json.dumps(before))
            print(json.dumps({"backed_up_files": count, "state": before}))
        finally:
            enable(before["enabled"])
    elif action == "deploy":
        rpc("DeploySwiplet", string(1, Path(sys.argv[2]).read_bytes()))
        enable(before["enabled"])
        print(json.dumps(state()))
    else:
        raise ValueError("Unknown action")
