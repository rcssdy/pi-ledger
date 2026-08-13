import type { ChangedPath, CommitOid, HeadState, WorkingTreeStatus } from "./types.js";

export interface ParsedStatusV2 {
  head: HeadState;
  workingTree: WorkingTreeStatus;
}

export class MalformedStatusError extends Error {}

/** Parse `git status --porcelain=v2 --branch -z` without interpreting path delimiters. */
export function parseStatusV2(output: string, objectFormat?: string): ParsedStatusV2 {
  const records = output.split("\0");
  if (records.at(-1) === "") records.pop();

  const headers = new Map<string, string>();
  const paths: ChangedPath[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.startsWith("# ")) {
      const separator = record.indexOf(" ", 2);
      if (separator !== -1) {
        const name = record.slice(2, separator);
        if ((name === "branch.oid" || name === "branch.head") && headers.has(name)) {
          throw new MalformedStatusError(`duplicate ${name} header`);
        }
        headers.set(name, record.slice(separator + 1));
      }
      continue;
    }

    if (record.startsWith("? ")) {
      paths.push({ kind: "untracked", path: record.slice(2) });
      continue;
    }
    if (record.startsWith("! ")) continue;

    const kind = record[0];
    const expectedFields = kind === "1" ? 8 : kind === "2" ? 9 : kind === "u" ? 10 : 0;
    if (expectedFields === 0)
      throw new MalformedStatusError(`unknown record kind ${JSON.stringify(kind)}`);
    const fields = splitPrefix(record.slice(2), expectedFields);
    const [xy, submoduleStatus] = fields;
    const path = fields.at(-1);
    if (
      xy === undefined ||
      submoduleStatus === undefined ||
      path === undefined ||
      xy.length !== 2
    ) {
      throw new MalformedStatusError(`malformed ${kind} record`);
    }

    const oidFields = kind === "u" ? fields.slice(6, 9) : fields.slice(5, 7);
    if (oidFields.some((oid) => !isValidOid(oid, objectFormat))) {
      throw new MalformedStatusError(`invalid object id in ${kind} record`);
    }

    const changed: ChangedPath = {
      kind: kind === "u" ? "unmerged" : "ordinary",
      path,
      indexStatus: statusCharacter(xy[0]),
      worktreeStatus: statusCharacter(xy[1]),
      submoduleStatus,
    };

    if (kind === "2") {
      const score = fields.at(-2);
      if (score?.startsWith("R")) changed.kind = "renamed";
      else if (score?.startsWith("C")) changed.kind = "copied";
      else throw new MalformedStatusError(`invalid rename/copy score ${JSON.stringify(score)}`);
      const originalPath = records[index + 1];
      if (originalPath === undefined)
        throw new MalformedStatusError("rename/copy record has no original path");
      changed.originalPath = originalPath;
      index += 1;
    }
    paths.push(changed);
  }

  const oid = headers.get("branch.oid");
  const branch = headers.get("branch.head");
  if (oid === undefined || branch === undefined) {
    throw new MalformedStatusError("missing branch.oid or branch.head header");
  }

  let head: HeadState;
  if (oid === "(initial)") {
    if (branch === "(detached)") throw new MalformedStatusError("initial HEAD cannot be detached");
    head = { kind: "unborn", branchRef: `refs/heads/${branch}`, branchName: branch };
  } else if (!isValidOid(oid, objectFormat)) {
    throw new MalformedStatusError(`invalid HEAD object id ${JSON.stringify(oid)}`);
  } else if (branch === "(detached)") {
    head = { kind: "detached", oid: oid as CommitOid };
  } else {
    head = {
      kind: "attached",
      branchRef: `refs/heads/${branch}`,
      branchName: branch,
      oid: oid as CommitOid,
    };
  }

  return { head, workingTree: summarize(paths) };
}

function splitPrefix(value: string, fieldCount: number): string[] {
  const fields: string[] = [];
  let cursor = 0;
  for (let index = 1; index < fieldCount; index += 1) {
    const separator = value.indexOf(" ", cursor);
    if (separator === -1) throw new MalformedStatusError("record has too few metadata fields");
    fields.push(value.slice(cursor, separator));
    cursor = separator + 1;
  }
  fields.push(value.slice(cursor));
  return fields;
}

function isValidOid(value: string | undefined, objectFormat: string | undefined): boolean {
  if (value === undefined || !/^[0-9a-f]+$/.test(value)) return false;
  if (objectFormat === "sha1") return value.length === 40;
  if (objectFormat === "sha256") return value.length === 64;
  return value.length === 40 || value.length === 64;
}

function statusCharacter(value: string | undefined): string | undefined {
  return value === "." ? undefined : value;
}

function summarize(paths: ChangedPath[]): WorkingTreeStatus {
  const counts = { staged: 0, unstaged: 0, untracked: 0, unmerged: 0, submodule: 0 };
  for (const path of paths) {
    if (path.kind === "untracked") counts.untracked += 1;
    if (path.kind === "unmerged") counts.unmerged += 1;
    if (path.indexStatus !== undefined) counts.staged += 1;
    if (path.worktreeStatus !== undefined) counts.unstaged += 1;
    if (path.submoduleStatus?.startsWith("S")) counts.submodule += 1;
  }
  return { dirty: paths.length > 0, paths, counts };
}
