import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { cfg } from "./config";
import {
  initBuiltins,
  rebuildBuiltins,
  clearPathCache,
  applySignatureOverrides,
} from "./core/builtins/builtins";
import { Indexer } from "./core/indexer/indexer";
import { registerProviders } from "./features/providers";
import { registerCommands } from "./features/commands";
import { makeStatusBar } from "./features/statusBar";
import { makeSideBar } from "./features/sideBar";
import { log, error } from "./shared/utils";

let indexer: Indexer | undefined;

export async function activate(context: vscode.ExtensionContext) {
  try {
    await initBuiltins(context, cfg);

    indexer = new Indexer(context, cfg);
    context.subscriptions.push({ dispose: () => indexer?.dispose() });

    const disposables: vscode.Disposable[] = [];
    disposables.push(...registerProviders(context, indexer, cfg));
    disposables.push(...registerCommands(context, indexer, cfg));
    disposables.push(makeStatusBar(indexer));
    disposables.push(...makeSideBar());

    const adapterExe = context.asAbsolutePath(
      path.join("dap", "cicode-debug-adapter.exe"),
    );
    if (!fs.existsSync(adapterExe)) {
      vscode.window.showWarningMessage(
        `Cicode: debug adapter not found at ${adapterExe}. Run 'build.cmd' in the dap/ folder to build it.`,
      );
    }
    disposables.push(
      vscode.languages.registerInlineValuesProvider(
        { language: "cicode" },
        {
          async provideInlineValues(
            document: vscode.TextDocument,
            viewPort: vscode.Range,
            context: vscode.InlineValueContext,
          ): Promise<vscode.InlineValue[]> {
            const session = vscode.debug.activeDebugSession;
            if (!session || session.type !== "cicode") return [];
            try {
              const { scopes } = await session.customRequest("scopes", {
                frameId: context.frameId,
              });
              const locals = scopes?.find(
                (s: { name: string }) => s.name === "Locals",
              );
              if (!locals) return [];
              const { variables } = await session.customRequest("variables", {
                variablesReference: locals.variablesReference,
              });
              if (!variables?.length) return [];

              const varNames: string[] = variables.map(
                (v: { name: string }) => v.name,
              );
              const result: vscode.InlineValue[] = [];
              const lines = document.getText().split("\n");

              for (
                let li = viewPort.start.line;
                li <= Math.min(viewPort.end.line, lines.length - 1);
                li++
              ) {
                const line = lines[li];
                for (const name of varNames) {
                  let col = 0;
                  while (col < line.length) {
                    const idx = line.indexOf(name, col);
                    if (idx < 0) break;
                    const beforeOk = idx === 0 || !/\w/.test(line[idx - 1]);
                    const afterOk =
                      idx + name.length >= line.length ||
                      !/\w/.test(line[idx + name.length]);
                    if (beforeOk && afterOk) {
                      result.push(
                        new vscode.InlineValueVariableLookup(
                          new vscode.Range(li, idx, li, idx + name.length),
                          name,
                          true,
                        ),
                      );
                    }
                    col = idx + 1;
                  }
                }
              }
              return result;
            } catch {
              return [];
            }
          },
        },
      ),
      vscode.debug.registerDebugConfigurationProvider("cicode", {
        resolveDebugConfiguration(
          _folder: vscode.WorkspaceFolder | undefined,
          config: vscode.DebugConfiguration,
        ): vscode.DebugConfiguration {
          // No launch.json, supply defaults so F5 just works
          if (!config.type && !config.request) {
            config.type = "cicode";
            config.request = "attach";
            config.name = "Attach to SCADA Runtime";
          }
          return config;
        },
      }),
      vscode.debug.registerDebugAdapterDescriptorFactory("cicode", {
        createDebugAdapterDescriptor(_session: vscode.DebugSession) {
          return new vscode.DebugAdapterExecutable(adapterExe, []);
        },
      }),
    );

    // Invalidate builtin path cache when AVEVA path changes so the next help
    // lookup resolves fresh paths instead of serving stale ones.
    disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("cicode.avevaPath")) {
          clearPathCache();
        }
        if (e.affectsConfiguration("cicode.signatureOverrides")) {
          applySignatureOverrides(cfg);
          indexer?.buildAll();
        }
      }),
    );

    context.subscriptions.push(...disposables);

    // Build index in the background. Providers handle the "not yet ready" state
    const t0 = Date.now();
    indexer
      .buildAll()
      .then(() => log(`index built in ${Date.now() - t0}ms`))
      .catch((err) => {
        error("Cicode: Failed to build index:", err);
      });
  } catch (err) {
    error("Cicode extension activation failed:", err);
    vscode.window.showErrorMessage(
      `Cicode extension failed to activate: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

export function deactivate() {
  // Cleanup handled by context.subscriptions
}
