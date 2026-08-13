import { spawn } from "node:child_process";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface GitCommandOptions {
  cwd: string;
  signal?: AbortSignal;
  timeout: number;
}

export type GitCommandError = "unavailable" | "timed_out" | "aborted" | "unsupported_path_encoding";

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
  error?: GitCommandError;
}

export interface GitCommandRunner {
  run(args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult>;
}

export function createPiGitCommandRunner(pi: Pick<ExtensionAPI, "exec">): GitCommandRunner {
  return {
    async run(args, options) {
      try {
        const result = await pi.exec("git", [...args], options);
        if (
          containsReplacementCharacter(result.stdout) ||
          containsReplacementCharacter(result.stderr)
        ) {
          return { ...result, error: "unsupported_path_encoding" };
        }
        if (result.killed) {
          return { ...result, error: options.signal?.aborted ? "aborted" : "timed_out" };
        }
        return result;
      } catch (error) {
        return failedExecution(error, options.signal);
      }
    },
  };
}

/** Local-process runner used by integration tests and standalone consumers. */
export function createNodeGitCommandRunner(executable = "git"): GitCommandRunner {
  return {
    run(args, options) {
      return new Promise((resolve) => {
        const child = spawn(executable, [...args], {
          cwd: options.cwd,
          env: { ...process.env, LC_ALL: "C" },
          signal: options.signal,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let timedOut = false;
        let settled = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeout);

        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.on("error", (error: NodeJS.ErrnoException) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(failedExecution(error, options.signal, timedOut));
        });
        child.on("close", (code, signal) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const decoded = decodeOutput(Buffer.concat(stdout), Buffer.concat(stderr));
          resolve({
            ...decoded,
            code: code ?? -1,
            killed: signal !== null,
            error:
              decoded.error ??
              (options.signal?.aborted ? "aborted" : timedOut ? "timed_out" : undefined),
          });
        });
      });
    },
  };
}

function decodeOutput(
  stdout: Buffer,
  stderr: Buffer,
): Pick<GitCommandResult, "stdout" | "stderr" | "error"> {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const decodedStdout = decoder.decode(stdout);
    const decodedStderr = decoder.decode(stderr);
    return { stdout: decodedStdout, stderr: decodedStderr };
  } catch {
    return { stdout: "", stderr: "", error: "unsupported_path_encoding" };
  }
}

function failedExecution(
  error: unknown,
  signal: AbortSignal | undefined,
  timedOut = false,
): GitCommandResult {
  const systemError = error as NodeJS.ErrnoException;
  const aborted = signal?.aborted || systemError.name === "AbortError";
  return {
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    code: -1,
    killed: aborted || timedOut,
    error:
      systemError.code === "ENOENT"
        ? "unavailable"
        : aborted
          ? "aborted"
          : timedOut
            ? "timed_out"
            : undefined,
  };
}

function containsReplacementCharacter(value: string): boolean {
  return value.includes("\uFFFD");
}
