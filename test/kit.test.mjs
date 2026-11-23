// Tests of the relay kit: check-relay.mjs, install-relay.sh, Dockerfile and fly.toml.
//
//   npm test        (the same as: node --test test/*.test.mjs)
//
// The installer is run for real (in a temporary folder, with stand-ins for systemctl, ufw, id ... so that nothing on this
// machine is touched), and the relay it "starts" is the real server.js. The installer tests need Linux, bash and curl.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = join(ROOT, "install-relay.sh");
const CHECK = join(ROOT, "check-relay.mjs");
const SERVER = join(ROOT, "server.js");
const TMP = process.env.KIT_TEST_TMP || "/tmp";
const LINUX = process.platform === "linux";
const NEEDS_LINUX = LINUX ? false : "the installer tests need Linux";

// ---------------------------------------------------------------- helpers

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

// Runs a program without blocking this process (the servers of the tests live in it).
function run(cmd, args, { env = {}, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr, out: stdout + stderr }));
  });
}

async function waitForPort(port, tries = 100) {
  for (let i = 0; i < tries; i++) {
    const open = await new Promise((resolve) => {
      const probe = net.connect(port, "127.0.0.1");
      probe.on("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.on("error", () => resolve(false));
    });
    if (open) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

const relays = [];
// The real server.js, as a program of its own (the way Railway or systemd run it).
async function startRelay(env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, SOCKS_PORT: String(port), ...env },
    stdio: "ignore",
  });
  const relay = { port, stop: () => child.kill("SIGKILL") };
  relays.push(relay);
  assert.ok(await waitForPort(port), "the relay did not start");
  return relay;
}

const servers = [];
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return server.address().port;
}
// A TCP server that counts the connections it gets and does what `onConnection` says (default: nothing at all).
async function tcpServer(onConnection = () => {}) {
  const info = { count: 0 };
  const server = net.createServer((socket) => {
    info.count++;
    socket.on("error", () => {});
    onConnection(socket);
  });
  info.port = await listen(server);
  return info;
}

const sandboxes = [];
after(() => {
  for (const relay of relays) relay.stop();
  for (const server of servers) server.close();
  for (const sb of sandboxes) sb.cleanup();
});

const checkRelay = (args, env = {}) =>
  run(process.execPath, [CHECK, ...args], { env: { PATH: process.env.PATH, RELAY_CHECK_TIMEOUT_MS: "3000", ...env } });

// ---------------------------------------------------------------- check-relay.mjs

const LOGIN = { user: "kit-user", pass: "kit-pass-123" };
let sharedRelays = null;
async function relaysForCheck() {
  if (!sharedRelays) {
    sharedRelays = (async () => ({
      target: await tcpServer(),
      allow: await startRelay({ SOCKS_USER: LOGIN.user, SOCKS_PASS: LOGIN.pass, ALLOW_PRIVATE_DESTINATIONS: "1" }),
      strict: await startRelay({ SOCKS_USER: LOGIN.user, SOCKS_PASS: LOGIN.pass }),
      open: await startRelay({ ALLOW_OPEN: "1" }),
      utf8: await startRelay({ SOCKS_USER: "用户名", SOCKS_PASS: "密码密码密码" }),
    }))();
  }
  return sharedRelays;
}

test("check-relay: logs in and opens one test connection through the relay", async () => {
  const r = await relaysForCheck();
  const before = r.target.count;
  const res = await checkRelay(["127.0.0.1", String(r.allow.port), LOGIN.user, LOGIN.pass, "--target", `127.0.0.1:${r.target.port}`]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.stdout, new RegExp(`^OK: the login works and the relay opened a connection to 127\\.0\\.0\\.1:${r.target.port}`));
  assert.equal(r.target.count, before + 1, "the relay should have connected to the target once");
});

test("check-relay: --login-only does not open any connection", async () => {
  const r = await relaysForCheck();
  const before = r.target.count;
  const res = await checkRelay(["127.0.0.1", String(r.allow.port), LOGIN.user, LOGIN.pass, "--login-only", "--target", `127.0.0.1:${r.target.port}`]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.stdout, /^OK: the login works\s*$/);
  assert.equal(r.target.count, before);
});

test("check-relay: takes the server from the RELAY_EXTERNAL_* variables, and the target from RELAY_CHECK_TARGET", async () => {
  const r = await relaysForCheck();
  const env = {
    RELAY_EXTERNAL_HOST: "127.0.0.1",
    RELAY_EXTERNAL_PORT: String(r.allow.port),
    RELAY_EXTERNAL_USER: LOGIN.user,
    RELAY_EXTERNAL_PASS: LOGIN.pass,
    RELAY_CHECK_TARGET: `127.0.0.1:${r.target.port}`,
  };
  const before = r.target.count;
  const res = await checkRelay([], env);
  assert.equal(res.code, 0, res.out);
  assert.match(res.stdout, new RegExp(`connection to 127\\.0\\.0\\.1:${r.target.port}`));
  assert.equal(r.target.count, before + 1);
  // --target wins over the variable
  const other = await tcpServer();
  const res2 = await checkRelay(["--target", `127.0.0.1:${other.port}`], env);
  assert.equal(res2.code, 0, res2.out);
  assert.equal(other.count, 1);
});

test("check-relay: a user name and a password with Chinese characters work (the length is in bytes)", async () => {
  const r = await relaysForCheck();
  const res = await checkRelay(["127.0.0.1", String(r.utf8.port), "用户名", "密码密码密码", "--login-only"]);
  assert.equal(res.code, 0, res.out);
});

test("check-relay: a wrong password is reported as such", async () => {
  const r = await relaysForCheck();
  const res = await checkRelay(["127.0.0.1", String(r.allow.port), LOGIN.user, "not-the-password", "--login-only"]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /^FAILED \(login\): the server refused the user name \/ password/);
});

