import { type ChildProcess, spawn } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { ServerRecord } from "../storage/store.js";
const STDERR_TAIL_LINES = 100;
const KILL_GRACE_MS = 2000;

/**
 * A `Transport` that owns one real child process and speaks
 * newline-delimited JSON-RPC over its stdin/stdout.
 *
 * Built directly on `node:child_process` instead of the SDK's
 * `StdioClientTransport` because that class hardcodes its spawn options: it
 * has no way to spawn `detached` (so a hard BB kill would orphan
 * grandchildren spawned by wrappers like `npx` or `docker run`), and it
 * always layers `getDefaultEnvironment()` (HOME, LOGNAME, PATH, SHELL,
 * TERM, USER) under the caller-supplied env, which is wider than the
 * `{ PATH, HOME } + configured env` this plugin requires. The wire framing
 * (`ReadBuffer` / `serializeMessage`) is reused as-is from the SDK, since
 * that part of `StdioClientTransport` is exactly what is needed here.
 *
 * Per the `Transport` contract, callbacks must be installed before
 * `start()` runs or messages can be lost. The child is spawned eagerly (so
 * its stderr can be captured from the first byte) but no listener is
 * attached to its stdout until `start()` runs; a paused Node `Readable`
 * buffers whatever the OS delivers in the meantime; nothing is dropped.
 */
class ChildProcessTransport implements Transport {
  private readonly readBuffer = new ReadBuffer();
  private started = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly child: ChildProcess) {}

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("ChildProcessTransport already started");
    }
    this.started = true;
    this.child.stdout?.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    this.child.stdin?.on("error", (error: Error) => this.onerror?.(error));
    this.child.on("error", (error: Error) => this.onerror?.(error));
    this.child.on("close", () => {
      this.readBuffer.clear();
      this.onclose?.();
    });
  }

  private handleStdout(chunk: Buffer): void {
    try {
      this.readBuffer.append(chunk);
    } catch (error) {
      // The buffer overflowed and has already cleared itself; this
      // transport can no longer make sense of the byte stream, so tear the
      // whole thing down instead of silently dropping messages forever.
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      void this.close();
      return;
    }
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.readBuffer.readMessage();
      } catch (error) {
        // A single malformed line does not corrupt the buffer - readMessage
        // already advanced past it before parsing failed - so report the
        // error and keep delivering whatever else is already buffered.
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child.stdin;
      if (!stdin) {
        reject(new Error("Child process has no stdin"));
        return;
      }
      stdin.write(serializeMessage(message), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    await killProcessGroup(this.child);
  }
}

/**
 * Sends SIGTERM to the child's whole process group (it was spawned
 * `detached: true`, so its pid is also its process group id - signalling
 * `-pid` reaches it and every descendant it spawned), then SIGKILL after a
 * grace period if it has not exited by then. Resolves as soon as the child
 * exits, whichever signal did it.
 */
function killProcessGroup(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.pid == null || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const pid = child.pid;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      // Whatever happened, this is the end of the line: never block a
      // caller indefinitely on a process group that refuses to die.
      finish();
    }, KILL_GRACE_MS);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const onLeaderExit = () => {
      // The group leader exiting does not mean the group is empty: wrapper
      // processes like `npx` or `docker run` can exit almost immediately
      // while descendants they spawned into the same process group keep
      // running and ignore SIGTERM. Only treat the kill as complete once
      // the whole group - not just the direct child - is confirmed gone;
      // otherwise fall through to the SIGKILL escalation timer above.
      try {
        process.kill(-pid, 0);
      } catch {
        finish();
      }
    };
    child.once("exit", onLeaderExit);
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Already gone, or never became a process group leader.
      finish();
    }
  });
}

interface SupervisedChild {
  child: ChildProcess;
}

export interface StdioSupervisor {
  /** Spawns (or respawns) the child for `server` and returns a transport on it. */
  transportFor(server: ServerRecord, env: Record<string, string>): Promise<Transport>;
  stderrTail(serverId: string): string[];
  killAll(): Promise<void>;
}

/**
 * Owns every locally-spawned stdio MCP server for this BB server process.
 *
 * Children spawn lazily, the first time `transportFor` is called for a
 * given server, never at plugin load - an unreachable or slow-to-start
 * server must not delay BB startup. Each child's stderr is captured into a
 * bounded 100-line ring buffer (never inherited) so a later diagnostic
 * "Test" action can show why a server failed without ever printing
 * arbitrary child output to the BB server's own stderr.
 */
