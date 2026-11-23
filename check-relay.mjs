#!/usr/bin/env node
// Checks a SOCKS5 relay the way the Cloudflare Workers use it: log in with a user name and password, then open one
// connection through it (by name, nothing is sent over it).
//
//   node check-relay.mjs HOST PORT USER PASS [--target host:port] [--login-only]
//   node check-relay.mjs                       (HOST, PORT, USER and PASS come from RELAY_EXTERNAL_HOST / _PORT / _USER / _PASS,
//                                               for example after:  set -a; . ~/.env; set +a)
//
// Exit code 0 = it works, 1 = it does not (the reason is printed), 2 = wrong usage. No packages needed (Node 18 or newer).
// RELAY_CHECK_TIMEOUT_MS (default 10000) is how long it waits for each answer; RELAY_CHECK_TARGET is the default of --target.

import net from "node:net";

const SOCKS_REPLY = {
  1: "general SOCKS server failure",
  2: "connection not allowed by the server's rules",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
};

function check({ host, port, user, pass, target, timeoutMs }) {
  return new Promise((resolve) => {
    const stages = ["greeting", "login", "connect"];
    let stage = 0;
    let finished = false;
    let buf = Buffer.alloc(0);
    const sock = net.connect({ host, port });
    const fail = (reason) => done({ ok: false, stage: stages[stage], reason });
    const done = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        fail(
          stage === 0 && !sock.remoteAddress
            ? "no answer from the address (the port is closed in a firewall, or the address is wrong)"
            : stage === 0
              ? "connected, but the server never answered the SOCKS5 greeting (is that port really a SOCKS5 server?)"
              : stage === 1
                ? "the server did not answer the login"
                : `the server did not open the test connection to ${target.host}:${target.port} in time`
        ),
      timeoutMs
    );
    sock.on("error", (err) => {
      const code = err && err.code;
      fail(
        code === "ECONNREFUSED"
          ? "connection refused (nothing is listening on that port, or the firewall rejects it)"
          : code === "ENOTFOUND" || code === "EAI_AGAIN"
            ? "the host name does not exist"
            : `cannot connect (${code || (err && err.message) || "unknown error"})`
      );
    });
    sock.on("close", () => fail("the server closed the connection"));
    sock.on("connect", () => sock.write(Buffer.from([5, 1, 2])));
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0 && buf.length >= 2) {
        if (buf[0] !== 5) return fail("that port does not speak SOCKS5 (another kind of server answered)");
        if (buf[1] !== 2) {
          return fail(
            buf[1] === 0
              ? "the server does not ask for a user name and a password: it has to be set up to require them (the Workers log in with them, and a server without a password is open to everybody)"
              : "the server does not accept a user name / password login (a server that needs no login at all answers like this too): it has to be set up to require one, because the Workers log in with it"
          );
        }
        buf = buf.subarray(2);
        stage = 1;
        const u = Buffer.from(user, "utf8");
        const p = Buffer.from(pass, "utf8");
        sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
      }
      if (stage === 1 && buf.length >= 2) {
        if (buf[0] !== 1 || buf[1] !== 0) return fail("the server refused the user name / password");
        if (!target) return done({ ok: true });
        buf = buf.subarray(2);
        stage = 2;
        const name = Buffer.from(target.host, "utf8");
        sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([target.port >> 8, target.port & 0xff])]));
        return;
      }
      if (stage === 2 && buf.length >= 2) {
        if (buf[0] === 5 && buf[1] === 0) return done({ ok: true });
        fail(
          `the login worked, but the server would not open a test connection to ${target.host}:${target.port} ` +
            `(SOCKS reply ${buf[1]}: ${SOCKS_REPLY[buf[1]] || "unknown"})`
        );
      }
    });
  });
}

function usage() {
  console.error("usage: node check-relay.mjs HOST PORT USER PASS [--target host:port] [--login-only]");
  console.error("   or: set RELAY_EXTERNAL_HOST / _PORT / _USER / _PASS and run it without arguments");
  process.exit(2);
}

const args = process.argv.slice(2);
const flags = { target: "cloudflare.com:443", loginOnly: false };
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--login-only") flags.loginOnly = true;
  else if (args[i] === "--target") flags.target = args[++i] || "";
  else if (args[i] === "--help" || args[i] === "-h") usage();
  else positional.push(args[i]);
}
// RELAY_CHECK_TARGET is for the tests of the installer; it is the same as --target
if (process.env.RELAY_CHECK_TARGET && !args.includes("--target")) flags.target = process.env.RELAY_CHECK_TARGET;

const [host, portText, user, pass] = positional.length
  ? positional
  : [process.env.RELAY_EXTERNAL_HOST, process.env.RELAY_EXTERNAL_PORT || "1080", process.env.RELAY_EXTERNAL_USER, process.env.RELAY_EXTERNAL_PASS];
const port = Number(portText);
if (!host || !user || !pass || !Number.isInteger(port) || port < 1 || port > 65535) usage();
if (Buffer.byteLength(user) > 255 || Buffer.byteLength(pass) > 255) {
  console.error("the user name and the password can be at most 255 bytes each (a SOCKS5 limit)");
  process.exit(2);
}

let target = null;
if (!flags.loginOnly) {
  const m = /^(.+):(\d{1,5})$/.exec(flags.target);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) usage();
  target = { host: m[1], port: Number(m[2]) };
}

const result = await check({ host, port, user, pass, target, timeoutMs: Number(process.env.RELAY_CHECK_TIMEOUT_MS) || 10000 });
if (result.ok) {
  console.log(target ? `OK: the login works and the relay opened a connection to ${target.host}:${target.port}` : "OK: the login works");
  process.exit(0);
}
console.error(`FAILED (${result.stage}): ${result.reason}`);
process.exit(1);