test("check-relay: the login works but the relay refuses to connect to the target", async () => {
  const r = await relaysForCheck();
  // nothing listens on port 1 of this machine: the relay answers "connection refused"
  const refused = await checkRelay(["127.0.0.1", String(r.allow.port), LOGIN.user, LOGIN.pass, "--target", "127.0.0.1:1"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /^FAILED \(connect\): the login worked, but .* 127\.0\.0\.1:1 \(SOCKS reply 5: connection refused\)/);
  // a relay that does not connect to private addresses (the normal state) answers "not allowed"
  const notAllowed = await checkRelay(["127.0.0.1", String(r.strict.port), LOGIN.user, LOGIN.pass, "--target", `127.0.0.1:${r.target.port}`]);
  assert.equal(notAllowed.code, 1);
  assert.match(notAllowed.stderr, /SOCKS reply 2: connection not allowed by the server's rules/);
});

test("check-relay: a server that needs no password is reported (the Workers log in with one)", async () => {
  const r = await relaysForCheck();
  // the relay with ALLOW_OPEN=1 only talks to clients that offer "no login": it answers "no acceptable method"
  const open = await checkRelay(["127.0.0.1", String(r.open.port), LOGIN.user, LOGIN.pass, "--login-only"]);
  assert.equal(open.code, 1);
  assert.match(open.stderr, /^FAILED \(greeting\): the server does not accept a user name \/ password login/);
  // a server that answers "no login needed" to the offer of a login
  const noAuth = await tcpServer((socket) => socket.on("data", () => socket.write(Buffer.from([5, 0]))));
  const res = await checkRelay(["127.0.0.1", String(noAuth.port), LOGIN.user, LOGIN.pass, "--login-only"]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /^FAILED \(greeting\): the server does not ask for a user name and a password/);
});

test("check-relay: other kinds of servers", async () => {
  // an HTTP server
  const web = http.createServer((req, res) => res.end("hello"));
  const webPort = await listen(web);
  const notSocks = await checkRelay(["127.0.0.1", String(webPort), "u", "p", "--login-only"]);
  assert.equal(notSocks.code, 1);
  assert.match(notSocks.stderr, /does not speak SOCKS5/);
  // a server that accepts the connection and says nothing
  const silent = await tcpServer();
  const startedAt = Date.now();
  const quiet = await checkRelay(["127.0.0.1", String(silent.port), "u", "p", "--login-only"], { RELAY_CHECK_TIMEOUT_MS: "400" });
  assert.ok(Date.now() - startedAt < 5000, "RELAY_CHECK_TIMEOUT_MS is used");
  assert.equal(quiet.code, 1);
  assert.match(quiet.stderr, /connected, but the server never answered the SOCKS5 greeting/);
  // a port where nothing listens
  const closed = await checkRelay(["127.0.0.1", String(await freePort()), "u", "p", "--login-only"]);
  assert.equal(closed.code, 1);
  assert.match(closed.stderr, /connection refused \(nothing is listening/);
  // a name that does not exist (.invalid never does; without a network the answer may also be "no answer")
  const missing = await checkRelay(["no-such-host.invalid", "1080", "u", "p", "--login-only"], { RELAY_CHECK_TIMEOUT_MS: "1500" });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /the host name does not exist|no answer from the address|cannot connect/);
});

test("check-relay: wrong usage exits with 2 and says how to use it", async () => {
  const none = await checkRelay([]);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /usage: node check-relay\.mjs/);
  for (const args of [
    ["127.0.0.1", "70000", "u", "p"],
    ["127.0.0.1", "abc", "u", "p"],
    ["127.0.0.1", "1080", "u", "p", "--target", "nonsense"],
    ["127.0.0.1", "1080", "u", "p", "--target", "host:99999"],
    ["127.0.0.1", "1080", "u"],
  ]) {
    const res = await checkRelay(args);
    assert.equal(res.code, 2, `${args.join(" ")}: ${res.out}`);
  }
  const tooLong = await checkRelay(["127.0.0.1", "1080", "u", "p".repeat(256)]);
  assert.equal(tooLong.code, 2);
  assert.match(tooLong.stderr, /at most 255 bytes/);
});

// ---------------------------------------------------------------- the files of the kit

test("the Dockerfile builds the relay as a non-root user and holds no secret", () => {
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  const code = dockerfile
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.match(code, /^ARG NODE_VERSION=(\d+)$/m);
  assert.ok(Number(/^ARG NODE_VERSION=(\d+)$/m.exec(code)[1]) >= 18);
  assert.match(code, /^FROM node:\$\{NODE_VERSION\}-slim$/m);
  assert.match(code, /^COPY package\.json server\.js \.\/$/m);
  assert.ok(existsSync(join(ROOT, "package.json")) && existsSync(SERVER));
  assert.equal(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).type, "module", "server.js is an ES module: the container needs this package.json");
  assert.match(code, /^USER node$/m);
  assert.match(code, /^CMD \["node", "server\.js"\]$/m);
  assert.match(code, /SOCKS_PORT=1080/);
  assert.match(code, /^EXPOSE 1080$/m);
  assert.doesNotMatch(code, /SOCKS_USER|SOCKS_PASS|ALLOW_OPEN/, "the login must come from the outside, never from the image");
});

