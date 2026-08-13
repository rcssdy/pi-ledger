import { describe, expect, it, vi } from "vitest";

import {
  createNodeGitCommandRunner,
  createPiGitCommandRunner,
} from "../../src/git/command-runner.js";

describe("Git command runners", () => {
  it.runIf(process.platform !== "win32")(
    "rejects invalid UTF-8 instead of decoding replacement characters",
    async () => {
      const runner = createNodeGitCommandRunner("/bin/sh");
      const result = await runner.run(["-c", "printf '\\377'"], {
        cwd: process.cwd(),
        timeout: 5_000,
      });

      expect(result).toMatchObject({ error: "unsupported_path_encoding", stdout: "" });
    },
  );

  it("distinguishes cancellation from a timeout", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await createNodeGitCommandRunner().run(["status"], {
      cwd: process.cwd(),
      timeout: 5_000,
      signal: controller.signal,
    });

    expect(result).toMatchObject({ error: "aborted" });
  });

  it("normalizes a Pi execution exception", async () => {
    const exec = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }));
    const runner = createPiGitCommandRunner({ exec });

    await expect(
      runner.run(["status"], { cwd: "/worktree", timeout: 5_000 }),
    ).resolves.toMatchObject({ error: "unavailable", code: -1 });
  });

  it("forwards arguments, cwd, timeout, and signal to Pi without a shell", async () => {
    const signal = new AbortController().signal;
    const exec = vi.fn().mockResolvedValue({
      stdout: "output",
      stderr: "",
      code: 0,
      killed: false,
    });
    const runner = createPiGitCommandRunner({ exec });

    await expect(
      runner.run(["status", "--porcelain=v2"], {
        cwd: "/worktree",
        timeout: 5_000,
        signal,
      }),
    ).resolves.toMatchObject({ code: 0, stdout: "output" });
    expect(exec).toHaveBeenCalledWith("git", ["status", "--porcelain=v2"], {
      cwd: "/worktree",
      timeout: 5_000,
      signal,
    });
  });
});
