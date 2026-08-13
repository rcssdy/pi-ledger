import { describe, expect, it } from "vitest";

import { MalformedStatusError, parseStatusV2 } from "../../src/git/status-v2.js";

const OID = "a".repeat(40);
const HASH = "b".repeat(40);

describe("parseStatusV2", () => {
  it("distinguishes unborn, attached, and detached HEAD", () => {
    expect(parseStatusV2("# branch.oid (initial)\0# branch.head main\0").head).toEqual({
      kind: "unborn",
      branchRef: "refs/heads/main",
      branchName: "main",
    });
    expect(parseStatusV2(`# branch.oid ${OID}\0# branch.head topic/x\0`).head).toMatchObject({
      kind: "attached",
      branchName: "topic/x",
      oid: OID,
    });
    expect(parseStatusV2(`# branch.oid ${OID}\0# branch.head (detached)\0`).head).toEqual({
      kind: "detached",
      oid: OID,
    });
  });

  it("parses NUL-delimited ordinary, rename, unmerged, and unusual paths", () => {
    const output = [
      `# branch.oid ${OID}`,
      "# branch.head main",
      `1 M. N... 100644 100644 100644 ${HASH} ${HASH} staged name`,
      `1 .M S.MU 160000 160000 160000 ${HASH} ${HASH} submodule`,
      `2 R. N... 100644 100644 100644 ${HASH} ${HASH} R100 target\nname`,
      "source\tname",
      `u UU N... 100644 100644 100644 100644 ${HASH} ${HASH} ${HASH} conflict file`,
      "?  leading and trailing ",
      "",
    ].join("\0");

    const result = parseStatusV2(output);
    expect(result.workingTree.paths).toEqual([
      expect.objectContaining({ kind: "ordinary", path: "staged name", indexStatus: "M" }),
      expect.objectContaining({
        kind: "ordinary",
        path: "submodule",
        worktreeStatus: "M",
        submoduleStatus: "S.MU",
      }),
      expect.objectContaining({
        kind: "renamed",
        path: "target\nname",
        originalPath: "source\tname",
      }),
      expect.objectContaining({
        kind: "unmerged",
        path: "conflict file",
        indexStatus: "U",
        worktreeStatus: "U",
      }),
      expect.objectContaining({ kind: "untracked", path: " leading and trailing " }),
    ]);
    expect(result.workingTree.counts).toEqual({
      staged: 3,
      unstaged: 2,
      untracked: 1,
      unmerged: 1,
      submodule: 1,
    });
  });

  it("rejects malformed output instead of reporting a clean tree", () => {
    expect(() => parseStatusV2(`# branch.oid ${OID}\0# branch.head main\0x bad\0`)).toThrow(
      MalformedStatusError,
    );
    expect(() =>
      parseStatusV2(`# branch.oid ${OID}\0# branch.head main\u00002 R. N... 100644\0`),
    ).toThrow(MalformedStatusError);
    expect(() => parseStatusV2("# branch.oid abc\0# branch.head main\0", "sha1")).toThrow(
      MalformedStatusError,
    );
  });
});