test("fly.toml: a raw TCP service on the port of the Dockerfile, and a name that has to be changed", () => {
  const toml = readFileSync(join(ROOT, "fly.toml"), "utf8");
  const code = toml
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.match(code, /^app = "CHANGE-THIS-TO-A-NAME-OF-YOUR-OWN"$/m, "an app name that is not changed must fail instead of deploying somewhere");
  assert.match(code, /dockerfile = "Dockerfile"/);
  assert.match(code, /internal_port = 1080/);
  assert.match(code, /protocol = "tcp"/);
  assert.match(code, /\[\[services\.ports\]\]\s+port = 1080/);
  assert.doesNotMatch(code, /handlers/, "no handler: Fly passes the raw TCP connection on");
  assert.match(code, /SOCKS_PORT = "1080"/);
  assert.doesNotMatch(code, /SOCKS_USER|SOCKS_PASS/, "the login belongs in `fly secrets set`");
});

test("package.json: ES module, Node 18+, `npm test` runs these tests", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.type, "module");
  assert.equal(pkg.engines.node, ">=18");
  assert.match(pkg.scripts.test, /node --test/);
});

// ---------------------------------------------------------------- install-relay.sh: the sandbox

const TOOL_NAMES = [
  "awk", "bash", "cat", "chmod", "cp", "cut", "date", "dirname", "env", "grep", "gzip", "head", "id", "install", "ln", "mkdir",
  "mktemp", "mv", "nohup", "readlink", "rm", "sed", "sh", "sleep", "sha256sum", "sort", "tail", "tar", "tr", "uname", "wc",
]; // `id` is replaced by a stand-in; node, curl, ip, ufw, systemctl, journalctl are only there when a test wants them

// The program itself: the usual folders first (a wrapper that sits first on PATH, such as a safety stand-in for rm, is not it)
function commandPath(name) {
  for (const folder of ["/usr/bin", "/bin", "/usr/local/bin"]) {
    if (existsSync(join(folder, name))) return join(folder, name);
  }
  const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
  return found.startsWith("/") ? found : null;
}
const BASH = commandPath("bash");
const REAL_CURL = commandPath("curl");

// systemctl: records every call; "restart" starts the real server.js from the unit file, the way systemd would.
const SYSTEMCTL_STUB = `
echo "systemctl $*" >> "$STUB_LOG"
unit="$SOCKS_RELAY_UNIT_DIR/\${SOCKS_RELAY_SERVICE:-socks-relay}.service"
pidfile="$STUB_DIR/relay.pid"
stop_relay() { if [ -f "$pidfile" ]; then kill "$(cat "$pidfile")" 2>/dev/null || true; rm -f "$pidfile"; fi; }
case "$1" in
  --version) echo "systemd \${STUB_SYSTEMD_VERSION:-255} (test)"; echo "+PAM" ;;
  restart | start)
    stop_relay
    if [ "\${STUB_START:-1}" = "1" ]; then
      exec_line="$(sed -n 's/^ExecStart=//p' "$unit")"
      env_file="$(sed -n 's/^EnvironmentFile=//p' "$unit")"
      ( set -a; . "$env_file"; set +a; export ALLOW_PRIVATE_DESTINATIONS=1
        echo $BASHPID > "$pidfile"
        eval "exec $exec_line" >"$STUB_DIR/relay.out" 2>&1 </dev/null ) &
    fi ;;
  disable) stop_relay ;;
esac
exit 0
`;

function makeSandbox({ node = true, ipSrc = null, systemd = true } = {}) {
  const dir = mkdtempSync(join(TMP, "relay-kit-"));
  const sb = {
    dir,
    opt: join(dir, "opt"),
    etc: join(dir, "etc"),
    units: join(dir, "units"),
    bin: join(dir, "bin"),
    tools: join(dir, "tools"),
    run: join(dir, "run"),
    log: join(dir, "calls.log"),
  };
  for (const d of [sb.bin, sb.tools]) mkdirSync(d);
  if (systemd) mkdirSync(sb.run);
  writeFileSync(sb.log, "");
  for (const name of TOOL_NAMES) {
    const real = commandPath(name);
    if (real && name !== "id") symlinkSync(real, join(sb.tools, name));
  }
  sb.stub = (name, body, shebang = "/bin/sh") => {
    writeFileSync(join(sb.bin, name), `#!${shebang}\n${body}\n`);
    chmodSync(join(sb.bin, name), 0o755);
  };
  sb.stub("id", `[ "$1" = "-u" ] && echo "\${STUB_UID:-0}" || echo "uid=\${STUB_UID:-0}"`);
  sb.stub("systemctl", SYSTEMCTL_STUB, BASH);
  sb.stub("ufw", `echo "ufw $*" >> "$STUB_LOG"\n[ "$1" = "status" ] && echo "Status: active"\nexit 0`);
  sb.stub("journalctl", `echo "journalctl $*" >> "$STUB_LOG"\necho "(lines of the journal)"`);
  // curl: this machine goes to the real curl, the "what is my address" services answer STUB_CURL_IP, nothing else is reachable
  sb.stub(
    "curl",
    `for last in "$@"; do :; done
case "$last" in
  http://127.0.0.1:*) exec "${REAL_CURL}" "$@" ;;
  https://api.ipify.org | https://ipv4.icanhazip.com | https://ifconfig.me/ip)
    echo "curl $last" >> "$STUB_LOG"
    if [ -n "\${STUB_CURL_IP:-}" ]; then printf '%s\\n' "$STUB_CURL_IP"; exit 0; fi ;;
esac
exit 6`
  );
  if (node) sb.stub("node", `exec "${process.execPath}" "$@"`);
  if (ipSrc) sb.stub("ip", `echo "1.1.1.1 via 10.0.0.1 dev eth0 src ${ipSrc} uid 0"`);

  sb.env = (extra = {}) => ({
    PATH: `${sb.bin}:${sb.tools}`,
    HOME: dir,
    TMPDIR: dir,
    STUB_LOG: sb.log,
    STUB_DIR: dir,
    SOCKS_RELAY_DIR: sb.opt,
    SOCKS_RELAY_CONFIG_DIR: sb.etc,
    SOCKS_RELAY_UNIT_DIR: sb.units,
    SOCKS_RELAY_RUN_DIR: sb.run,
    SOCKS_RELAY_WAIT_SECONDS: "4",
    RELAY_CHECK_TIMEOUT_MS: "3000",
    ...extra,
  });
  sb.install = (args = [], extra = {}) => run(BASH, [INSTALL, ...args], { env: sb.env(extra) });
  sb.calls = () => readFileSync(sb.log, "utf8").split("\n").filter(Boolean);
  sb.envFile = () => readFileSync(join(sb.etc, "relay.env"), "utf8");
  sb.value = (key) => new RegExp(`^${key}=(.*)$`, "m").exec(sb.envFile())?.[1];
  sb.cleanup = () => {
    try {
      const pid = Number(readFileSync(join(dir, "relay.pid"), "utf8"));
      if (pid) process.kill(pid, "SIGKILL");
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  };
  sandboxes.push(sb);
  return sb;
}

function settingsOf(text) {
  const get = (key) => new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1] ?? null;
  return { host: get("RELAY_EXTERNAL_HOST"), port: get("RELAY_EXTERNAL_PORT"), user: get("RELAY_EXTERNAL_USER"), pass: get("RELAY_EXTERNAL_PASS") };
}

