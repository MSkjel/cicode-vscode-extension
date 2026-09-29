import * as vscode from "vscode";
import * as path from "path";
import { findWorkspaceFiles, cfg } from "../config";
import { CI_FILE_GLOB } from "../shared/globs";

export function makeSideBar() {
  const disposables: vscode.Disposable[] = [];
  const provider = new CicodeExplorerProvider();
  disposables.push(
    vscode.window.registerTreeDataProvider("cicodeExplorer", provider),
  );

  // The view shows only while the workspace holds .ci files (its "when" in
  // package.json): any view that can be expanded activates the extension
  // (onView), also in workspaces without Cicode.
  const sync = () => {
    provider.refresh();
    void provider
      .hasFiles()
      .then((has) =>
        vscode.commands.executeCommand(
          "setContext",
          "cicode.hasCicodeFiles",
          has,
        ),
      );
  };

  // The tree lists files only, so content changes don't affect it.
  const watcher = vscode.workspace.createFileSystemWatcher(
    CI_FILE_GLOB,
    false,
    true,
    false,
  );
  watcher.onDidCreate(sync);
  watcher.onDidDelete(sync);
  disposables.push(
    watcher,
    vscode.workspace.onDidChangeWorkspaceFolders(sync),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("cicode.indexing.excludePatterns")) sync();
      else if (e.affectsConfiguration("cicode.explorer.expandFolders"))
        provider.refresh();
    }),
  );
  sync();

  return disposables;
}

class CicodeExplorerItem extends vscode.TreeItem {
  constructor(
    readonly label: string,
    readonly collapsibleState: vscode.TreeItemCollapsibleState,
    readonly resourceUri?: vscode.Uri,
    readonly isFile: boolean = false,
  ) {
    super(label, collapsibleState);
    this.contextValue = isFile ? "file" : "folder";
    // The id carries a folder's default state, so a changed
    // cicode.explorer.expandFolders applies instead of the remembered state.
    if (resourceUri) this.id = `${collapsibleState}:${resourceUri.fsPath}`;
    if (resourceUri && isFile) {
      this.resourceUri = resourceUri;
      this.command = {
        command: "vscode.open",
        title: "Open Cicode File",
        arguments: [resourceUri],
      };
    }
  }
}

class CicodeExplorerProvider implements vscode.TreeDataProvider<CicodeExplorerItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    CicodeExplorerItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private ciDirs: Set<string> | null = null;
  private ciFiles: Set<string> | null = null;

  refresh() {
    this.ciDirs = null;
    this.ciFiles = null;
    this._onDidChangeTreeData.fire();
  }

  async hasFiles(): Promise<boolean> {
    await this.getCiDirs();
    return (this.ciFiles?.size ?? 0) > 0;
  }

  getTreeItem(element: CicodeExplorerItem): vscode.TreeItem {
    return element;
  }

  async getChildren(
    element?: CicodeExplorerItem,
  ): Promise<CicodeExplorerItem[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return [];

    const ciDirs = await this.getCiDirs();

    if (!element) {
      if (folders.length === 1) {
        return this.readDirectory(folders[0].uri.fsPath, ciDirs);
      }
      const folderState = cfg().get("cicode.explorer.expandFolders", false)
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
      return folders
        .filter((f) => ciDirs.has(f.uri.fsPath))
        .map((f) => new CicodeExplorerItem(f.name, folderState, f.uri, false));
    }

    if (element.resourceUri) {
      return this.readDirectory(element.resourceUri.fsPath, ciDirs);
    }

    return [];
  }

  private async getCiDirs(): Promise<Set<string>> {
    if (this.ciDirs) return this.ciDirs;

    const uris = await findWorkspaceFiles(CI_FILE_GLOB, cfg);
    const dirs = new Set<string>();
    const files = new Set<string>();
    for (const uri of uris) {
      files.add(uri.fsPath);
      let dir = path.dirname(uri.fsPath);
      while (!dirs.has(dir)) {
        dirs.add(dir);
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    this.ciDirs = dirs;
    this.ciFiles = files;
    return dirs;
  }

  private readDirectory(
    dirPath: string,
    ciDirs: Set<string>,
  ): CicodeExplorerItem[] {
    const children = new Map<string, boolean>(); // fullPath -> isDirectory

    for (const filePath of this.ciFiles!) {
      const parent = path.dirname(filePath);
      if (parent === dirPath) children.set(filePath, false);
    }
    for (const dir of ciDirs) {
      if (path.dirname(dir) === dirPath) children.set(dir, true);
    }

    return [...children.entries()]
      .sort(([aPath, aIsDir], [bPath, bIsDir]) => {
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return path.basename(aPath).localeCompare(path.basename(bPath));
      })
      .map(
        ([fullPath, isDir]) =>
          new CicodeExplorerItem(
            path.basename(fullPath),
            isDir
              ? cfg().get("cicode.explorer.expandFolders", false)
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed
              : vscode.TreeItemCollapsibleState.None,
            vscode.Uri.file(fullPath),
            !isDir,
          ),
      );
  }
}
