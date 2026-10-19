// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const helper = path.resolve(import.meta.dirname, "../../../agents/hermes/startup-completion.py");

function probe(body: string) {
  return spawnSync(
    "python3",
    [
      "-I",
      "-c",
      `
import importlib.util, json, os, pathlib, tempfile
spec = importlib.util.spec_from_file_location("completion", ${JSON.stringify(helper)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
observe_process = m.process_identity
supervisor = {"pid": os.getppid(), "parent": 1, "start": "10"}
gateway = {"pid": 999999, "parent": os.getppid(), "start": "20"}
identities = {supervisor["pid"]: supervisor, gateway["pid"]: gateway}
m.process_identity = lambda pid: identities.get(pid)
with tempfile.TemporaryDirectory() as root:
    os.chown(root, os.geteuid(), os.getegid())
    receipt = str(pathlib.Path(root) / "completion.json")
    def publish():
        m.publish_completion(gateway["pid"], receipt)
    def rejected(action, message):
        try:
            action()
        except (RuntimeError, OSError) as error:
            assert message in str(error), str(error)
        else:
            raise AssertionError("unsafe receipt was accepted")
${body
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}
`,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
}

describe("Hermes supervisor startup completion", () => {
  it("keeps the separate root startup protocol and rejects an untrusted root marker", () => {
    const result = probe(`
import stat, types
marker = str(pathlib.Path(root) / "root-lifecycle")
assert m.requires_completion(marker)
pathlib.Path(marker).write_text("root-separated\\n")
os.chmod(marker, 0o444)
rejected(lambda: m.requires_completion(marker), "Invalid Hermes root lifecycle marker")
real_fstat = os.fstat
def root_marker_metadata(fd):
    value = real_fstat(fd)
    return types.SimpleNamespace(st_mode=value.st_mode, st_nlink=value.st_nlink, st_uid=0, st_gid=0)
os.fstat = root_marker_metadata
assert not m.requires_completion(marker)
os.chmod(marker, 0o644)
rejected(lambda: m.requires_completion(marker), "Invalid Hermes root lifecycle marker")
os.fstat = real_fstat
`);
    expect(result.status, result.stderr).toBe(0);
  });

  it("observes process start identity and rejects dead or differently owned processes", () => {
    const result = probe(`
proc = pathlib.Path(root) / "123"
proc.mkdir()
fields = ["S", "100"] + ["0"] * 17 + ["456"]
def write_stat():
    (proc / "stat").write_text("123 (process name) " + " ".join(fields))
write_stat()
(proc / "status").write_text(f"Uid:\\t{os.geteuid()}\\t{os.geteuid()}\\t{os.geteuid()}\\t{os.geteuid()}\\n")
m.Path = lambda _path: proc
assert observe_process(123) == {"pid": 123, "parent": 100, "start": "456"}
fields[0] = "Z"
write_stat()
assert observe_process(123) is None
fields[0] = "S"
write_stat()
(proc / "status").write_text("Uid:\\t0\\t0\\t0\\t0\\n")
assert observe_process(123) is None
assert observe_process(True) is None
`);
    expect(result.status, result.stderr).toBe(0);
  });

  it("waits for publication before inspection and rejects a dead or reused gateway", () => {
    const result = probe(`
assert m.read_completion(receipt) is None
calls = []
def finish_startup(_interval):
    calls.append("finish startup writes")
    publish()
m.time.sleep = finish_startup
observed = m.wait_for_completion(path=receipt)
assert calls == ["finish startup writes"]
assert observed["gateway"] == gateway
identities.pop(gateway["pid"])
assert m.read_completion(receipt) is None
identities[gateway["pid"]] = {**gateway, "start": "21"}
assert m.read_completion(receipt) is None
rejected(lambda: m.wait_for_completion(timeout=0, path=receipt), "completion was not observed")
`);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["symlink", "hardlink", "writable", "malformed", "parent", "oversized"])(
    "rejects a %s receipt without replacing it",
    (kind) => {
      const result = probe(`
publish()
kind = ${JSON.stringify(kind)}
if kind == "symlink":
    os.rename(receipt, receipt + ".target")
    os.symlink(receipt + ".target", receipt)
elif kind == "hardlink":
    os.link(receipt, receipt + ".link")
elif kind == "writable":
    os.chmod(receipt, 0o666)
elif kind == "malformed":
    pathlib.Path(receipt).write_text("{broken")
elif kind == "parent":
    value = json.loads(pathlib.Path(receipt).read_text())
    value["gateway"]["parent"] += 1
    pathlib.Path(receipt).write_text(json.dumps(value))
elif kind == "oversized":
    pathlib.Path(receipt).write_text("x" * 1025)
before = os.lstat(receipt)
rejected(lambda: m.read_completion(receipt), "")
rejected(publish, "")
assert os.lstat(receipt) == before
`);
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it("rejects a receipt replaced while its descriptor is being read", () => {
    const result = probe(`
publish()
read = os.read
def raced_read(fd, count):
    data = read(fd, count)
    os.rename(receipt, receipt + ".old")
    pathlib.Path(receipt).write_bytes(data)
    os.chmod(receipt, 0o600)
    return data
os.read = raced_read
rejected(lambda: m.read_completion(receipt), "changed while reading")
`);
    expect(result.status, result.stderr).toBe(0);
  });

  it("refuses publication when the gateway is no longer the supervisor's child", () => {
    const result = probe(`
identities[gateway["pid"]] = {**gateway, "parent": 5}
rejected(publish, "live supervised gateway")
assert not os.path.exists(receipt)
`);
    expect(result.status, result.stderr).toBe(0);
  });
});