const loginWorks = async (s) => (await checkRelay(["127.0.0.1", s.port, s.user, s.pass, "--login-only"])).code === 0;

// ---------------------------------------------------------------- install-relay.sh: the real run

test("install-relay.sh has no syntax error", { skip: NEEDS_LINUX }, () => {
  const res = spawnSync(BASH, ["-n", INSTALL], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
});

test("install: copies the files, starts the service, opens the port, checks the relay and prints the .env lines", { skip: NEEDS_LINUX }, async () => {
  const sb = makeSandbox();
  const target = await tcpServer();
  const port = await freePort();
  const res = await sb.install(["--port", String(port), "--host", "203.0.113.7"], { RELAY_CHECK_TARGET: `127.0.0.1:${target.port}` });
  assert.equal(res.code, 0, res.out);

  // what it prints
  const s = settingsOf(res.stdout);
  assert.equal(s.host, "203.0.113.7");
  assert.equal(s.port, String(port));
  assert.match(s.user, /^[A-Za-z0-9]{10}$/);
  assert.match(s.pass, /^[A-Za-z0-9]{32}$/);
  assert.match(res.stdout, /Check: the relay is running, the login works and it can open connections to the internet\./);
  assert.match(res.stdout, /\.\/v\.sh relay on/);
  assert.equal(target.count, 1, "the check opens one connection to the target through the relay");

  // the files
  for (const f of ["server.js", "package.json", "check-relay.mjs"]) assert.ok(existsSync(join(sb.opt, f)), f);
  assert.equal(readFileSync(join(sb.opt, "server.js"), "utf8"), readFileSync(SERVER, "utf8"));
  assert.equal(statSync(join(sb.etc, "relay.env")).mode & 0o777, 0o600, "the password file is for root only");
  for (const f of ["server.js", "package.json", "check-relay.mjs"]) {
    assert.equal(statSync(join(sb.opt, f)).mode & 0o777, 0o644, `${f} has to be readable by the user the service runs as`);
  }
  assert.equal(statSync(sb.opt).mode & 0o777, 0o755);
  assert.equal(sb.value("SOCKS_PORT"), String(port));
  assert.equal(sb.value("SOCKS_USER"), s.user);
  assert.equal(sb.value("SOCKS_PASS"), s.pass);

  // the unit
  const unit = readFileSync(join(sb.units, "socks-relay.service"), "utf8");
  assert.match(unit, new RegExp(`^ExecStart="${sb.bin}/node" "${sb.opt}/server\\.js"$`, "m"));
  assert.match(unit, new RegExp(`^EnvironmentFile=${sb.etc}/relay\\.env$`, "m"));
  for (const line of ["DynamicUser=yes", "Restart=always", "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes", "WantedBy=multi-user.target", "CapabilityBoundingSet="]) {
    assert.ok(unit.split("\n").includes(line), `the unit should have ${line}`);
  }
  assert.doesNotMatch(unit, /AmbientCapabilities/, "a port above 1023 needs no capability");
  assert.doesNotMatch(unit, new RegExp(s.pass), "the password is not in the unit");

  // what it asked the system to do, in this order
  const calls = sb.calls();
  const at = (call) => calls.indexOf(call);
  assert.ok(at("systemctl daemon-reload") >= 0 && at("systemctl daemon-reload") < at("systemctl enable socks-relay"), calls.join("\n"));
  assert.ok(at("systemctl enable socks-relay") < at("systemctl restart socks-relay"), calls.join("\n"));
  assert.ok(calls.includes("ufw status") && calls.includes(`ufw allow ${port}/tcp`), calls.join("\n"));

  // the printed login is the login of the running relay (and a wrong one is refused)
  assert.ok(await loginWorks({ port: String(port), user: s.user, pass: s.pass }));
  assert.ok(!(await loginWorks({ port: String(port), user: s.user, pass: `${s.pass}x` })));
});

test("install: the password is shown only in the printed lines, not in the other output or in the logs of the system", { skip: NEEDS_LINUX }, async () => {
  const sb = makeSandbox();
  const res = await sb.install(["--port", String(await freePort()), "--host", "203.0.113.7"], { RELAY_CHECK_TARGET: `127.0.0.1:${(await tcpServer()).port}` });
  assert.equal(res.code, 0, res.out);
  const { pass } = settingsOf(res.stdout);
  assert.equal(res.stdout.split(pass).length - 1, 1, "once, in the RELAY_EXTERNAL_PASS line");
  assert.doesNotMatch(res.stderr, new RegExp(pass));
  assert.doesNotMatch(readFileSync(sb.log, "utf8"), new RegExp(pass), "no program was given the password on its command line");
});

test("install again: the login stays, --port changes only the port, extra settings stay, the service restarts", { skip: NEEDS_LINUX }, async () => {
  const sb = makeSandbox();
  const target = await tcpServer();
  const extra = { RELAY_CHECK_TARGET: `127.0.0.1:${target.port}` };
  const port1 = await freePort();
  const first = settingsOf((await sb.install(["--port", String(port1), "--host", "203.0.113.7"], extra)).stdout);

  writeFileSync(join(sb.etc, "relay.env"), `${sb.envFile()}BLOCKED_PORTS=none\nMAX_CONNECTIONS=50\n`);
  const port2 = await freePort();
  const again = await sb.install(["--port", String(port2)], extra);
  assert.equal(again.code, 0, again.out);
  const second = settingsOf(again.stdout);
  assert.equal(second.user, first.user);
  assert.equal(second.pass, first.pass);
  assert.equal(second.host, "203.0.113.7", "the address from the first run is remembered");
  assert.equal(second.port, String(port2));

  const envFile = sb.envFile();
  assert.equal(envFile.match(/^SOCKS_PORT=/gm).length, 1);
  assert.equal(envFile.match(/^SOCKS_USER=/gm).length, 1);
  assert.equal(envFile.match(/^SOCKS_PASS=/gm).length, 1);
  assert.match(envFile, /^BLOCKED_PORTS=none$/m);
  assert.match(envFile, /^MAX_CONNECTIONS=50$/m);
  assert.equal(sb.calls().filter((c) => c === "systemctl restart socks-relay").length, 2);
  assert.ok(await loginWorks({ port: String(port2), user: second.user, pass: second.pass }));
});

test("--new-password: same user name, a new password; the old one stops working", { skip: NEEDS_LINUX }, async () => {
  const sb = makeSandbox();
  const extra = { RELAY_CHECK_TARGET: `127.0.0.1:${(await tcpServer()).port}` };
  const port = await freePort();
  const first = settingsOf((await sb.install(["--port", String(port), "--host", "203.0.113.7"], extra)).stdout);
  const res = await sb.install(["--new-password"], extra);
  assert.equal(res.code, 0, res.out);
  const second = settingsOf(res.stdout);
  assert.equal(second.user, first.user);
  assert.notEqual(second.pass, first.pass);
  assert.match(second.pass, /^[A-Za-z0-9]{32}$/);
  assert.ok(await loginWorks({ port: String(port), user: second.user, pass: second.pass }));
  assert.ok(!(await loginWorks({ port: String(port), user: first.user, pass: first.pass })));
});

test("--help prints the usage and changes nothing", { skip: NEEDS_LINUX }, async () => {
  const sb = makeSandbox();
  const res = await sb.install(["--help"]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.stdout, /^install-relay\.sh - runs the SOCKS5 relay/);
  for (const option of ["--port 8443", "--host relay.example.com", "--show", "--new-password", "--uninstall", "--no-service"]) {
    assert.ok(res.stdout.includes(option), option);
  }
  assert.doesNotMatch(res.stdout, /^set -euo pipefail/m, "only the comment block at the top is printed");
  assert.ok(!existsSync(sb.opt) && !existsSync(sb.etc));
});

test("--show prints the same lines again, and says so when nothing is installed", { skip: NEEDS_LINUX }, async () => {
  const sb = makeSandbox();
  const none = await sb.install(["--show"]);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /the relay is not installed here/);

  const extra = { RELAY_CHECK_TARGET: `127.0.0.1:${(await tcpServer()).port}` };
  const installed = settingsOf((await sb.install(["--port", String(await freePort()), "--host", "relay.example.com"], extra)).stdout);
  const shown = await sb.install(["--show"]);
  assert.equal(shown.code, 0, shown.out);
  assert.deepEqual(settingsOf(shown.stdout), installed);
  assert.equal(installed.host, "relay.example.com");
});