export function createStdioSupervisor(deps: {
  resolvePath(): Promise<string>;
  log: { warn(message: string): void };
}): StdioSupervisor {
  const children = new Map<string, SupervisedChild>();
  const stderrBuffers = new Map<string, string[]>();
  const stderrPartials = new Map<string, string>();

  function appendStderr(serverId: string, chunk: Buffer): void {
    const partial = (stderrPartials.get(serverId) ?? "") + chunk.toString("utf8");
    const lines = partial.split("\n");
    stderrPartials.set(serverId, lines.pop() ?? "");
    if (lines.length === 0) return;
    const buffer = stderrBuffers.get(serverId) ?? [];
    buffer.push(...lines);
    while (buffer.length > STDERR_TAIL_LINES) buffer.shift();
    stderrBuffers.set(serverId, buffer);
  }

  /**
   * Moves whatever trailing, not-yet-newline-terminated stderr text a child
   * left behind into the ring buffer. Without this, a child that never ends
   * its last line with `\n` before exiting would have that last line vanish
   * from `stderrTail()` forever.
   */
  function flushStderrPartial(serverId: string): void {
    const partial = stderrPartials.get(serverId);
    if (!partial) return;
    stderrPartials.set(serverId, "");
    const buffer = stderrBuffers.get(serverId) ?? [];
    buffer.push(partial);
    while (buffer.length > STDERR_TAIL_LINES) buffer.shift();
    stderrBuffers.set(serverId, buffer);
  }

  async function transportFor(server: ServerRecord, configuredEnv: Record<string, string>): Promise<Transport> {
    if (!server.command) {
      throw new Error(`Server "${server.id}" has no command configured for stdio transport`);
    }

    const path = await deps.resolvePath();
    const baseEnv: Record<string, string> = { PATH: path };
    if (process.env.HOME) baseEnv.HOME = process.env.HOME;
    // Configured variables live in the secrets file, not the database: a stdio
    // server's environment is usually where its API key goes.
    const env = { ...baseEnv, ...configuredEnv };

    // A server id being spawned again (typically after a failed tool call
    // dropped the cached client) must not orphan the previous child - close
    // it down before it is no longer reachable through `children`.
    const existing = children.get(server.id);
    if (existing) {
      await killProcessGroup(existing.child);
    }

    // Only seed fresh buffers on the very first spawn for this id; a respawn
    // should keep prior diagnostic output around instead of erasing it.
    if (!stderrBuffers.has(server.id)) stderrBuffers.set(server.id, []);
    if (!stderrPartials.has(server.id)) stderrPartials.set(server.id, "");

    const child = spawn(server.command, server.args, {
      cwd: server.cwd ?? undefined,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      shell: false,
    });

    child.stderr?.on("data", (chunk: Buffer) => appendStderr(server.id, chunk));
    child.on("error", (error: Error) => {
      deps.log.warn(`Stdio server "${server.id}" failed to start: ${String(error)}`);
      appendStderr(server.id, Buffer.from(`${String(error)}\n`, "utf8"));
    });
    child.on("close", () => flushStderrPartial(server.id));

    children.set(server.id, { child });
    return new ChildProcessTransport(child);
  }

  function stderrTail(serverId: string): string[] {
    return [...(stderrBuffers.get(serverId) ?? [])];
  }

  async function killAll(): Promise<void> {
    const entries = Array.from(children.values());
    children.clear();
    stderrBuffers.clear();
    stderrPartials.clear();
    await Promise.all(entries.map(({ child }) => killProcessGroup(child)));
  }

  return { transportFor, stderrTail, killAll };
}

let cachedLoginShellPath: Promise<string> | null = null;

/**
 * Resolves PATH the way an interactive login shell would.
 *
 * The BB server process itself does no login-shell PATH resolution (only
 * the host daemon does), so it is missing whatever a user's shell profile
 * adds to PATH - most commonly the directories that make `npx` or `docker`
 * runnable. This is the most likely reason stdio servers configured around
 * those commands fail today. Resolved once per process and cached, with a
 * short timeout and a fallback to the unresolved `process.env.PATH` if the
 * shell does not answer in time.
 */
export function loginShellPath(): Promise<string> {
  if (!cachedLoginShellPath) {
    cachedLoginShellPath = resolveLoginShellPath();
  }
  return cachedLoginShellPath;
}

function resolveLoginShellPath(): Promise<string> {
  return new Promise((resolve) => {
    const fallback = process.env.PATH ?? "";
    const shell = process.env.SHELL || "/bin/sh";
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child: ChildProcess;
    try {
      child = spawn(shell, ["-lc", "echo $PATH"], {
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      });
    } catch {
      finish(fallback);
      return;
    }
    // This helper's own promise settles well before the child necessarily
    // exits (e.g. on timeout, or if the shell hangs); unref it so a
    // straggling login shell can never keep the BB server process alive.
    child.unref();

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", () => finish(fallback));
    child.once("exit", (code) => {
      clearTimeout(timer);
      const resolved = output.trim();
      finish(code === 0 && resolved.length > 0 ? resolved : fallback);
    });

    const timer = setTimeout(() => {
      // The shell (and anything it spawned into its own process group, since
      // it was started `detached: true`) is no longer worth waiting on -
      // signal the whole group, not just the direct child, and stop
      // listening for output.
      if (child.pid != null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      child.stdout?.destroy();
      finish(fallback);
    }, 3000);
  });
}
