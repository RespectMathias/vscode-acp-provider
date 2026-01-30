// SPDX-License-Identifier: Apache-2.0
import fs from "fs";
import path from "path";
import * as vscode from "vscode";

export function getWorkspaceCwd(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return "";
  }
  return folders[0].uri.fsPath;
}

export function getWorkspaceRoots(): string[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }
  return folders.map((folder) => folder.uri.fsPath);
}

export function coerceToFsPath(value: string): string {
  if (value.startsWith("file:")) {
    try {
      return vscode.Uri.parse(value).fsPath;
    } catch {
      return value;
    }
  }
  return value;
}

export function resolveWorkspacePath(targetPath: string): string | undefined {
  const normalized = coerceToFsPath(targetPath);
  const roots = getWorkspaceRoots();
  if (roots.length === 0) {
    return undefined;
  }
  const absolute = path.isAbsolute(normalized)
    ? normalized
    : path.join(roots[0], normalized);
  const resolved = path.resolve(absolute);
  const isAllowed = roots.some((root) => isWithin(root, resolved));
  if (!isAllowed) {
    return undefined;
  }
  return resolved;
}

export async function resolveWorkspacePathSecure(
  targetPath: string,
  mode: "read" | "write" | "cwd",
): Promise<string | undefined> {
  const resolved = resolveWorkspacePath(targetPath);
  if (!resolved) {
    return undefined;
  }

  const roots = getWorkspaceRoots();
  if (roots.length === 0) {
    return undefined;
  }

  const rootRealpaths = await Promise.all(
    roots.map(async (root) => {
      try {
        return await fs.promises.realpath(root);
      } catch {
        return root;
      }
    }),
  );

  const isWithinRealRoot = (candidate: string): boolean =>
    rootRealpaths.some((root) => isWithin(root, candidate));

  if (mode === "read") {
    try {
      const realTarget = await fs.promises.realpath(resolved);
      if (!isWithinRealRoot(realTarget)) {
        return undefined;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return undefined;
      }
      const existingPath = await findExistingPath(resolved);
      if (!existingPath) {
        return undefined;
      }
      try {
        const realExisting = await fs.promises.realpath(existingPath);
        if (!isWithinRealRoot(realExisting)) {
          return undefined;
        }
      } catch {
        return undefined;
      }
    }
    return resolved;
  }

  const existingPath = await findExistingPath(resolved);
  if (!existingPath) {
    return undefined;
  }

  try {
    const realExisting = await fs.promises.realpath(existingPath);
    if (!isWithinRealRoot(realExisting)) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return resolved;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative) {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function findExistingPath(target: string): Promise<string | undefined> {
  let current = target;
  while (true) {
    try {
      await fs.promises.stat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return undefined;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }
}