test("install: a relay that does not start is reported with the reason, and does not hang", { skip: NEEDS_LINUX }, async () => {
  const sb = makeSandbox();
  const started = Date.now();
  const res = await sb.install(["--port", String(await freePort()), "--host", "203.0.113.7"], { STUB_START: "0", SOCKS_RELAY_WAIT_SECONDS: "2" });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /The relay did not answer on port \d+: FAILED \(greeting\): connection refused/);
  assert.match(res.stderr, /EADDRINUSE/, "the hint about a port that is already used");
  assert.match(res.stderr, /ERROR: the relay does not work/);
  assert.ok(Date.now() - started < 15000);
  assert.ok(sb.calls().includes("journalctl -u socks-relay -n 15 --no-pager"), "it shows what the service wrote");
});

test("install: a relay that cannot reach the internet is a warning, not a failure", { skip: NEEDS_LINUX }, async () => {
  const sb = makeSandbox();
  // nothing listens on port 1 of this machine: the relay's test connection is refused
  const res = await sb.install(["--port", String(await freePort()), "--host", "203.0.113.7"], { RELAY_CHECK_TARGET: "127.0.0.1:1" });
  assert.equal(res.code, 0, res.out);
  assert.match(res.stderr, /WARNING: the relay is running and the login works, but it could not open a test connection/);
  assert.match(res.stderr, /SOCKS reply 5/);
  assert.doesNotMatch(res.stdout, /Check: the relay is running/);
  assert.match(res.stdout, /RELAY_EXTERNAL_PASS=/, "the lines are printed all the same");
});

