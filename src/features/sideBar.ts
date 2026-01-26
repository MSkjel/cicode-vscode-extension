import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

export function makeSideBar() {
  const disposables: vscode.Disposable[] = [];
  const provider = new CicodeExplorerProvider();
  disposables.push(
    vscode.window.registerTreeDataProvider("cicodeExplorer", provider)
  );

  const watcher = vscode.workspace.createFileSystemWatcher("**/*.ci");
  watcher.onDidCreate(() => provider.refresh());
  watcher.onDidChange(() => provider.refresh());
  watcher.onDidDelete(() => provider.refresh());
  disposables.push(watcher);

  return disposables;
}

class CicodeExplorerItem extends vscode.TreeItem {
  constructor(readonly label: string, readonly collapsibleState: vscode.TreeItemCollapsibleState, readonly resourceUri?: vscode.Uri, readonly isFile: boolean = false) {
    super(label, collapsibleState);
    this.contextValue = isFile ? "file" : "folder";
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
  private _onDidChangeTreeData = new vscode.EventEmitter<CicodeExplorerItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: CicodeExplorerItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: CicodeExplorerItem): Thenable<CicodeExplorerItem[]> {
    if (!vscode.workspace.workspaceFolders) {
      return Promise.resolve([]);
    }

    if (!element) {
      const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
      return Promise.resolve(this.readDirectory(rootPath));
    }

    if (element.resourceUri) {
      return Promise.resolve(this.readDirectory(element.resourceUri.fsPath));
    }

    return Promise.resolve([]);
  }

  private readDirectory(dirPath: string): CicodeExplorerItem[] {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const sorted = entries
        .filter((e) => e.isDirectory() || e.name.endsWith(".ci"))
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

    return sorted.map((e) => {
      const fullPath = path.join(dirPath, e.name);
      return new CicodeExplorerItem(
        e.name,
        e.isDirectory()
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None,
        vscode.Uri.file(fullPath),
        !e.isDirectory()
      );
    });
  }
}
