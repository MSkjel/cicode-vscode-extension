using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;

namespace CicodeDebugAdapter
{
    /// <summary>
    /// Dispatches incoming DAP requests from VS Code and implements each handler.
    /// All IPC sends go through IpcClient; all DAP sends go through DapTransport.
    /// </summary>
    static class DapHandlers
    {
        public static void HandleRequest(string json)
        {
            var msg = Json.Parse(json);
            string cmd = msg.GetStr("command") ?? "";
            if (cmd == "")
                return; // not a request message
            int seq = msg.GetInt("seq");
            var args = msg.GetObj("arguments") ?? new Dictionary<string, object>();

            Logger.DapIn("cmd=" + cmd + " seq=" + seq);

            switch (cmd)
            {
                case "initialize":
                    OnInitialize(seq, args);
                    break;
                case "attach":
                    OnAttach(seq, args);
                    break;
                case "configurationDone":
                    OnConfigDone(seq);
                    break;
                case "setBreakpoints":
                    OnSetBreakpoints(seq, args);
                    break;
                case "continue":
                    OnContinue(seq, args);
                    break;
                case "next":
                    OnStep(seq, args, IpcClient.CMD_STEP_OVER);
                    break;
                case "stepIn":
                    OnStep(seq, args, IpcClient.CMD_STEP_INTO);
                    break;
                case "stepOut":
                    OnStep(seq, args, IpcClient.CMD_STEP_OUT);
                    break;
                case "threads":
                    OnThreads(seq);
                    break;
                case "stackTrace":
                    OnStackTrace(seq, args);
                    break;
                case "scopes":
                    OnScopes(seq);
                    break;
                case "variables":
                    OnVariables(seq, args);
                    break;
                case "evaluate":
                    OnEvaluate(seq, args);
                    break;
                case "disconnect":
                case "terminate":
                    OnDisconnect(seq);
                    break;
                default:
                    DapTransport.Response(seq, cmd, true);
                    break;
            }
        }

        static void OnInitialize(int seq, Dictionary<string, object> args)
        {
            DapTransport.Response(
                seq,
                "initialize",
                true,
                "{\"supportsConfigurationDoneRequest\":true,"
                    + "\"supportsTerminateRequest\":true,"
                    + "\"supportsConditionalBreakpoints\":true,"
                    + "\"supportsStepBack\":false}"
            );
            DapTransport.Event("initialized");
        }

        static void OnAttach(int seq, Dictionary<string, object> args)
        {
            string pipeName = args.GetStr("pipeName") ?? "Citect.Debug";
            DapState.StripQualityTags = args.GetStr("stripQualityTags") != "false";
            try
            {
                IpcClient.Connect(pipeName);
                DapState.Attached = true;
                DapTransport.Response(seq, "attach", true);
                DapTransport.Output("console", "Connected to SCADA runtime (" + pipeName + ")\n");

                // If configurationDone already arrived before attach, sync pending BPs now.
                if (DapState.ConfigDone)
                    SyncBreakpoints();
            }
            catch (Exception ex)
            {
                Logger.Warn("Attach failed: " + ex.Message);
                DapTransport.Response(seq, "attach", false, null, ex.Message);
                DapTransport.Event("terminated");
            }
        }

        static void OnConfigDone(int seq)
        {
            DapTransport.Response(seq, "configurationDone", true);
            if (!DapState.Attached)
            {
                Logger.Dap("configurationDone ignored. not attached");
                return;
            }
            SyncBreakpoints();
            DapState.ConfigDone = true;
        }