test("install: a port below 1024 gets the capability to bind it; --no-service writes the files and starts nothing", { skip: NEEDS_LINUX }, async () => {
  const sb = makeSandbox();
  const res = await sb.install(["--no-service", "--port", "443", "--host", "203.0.113.7"]);
  assert.equal(res.code, 0, res.out);
  const unit = readFileSync(join(sb.units, "socks-relay.service"), "utf8");
  assert.match(unit, /^AmbientCapabilities=CAP_NET_BIND_SERVICE$/m);
  assert.match(unit, /^CapabilityBoundingSet=CAP_NET_BIND_SERVICE$/m);
  assert.deepEqual(sb.calls(), [], "no systemctl, no ufw");
  assert.equal(sb.value("SOCKS_PORT"), "443");
  assert.equal(settingsOf(res.stdout).port, "443");
  assert.equal((await sb.install(["--no-service", "--port", "080"])).code, 0);
  assert.equal(sb.value("SOCKS_PORT"), "80", "080 is port 80");
});

test("install: when the address is not given and cannot be found, the lines say where to write it", { skip: NEEDS_LINUX }, async () => {
  const sb = makeSandbox();
  const res = await sb.install(["--port", String(await freePort())], { RELAY_CHECK_TARGET: `127.0.0.1:${(await tcpServer()).port}` });
  assert.equal(res.code, 0, res.out);
  assert.match(res.stderr, /WARNING: the public address of this server could not be found/);
  assert.match(res.stdout, /^RELAY_EXTERNAL_HOST=PUT-THE-PUBLIC-ADDRESS-OF-THIS-SERVER-HERE$/m);
  assert.doesNotMatch(sb.envFile(), /PUBLIC_HOST/, "a guess that failed is not remembered");
  const found = makeSandbox({ ipSrc: "10.0.0.5" });
  const res2 = await found.install(["--port", String(await freePort())], { STUB_CURL_IP: "198.51.100.4", RELAY_CHECK_TARGET: `127.0.0.1:${(await tcpServer()).port}` });
  assert.equal(settingsOf(res2.stdout).host, "198.51.100.4", "a private address on the card: the address is asked from the internet");
  assert.match(found.envFile(), /^# PUBLIC_HOST=198\.51\.100\.4$/m);
});

// ---------------------------------------------------------------- install-relay.sh: things that must be refused

test("install: wrong options are refused before anything is written", { skip: NEEDS_LINUX }, async () => {
  const sb = makeSandbox();
  const cases = [
    [["--port", "0"], /'0' is not a port number/],
    [["--port", "65536"], /not a port number/],
    [["--port", "abc"], /not a port number/],
    [["--port", "1e3"], /not a port number/],
    [["--port"], /--port needs a value/],
    [["--host"], /--host needs a value/],
    [["--host", "a b"], /is not an address/],
    [["--host", "http://relay.example.com"], /is not an address/],
    [["--host", "user@relay.example.com"], /is not an address/],
    [["--host", "relay.example.com:1080"], /is not an address/],
    [["--host", "[::1]"], /is not an address/],
    [["--host", "-relay.example.com"], /is not an address/],
    [["--bogus"], /unknown option '--bogus'/],
  ];
  for (const [args, message] of cases) {
    const res = await sb.install(args);
    assert.equal(res.code, 1, `${args.join(" ")}: ${res.out}`);
    assert.match(res.stderr, message, args.join(" "));
  }
  assert.ok(!existsSync(sb.opt) && !existsSync(sb.etc) && !existsSync(sb.units), "nothing was written");
  assert.deepEqual(sb.calls(), []);
});

test("install: needs root, systemd 235 or newer, and the source files", { skip: NEEDS_LINUX }, async () => {
  const sb = makeSandbox();
  const notRoot = await sb.install(["--host", "203.0.113.7"], { STUB_UID: "1000" });
  assert.equal(notRoot.code, 1);
  assert.match(notRoot.stderr, /this has to run as root\. Try:  sudo bash .*install-relay\.sh --host 203\.0\.113\.7/);

  const old = await sb.install(["--host", "203.0.113.7"], { STUB_SYSTEMD_VERSION: "219" });
  assert.equal(old.code, 1);
  assert.match(old.stderr, /systemd 219 is too old/);

  const noSystemd = makeSandbox({ systemd: false });
  const res = await noSystemd.install(["--host", "203.0.113.7"]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /does not run systemd/);

  for (const s of [sb, noSystemd]) assert.ok(!existsSync(s.opt) && !existsSync(s.etc) && !existsSync(s.units), "nothing was written");
  assert.ok(!sb.calls().includes("systemctl restart socks-relay"));

  // the script alone, without server.js next to it
  const lonely = mkdtempSync(join(TMP, "relay-kit-alone-"));
  sandboxes.push({ cleanup: () => rmSync(lonely, { recursive: true, force: true }) });
  copyFileSync(INSTALL, join(lonely, "install-relay.sh"));
  const sb2 = makeSandbox();
  const missing = await run(BASH, [join(lonely, "install-relay.sh"), "--host", "203.0.113.7"], { env: sb2.env(), cwd: lonely });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /server\.js and package\.json were not found/);
});

// ---------------------------------------------------------------- install-relay.sh: uninstall

test("--uninstall: stops the service, removes the unit and the folders, and is harmless a second time", { skip: NEEDS_LINUX }, async () => {
  const sb = makeSandbox();
  const port = await freePort();
  const extra = { RELAY_CHECK_TARGET: `127.0.0.1:${(await tcpServer()).port}` };
  const s = settingsOf((await sb.install(["--port", String(port), "--host", "203.0.113.7"], extra)).stdout);
  assert.ok(await loginWorks({ port: String(port), user: s.user, pass: s.pass }));

  const res = await sb.install(["--uninstall"]);
  assert.equal(res.code, 0, res.out);
  assert.ok(!existsSync(sb.opt) && !existsSync(sb.etc) && !existsSync(join(sb.units, "socks-relay.service")));
  assert.ok(sb.calls().includes("systemctl disable --now socks-relay"));
  assert.ok(!(await loginWorks({ port: String(port), user: s.user, pass: s.pass })), "the relay is stopped");

  const again = await sb.install(["--uninstall"]);
  assert.equal(again.code, 0, again.out);
  assert.match(again.stderr, /was left alone/);
});

test("--uninstall only removes folders that this script made", { skip: NEEDS_LINUX }, async () => {
  const sb = makeSandbox();
  mkdirSync(join(sb.opt), { recursive: true });
  writeFileSync(join(sb.opt, "precious.txt"), "mine");
  mkdirSync(join(sb.etc), { recursive: true });
  writeFileSync(join(sb.etc, "other.conf"), "mine too");
  const res = await sb.install(["--uninstall"]);
  assert.equal(res.code, 0, res.out);
  assert.equal(readFileSync(join(sb.opt, "precious.txt"), "utf8"), "mine");
  assert.equal(readFileSync(join(sb.etc, "other.conf"), "utf8"), "mine too");
  assert.match(res.stderr, new RegExp(`${sb.opt} was left alone`));
  assert.match(res.stderr, new RegExp(`${sb.etc} was left alone`));
  // a system folder is never removed, whatever is inside it
  const fn = await run(BASH, ["-c", `source "${INSTALL}"; safe_to_remove /etc passwd && echo removable || echo protected; safe_to_remove "${sb.dir}/x" y && echo removable || echo protected`], { env: sb.env() });
  assert.equal(fn.stdout.trim(), "protected\nprotected");
  writeFileSync(join(sb.dir, "marker"), "");
  mkdirSync(join(sb.dir, "ours"));
  writeFileSync(join(sb.dir, "ours", "marker"), "");
  const ours = await run(BASH, ["-c", `source "${INSTALL}"; safe_to_remove "${sb.dir}/ours" marker && echo removable || echo protected`], { env: sb.env() });
  assert.equal(ours.stdout.trim(), "removable");
});

// ---------------------------------------------------------------- install-relay.sh: Node.js

function nodeDownload({ sum = null, down = false } = {}) {
  const arch = { x64: "x64", arm64: "arm64", arm: "armv7l" }[process.arch];
  const folder = mkdtempSync(join(TMP, "relay-kit-node-"));
  sandboxes.push({ cleanup: () => rmSync(folder, { recursive: true, force: true }) });
  const name = `node-v22.99.0-linux-${arch}`;
  mkdirSync(join(folder, name, "bin"), { recursive: true });
  writeFileSync(join(folder, name, "bin", "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(folder, name, "bin", "node"), 0o755);
  execFileSync("tar", ["-czf", join(folder, `${name}.tar.gz`), "-C", folder, name]);
  const tarball = readFileSync(join(folder, `${name}.tar.gz`));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/latest-v22.x/SHASUMS256.txt") {
      res.end(`${"0".repeat(64)}  node-v22.99.0-linux-other.tar.gz\n${sum || createHash("sha256").update(tarball).digest("hex")}  ${name}.tar.gz\n`);
    } else if (req.url === `/latest-v22.x/${name}.tar.gz`) {
      res.end(tarball);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  return listen(server).then((port) => ({ url: down ? "http://127.0.0.1:1" : `http://127.0.0.1:${port}`, requests }));
}

test("Node.js: a server without it gets a private copy from nodejs.org, checksum verified, downloaded once", { skip: NEEDS_LINUX }, async () => {
  const sb = makeSandbox({ node: false });
  const dl = await nodeDownload();
  const res = await sb.install(["--no-service", "--host", "203.0.113.7"], { SOCKS_RELAY_NODE_DIST: dl.url });
  assert.equal(res.code, 0, res.out);
  assert.match(res.stdout, /This server has no Node\.js 18 or newer: downloading Node\.js 22 from nodejs\.org/);
  assert.ok(existsSync(join(sb.opt, "node", "bin", "node")));
  assert.ok(!existsSync(join(sb.opt, "node.new")));
  assert.match(readFileSync(join(sb.units, "socks-relay.service"), "utf8"), new RegExp(`^ExecStart="${sb.opt}/node/bin/node" "${sb.opt}/server\\.js"$`, "m"));
  assert.equal(dl.requests.length, 2, dl.requests.join(" "));

  const again = await sb.install(["--no-service"], { SOCKS_RELAY_NODE_DIST: dl.url });
  assert.equal(again.code, 0, again.out);
  assert.doesNotMatch(again.stdout, /downloading/);
  assert.equal(dl.requests.length, 2, "the copy is reused");
});

test("Node.js: a download with the wrong checksum is refused and nothing is installed", { skip: NEEDS_LINUX }, async () => {
  const sb = makeSandbox({ node: false });
  const dl = await nodeDownload({ sum: "f".repeat(64) });
  const res = await sb.install(["--no-service", "--host", "203.0.113.7"], { SOCKS_RELAY_NODE_DIST: dl.url });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /the checksum of the downloaded Node\.js does not match; nothing was installed/);
  assert.ok(!existsSync(join(sb.opt, "node")) && !existsSync(join(sb.opt, "node.new")));
  assert.ok(!existsSync(join(sb.units, "socks-relay.service")));
});

test("Node.js: no way to download it is explained, with what to do instead", { skip: NEEDS_LINUX }, async () => {
  const sb = makeSandbox({ node: false });
  const dl = await nodeDownload({ down: true });
  const res = await sb.install(["--no-service", "--host", "203.0.113.7"], { SOCKS_RELAY_NODE_DIST: dl.url });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /could not download the Node\.js checksum list/);
  assert.match(res.stderr, /apt install nodejs/);
  // a Node.js older than 18 does not count either
  const old = makeSandbox({ node: false });
  old.stub(
    "node",
    `if [ "$1" = "-e" ]; then
  exec "${process.execPath}" -e "Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '16.20.0' }, configurable: true }); $2"
fi
exec "${process.execPath}" "$@"`
  );
  const dl2 = await nodeDownload();
  const res2 = await old.install(["--no-service", "--host", "203.0.113.7"], { SOCKS_RELAY_NODE_DIST: dl2.url });
  assert.equal(res2.code, 0, res2.out);
  assert.match(res2.stdout, /downloading Node\.js 22/);
});