        static void OnSetBreakpoints(int seq, Dictionary<string, object> args)
        {
            string srcPath = "";
            var srcObj = args.GetObj("source");
            if (srcObj != null)
                srcPath = srcObj.GetStr("path") ?? "";
            srcPath = srcPath.Replace('/', '\\');

            // Parse ordered list of breakpoints (line + optional condition)
            var specs = args.GetBpSpecs();
            if (specs.Count == 0)
            {
                // Fallback for older-style requests that send a flat "lines" array
                var fallback = args.GetIntList("lines");
                foreach (int l in fallback)
                    specs.Add(new Json.BpSpec { Line = l });
            }

            var lines = new List<int>(); // enabled lines only, sent to the runtime
            var conditions = new Dictionary<int, string>();
            foreach (var s in specs)
            {
                if (s.Enabled)
                    lines.Add(s.Line);
                if (s.Condition != null)
                    conditions[s.Line] = s.Condition;
            }

            string key = srcPath.ToLowerInvariant();

            List<int> oldLines;
            bool needSync;
            lock (DapState.SessionLock)
            {
                // Capture old state before updating so we can diff below.
                DapState.PendingBps.TryGetValue(key, out oldLines);
                oldLines = oldLines != null ? new List<int>(oldLines) : new List<int>();

                DapState.PendingBps[key] = lines;
                DapState.BpPaths[key] = srcPath;
                DapState.BpConditions[key] = conditions;
                needSync = DapState.Attached && DapState.ConfigDone;
            }

            if (needSync)
            {
                bool anyRemoved = false;
                foreach (int l in oldLines)
                    if (!lines.Contains(l))
                    {
                        anyRemoved = true;
                        break;
                    }

                if (anyRemoved)
                {
                    // CMD_BP_CLR via IPC does not restore patched bytecode.
                    // Disconnect + reconnect causes Citect32 to clear all runtime BPs,
                    // then re-register only the BPs still active across all files.
                    // Its a hack, but it works.
                    if (DapState.IsStopped)
                    {
                        // Currently paused at a BP. Defer reconnect until the user continues
                        // so we don't yank the connection out from under a paused session.
                        DapState.PendingReconnect = true;
                    }
                    else
                    {
                        IpcClient.Reconnect();
                        SyncBreakpoints();
                    }
                }
                else
                {
                    // Only additions. No reconnect needed, just set the new lines.
                    foreach (int l in lines)
                        if (!oldLines.Contains(l))
                            IpcClient.SendBp(IpcClient.CMD_BP_SET, srcPath, l);
                }
            }

            var bps = new StringBuilder("[");
            for (int i = 0; i < specs.Count; i++)
            {
                if (i > 0)
                    bps.Append(',');
                string condErr =
                    specs[i].Condition != null
                        ? IpcClient.ValidateCondition(specs[i].Condition)
                        : null;
                bool verified = DapState.Attached && condErr == null;
                bps.Append("{\"id\":")
                    .Append(i + 1)
                    .Append(",\"verified\":")
                    .Append(verified ? "true" : "false")
                    .Append(",\"line\":")
                    .Append(specs[i].Line);
                if (condErr != null)
                    bps.Append(",\"message\":").Append(Json.Str(condErr));
                bps.Append("}");
            }
            bps.Append("]");
            DapTransport.Response(seq, "setBreakpoints", true, "{\"breakpoints\":" + bps + "}");
        }

        static void OnContinue(int seq, Dictionary<string, object> args)
        {
            int tid = args.GetInt("threadId", -1);

            DapState.IsStopped = false;
            DapState.SteppingThread = -1;
            if (tid > 0)
                lock (DapState.SessionLock)
                {
                    DapState.ThreadFile.Remove(tid);
                    DapState.ThreadLine.Remove(tid);
                }

            if (DapState.PendingReconnect)
            {
                // A BP was removed while paused. Now that the user has continued,
                // reconnect to clear runtime BPs and re-register the active ones.
                DapState.PendingReconnect = false;
                IpcClient.Reconnect(); // IsStopped already false. no duplicate "continued" event
                SyncBreakpoints();
                DapTransport.Response(seq, "continue", true, "{\"allThreadsContinued\":true}");
                return;
            }

            // CONTINUE_ALL runs until the next breakpoint (not just one step like RESUME_THREAD)
            IpcClient.SendCmd(
                IpcClient.CMD_CONTINUE_ALL,
                BitConverter.GetBytes(unchecked((uint)-1))
            );
            DapTransport.Response(seq, "continue", true, "{\"allThreadsContinued\":true}");
        }

        static void OnStep(int seq, Dictionary<string, object> args, uint stepCmd)
        {
            int tid = args.GetInt("threadId", 0);
            if (tid == 0)
                tid = DapState.Threads.Count > 0 ? new List<int>(DapState.Threads)[0] : 1;

            DapState.IsStopped = false;
            DapState.SteppingThread = tid;

            string stepName =
                stepCmd == IpcClient.CMD_STEP_OVER ? "next"
                : stepCmd == IpcClient.CMD_STEP_INTO ? "stepIn"
                : "stepOut";

            if (DapState.PendingReconnect)
            {
                // A BP was removed while paused. Reconnect now to clear runtime BPs.
                // Can't step after a reconnect (all threads resume), so treat as continue.
                DapState.PendingReconnect = false;
                DapState.SteppingThread = -1;
                IpcClient.Reconnect();
                SyncBreakpoints();
                DapTransport.Response(seq, stepName, true);
                return;
            }

            IpcClient.SendCmd(stepCmd, BitConverter.GetBytes((uint)tid));
            DapTransport.Response(seq, stepName, true);
        }

        static void OnThreads(int seq)
        {
            var sb = new StringBuilder("[");
            bool first = true;
            lock (DapState.SessionLock)
            {
                foreach (int tid in DapState.Threads)
                {
                    if (!first)
                        sb.Append(',');
                    sb.Append("{\"id\":")
                        .Append(tid)
                        .Append(",\"name\":")
                        .Append(Json.Str("Cicode Thread " + tid))
                        .Append("}");
                    first = false;
                }
            }
            if (first)
                sb.Append("{\"id\":1,\"name\":\"Cicode\"}"); // no threads known yet
            sb.Append("]");
            DapTransport.Response(seq, "threads", true, "{\"threads\":" + sb + "}");
        }