// ---------------------------------------------------------------- install-relay.sh: the small functions

const fn = async (code, env = {}) => (await run(BASH, ["-c", `source "${INSTALL}"; ${code}`], { env: { PATH: process.env.PATH, ...env } })).stdout.trim();

test("is_private_ipv4: the addresses that a Cloudflare Worker cannot reach, and the ones it can", { skip: NEEDS_LINUX }, async () => {
  const privateOnes = ["0.1.1.1", "10.0.0.1", "10.255.255.255", "127.0.0.1", "100.64.0.1", "100.127.255.255", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "224.0.0.1", "255.255.255.255"];
  const publicOnes = ["1.1.1.1", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.167.1.1", "192.169.0.1", "169.253.1.1", "203.0.113.7", "223.255.255.255"];
  const answers = await fn([...privateOnes, ...publicOnes].map((ip) => `is_private_ipv4 ${ip} && echo private || echo public`).join("; "));
  assert.deepEqual(answers.split("\n"), [...privateOnes.map(() => "private"), ...publicOnes.map(() => "public")]);
});

test("valid_port, valid_host, is_ipv4", { skip: NEEDS_LINUX }, async () => {
  const check = async (name, good, bad) => {
    const code = [...good.map((v) => `${name} '${v}' && echo y || echo n`), ...bad.map((v) => `${name} '${v}' && echo y || echo n`)].join("; ");
    assert.deepEqual((await fn(code)).split("\n"), [...good.map(() => "y"), ...bad.map(() => "n")], name);
  };
  await check("valid_port", ["1", "80", "1080", "65535", "080"], ["0", "65536", "99999", "abc", "", "1e3", "-1", "10 80", "123456"]);
  await check("valid_host", ["203.0.113.7", "relay.example.com", "a", "my-server", "2001:db8::1", "fe80::1"], ["", "a b", "http://x", "a@b", "host:80", "-bad", "bad-", "a/b", "[::1]", "a_b"]);
  await check("is_ipv4", ["1.2.3.4", "255.255.255.255", "0.0.0.0"], ["256.1.1.1", "1.2.3", "1.2.3.4.5", "a.b.c.d", "", "1.2.3.-4", "1.2.3.4 "]);
});

test("usable_location: a Node.js in a home folder cannot be used by the service", { skip: NEEDS_LINUX }, async () => {
  const no = ["/root/.nvm/versions/node/v20.1.0/bin/node", "/home/me/.nvm/versions/node/v22.1.0/bin/node", "/home/x/node"];
  const yes = ["/usr/bin/node", "/usr/local/bin/node", "/opt/node22/bin/node", "/usr/lib/nodejs/bin/node", "/homestead/node", "/rootfs/node"];
  const answers = await fn([...no, ...yes].map((p) => `usable_location '${p}' && echo yes || echo no`).join("; "));
  assert.deepEqual(answers.split("\n"), [...no.map(() => "no"), ...yes.map(() => "yes")]);
});

test("random_alnum: the requested length, only letters and digits, different every time", { skip: NEEDS_LINUX }, async () => {
  const out = (await fn(`for i in 1 2 3 4 5 6; do random_alnum 32; echo; done; random_alnum 10; echo; random_alnum 200 | wc -c`)).split("\n");
  const passwords = out.slice(0, 6);
  for (const p of passwords) assert.match(p, /^[A-Za-z0-9]{32}$/);
  assert.equal(new Set(passwords).size, 6);
  assert.match(out[6], /^[A-Za-z0-9]{10}$/);
  assert.equal(out[7], "200");
});

test("detect_host: the card's address if it is public, otherwise the answer of an address service; never a private one", { skip: NEEDS_LINUX }, async () => {
  const detect = async (opts, env = {}) => {
    const sb = makeSandbox(opts);
    return (await fn(`detect_host && echo " ok" || echo "none"`, sb.env(env))).replace(/\n/g, "");
  };
  assert.equal(await detect({ ipSrc: "203.0.113.9" }), "203.0.113.9 ok");
  assert.equal(await detect({ ipSrc: "10.0.0.5" }, { STUB_CURL_IP: "198.51.100.4" }), "198.51.100.4 ok");
  assert.equal(await detect({}, { STUB_CURL_IP: "198.51.100.4" }), "198.51.100.4 ok", "no `ip` program");
  assert.equal(await detect({ ipSrc: "10.0.0.5" }), "none", "no service answers");
  assert.equal(await detect({ ipSrc: "10.0.0.5" }, { STUB_CURL_IP: "192.168.1.1" }), "none", "a private answer is not used");
  assert.equal(await detect({ ipSrc: "10.0.0.5" }, { STUB_CURL_IP: "<html>blocked</html>" }), "none", "an answer that is not an address is not used");
});