        static void OnStackTrace(int seq, Dictionary<string, object> args)
        {
            int tid = args.GetInt("threadId", -1);

            string file;
            int line;
            DapState.TryGetThreadLocation(tid, out file, out line);

            string frame =
                (file != null && line > 0)
                    ? "{\"id\":"
                        + (tid > 0 ? tid * 1000 : 1)
                        + ",\"name\":\"Cicode\""
                        + ",\"source\":{\"path\":"
                        + Json.Str(file)
                        + "},\"line\":"
                        + line
                        + ",\"column\":0}"
                    : "{\"id\":1,\"name\":\"Cicode\",\"line\":0,\"column\":0}";

            DapTransport.Response(
                seq,
                "stackTrace",
                true,
                "{\"stackFrames\":[" + frame + "],\"totalFrames\":1}"
            );
        }

        static void OnScopes(int seq)
        {
            if (!DapState.IsStopped)
            {
                DapTransport.Response(seq, "scopes", true, "{\"scopes\":[]}");
                return;
            }

            int tid;
            lock (DapState.VarsLock)
            {
                tid = DapState.StoppedThreadId;
                if (tid >= 0)
                {
                    DapState.StepWatchVars.Clear();
                    DapState.StepWatchPending = true;
                    DapState.LocalVars.Clear();
                    DapState.LocalVarsPending = true;
                }
            }
            if (tid >= 0)
            {
                IpcClient.SendCmd(IpcClient.CMD_GET_STEP_WATCH, BitConverter.GetBytes((uint)tid));
                IpcClient.SendCmd(IpcClient.CMD_GET_LOCALS_LIVE, BitConverter.GetBytes((uint)tid));
            }

            DapTransport.Response(
                seq,
                "scopes",
                true,
                "{\"scopes\":["
                    + "{\"name\":\"Locals\",\"variablesReference\":2,\"expensive\":false,\"presentationHint\":\"locals\"},"
                    + "{\"name\":\"Step Watch\",\"variablesReference\":1,\"expensive\":false,\"presentationHint\":\"registers\"}"
                    + "]}"
            );
        }

        static void OnVariables(int seq, Dictionary<string, object> args)
        {
            int varRef = args.GetInt("variablesReference");

            if (varRef == 2)
                RespondWithVariables(
                    seq,
                    DapState.LocalsReady,
                    500,
                    DapState.LocalVars,
                    "(pending)",
                    "Local variable data not yet received. check cicode-dap.log for 0x102a response"
                );
            else if (varRef == 1)
                RespondWithVariables(
                    seq,
                    DapState.StepWatchReady,
                    400,
                    DapState.StepWatchVars,
                    "(none)",
                    "No step-watch variables configured in runtime"
                );
            else
                DapTransport.Response(seq, "variables", true, "{\"variables\":[]}");
        }

        static void RespondWithVariables(
            int seq,
            ManualResetEventSlim ready,
            int timeoutMs,
            Dictionary<string, string> source,
            string emptyName,
            string emptyValue
        )
        {
            ready.Wait(timeoutMs);
            Dictionary<string, string> vars;
            lock (DapState.VarsLock)
            {
                vars = new Dictionary<string, string>(source);
            }
            DapTransport.Response(
                seq,
                "variables",
                true,
                "{\"variables\":" + BuildVarArray(vars, emptyName, emptyValue) + "}"
            );
        }

        static void OnEvaluate(int seq, Dictionary<string, object> args)
        {
            string expr = args.GetStr("expression") ?? "";

            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    string result = CtApiClient.Execute(expr);
                    if (result.Length == 0)
                        result = "(void)";
                    DapTransport.Response(
                        seq,
                        "evaluate",
                        true,
                        "{\"result\":" + Json.Str(result) + ",\"variablesReference\":0}"
                    );
                }
                catch (Exception ex)
                {
                    DapTransport.Response(seq, "evaluate", false, null, ex.Message);
                }
            });
        }

        static void OnDisconnect(int seq)
        {
            DapTransport.Response(seq, "disconnect", true);
            IpcClient.Disconnect();
            DapState.Reset();
        }

        internal static void SyncBreakpoints()
        {
            lock (DapState.SessionLock)
            {
                foreach (var kv in DapState.PendingBps)
                {
                    string path = DapState.BpPaths.ContainsKey(kv.Key)
                        ? DapState.BpPaths[kv.Key]
                        : kv.Key;
                    foreach (int line in kv.Value)
                        IpcClient.SendBp(IpcClient.CMD_BP_SET, path, line);
                }
            }
        }

        static string BuildVarArray(
            Dictionary<string, string> vars,
            string emptyName,
            string emptyValue
        )
        {
            var sb = new StringBuilder("[");
            bool first = true;
            foreach (var kv in vars)
            {
                if (!first)
                    sb.Append(',');
                sb.Append("{\"name\":")
                    .Append(Json.Str(kv.Key))
                    .Append(",\"value\":")
                    .Append(Json.Str(kv.Value))
                    .Append(",\"variablesReference\":0}");
                first = false;
            }
            if (first) // empty. return a sentinel entry so the panel isn't blank
                sb.Append("{\"name\":")
                    .Append(Json.Str(emptyName))
                    .Append(",\"value\":")
                    .Append(Json.Str(emptyValue))
                    .Append(",\"variablesReference\":0}");
            sb.Append("]");
            return sb.ToString();
        }
    }
}
