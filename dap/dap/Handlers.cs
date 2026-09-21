using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace CicodeDebugAdapter
{
    /// <summary>
    /// Dispatches incoming DAP requests from VS Code and implements each handler.
    /// All IPC sends go through IpcClient; all DAP sends go through DapTransport.
    /// </summary>
    static class DapHandlers
    {
        const string FILTER_HW_ERROR = "hardwareError";
        const int BP_ACK_TIMEOUT_MS = 1500;

        public static void HandleRequest(string json)
        {
            var msg = Json.Parse(json);
            string cmd = msg.GetStr("command") ?? "";
            if (cmd == "")
                return; // not a request message
            int seq = msg.GetInt("seq");
            var args = msg.GetObj("arguments") ?? new Dictionary<string, object>();

            Logger.DapIn("cmd=" + cmd + " seq=" + seq);

            try
            {
                Dispatch(cmd, seq, args);
            }
            catch (Exception ex)
            {
                // Always answer: VS Code waits forever for a response that never comes.
                Logger.Warn("Request '" + cmd + "' failed: " + ex);
                DapTransport.Response(seq, cmd, false, null, ex.Message);
            }
        }

        static void Dispatch(string cmd, int seq, Dictionary<string, object> args)
        {
            switch (cmd)
            {
                case "initialize":
                    OnInitialize(seq, args);
                    break;
                case "attach":
                    OnAttach(seq, args);
                    break;
                case "launch":
                    DapTransport.Response(
                        seq,
                        cmd,
                        false,
                        null,
                        "Only \"attach\" is supported: start the runtime, then attach to it."
                    );
                    break;
                case "configurationDone":
                    OnConfigDone(seq);
                    break;
                case "setBreakpoints":
                    OnSetBreakpoints(seq, args);
                    break;
                case "setExceptionBreakpoints":
                    OnSetExceptionBreakpoints(seq, args);
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
                case "pause":
                    OnPause(seq, args);
                    break;
                case "threads":
                    OnThreads(seq);
                    break;
                case "stackTrace":
                    OnStackTrace(seq, args);
                    break;
                case "scopes":
                    OnScopes(seq, args);
                    break;
                case "variables":
                    OnVariables(seq, args);
                    break;
                case "evaluate":
                    OnEvaluate(seq, args);
                    break;
                case "exceptionInfo":
                    OnExceptionInfo(seq, args);
                    break;
                case "disconnect":
                case "terminate":
                    OnDisconnect(seq, cmd);
                    break;
                default:
                    DapTransport.Response(seq, cmd, false, null, "unsupported request: " + cmd);
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
                    + "\"supportsExceptionInfoRequest\":true,"
                    + "\"supportsEvaluateForHovers\":true,"
                    + "\"exceptionBreakpointFilters\":[{\"filter\":"
                    + Json.Str(FILTER_HW_ERROR)
                    + ",\"label\":\"Cicode hardware errors\","
                    + "\"description\":"
                    + Json.Str(
                        "Stop when a Cicode task raises a hardware error. When off, the error is "
                            + "only written to the Debug Console and the task continues."
                    )
                    + ",\"default\":true}],"
                    + "\"supportsStepBack\":false}"
            );
            // "initialized" is sent once attach has connected, so VS Code's breakpoint and
            // configuration requests always arrive after the session exists.
        }

        static void OnAttach(int seq, Dictionary<string, object> args)
        {
            string pipeName = args.GetStr("pipeName") ?? "Citect.Debug";
            // GetStr stringifies JSON booleans as "False"/"True", so compare case-insensitively.
            DapState.StripQualityTags = !string.Equals(
                args.GetStr("stripQualityTags"),
                "false",
                StringComparison.OrdinalIgnoreCase
            );
            try
            {
                IpcClient.Connect(pipeName);
            }
            catch (Exception ex)
            {
                Logger.Warn("Attach failed: " + ex.Message);
                DapTransport.Response(seq, "attach", false, null, ex.Message);
                DapTransport.Event("terminated");
                return;
            }

            DapState.Attached = true;
            DapTransport.Response(seq, "attach", true);
            DapTransport.Output("console", "Connected to SCADA runtime (" + pipeName + ")\n");

            // Breakpoints that arrived before the session existed.
            SyncAllBreakpoints(true);
            DapTransport.Event("initialized");
        }

        static void OnConfigDone(int seq)
        {
            DapState.ConfigDone = true;
            DapTransport.Response(seq, "configurationDone", true);
        }

        // Stable DAP ids per file:line, so "breakpoint" change events can refer to them.
        static readonly Dictionary<string, int> _dapBpIds = new Dictionary<string, int>();
        static int _nextDapBpId = 1;

        static int DapBpId(string key, int line)
        {
            string k = key + ":" + line;
            int id;
            lock (_dapBpIds)
            {
                if (!_dapBpIds.TryGetValue(k, out id))
                    _dapBpIds[k] = id = _nextDapBpId++;
            }
            return id;
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
                    specs.Add(new Json.BpSpec { Line = l, Enabled = true });
            }

            var lines = new List<int>(); // enabled lines only, sent to the runtime
            var conditions = new Dictionary<int, string>();
            foreach (var s in specs)
            {
                if (s.Enabled && !lines.Contains(s.Line))
                    lines.Add(s.Line);
                if (s.Condition != null)
                    conditions[s.Line] = s.Condition;
            }

            string key = DebugClient.NormalizePath(srcPath);
            lock (DapState.SessionLock)
            {
                DapState.PendingBps[key] = lines;
                DapState.BpPaths[key] = srcPath;
                DapState.BpConditions[key] = conditions;
            }

            HashSet<int> acked = null;
            if (DapState.Attached && srcPath.Length > 0)
            {
                // Adds and removes individually: the runtime clears a breakpoint by the id it
                // returned when it was set, so no reconnect is needed (and paused threads stay put).
                IpcClient.SyncFileBreakpoints(srcPath, lines);
                acked = IpcClient.WaitForBpAcks(srcPath, lines, BP_ACK_TIMEOUT_MS);
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
                string msg = condErr;
                bool verified;
                if (!DapState.Attached)
                {
                    verified = false;
                    msg = msg ?? "Not attached to the runtime yet.";
                }
                else
                {
                    verified = condErr == null && acked != null && acked.Contains(specs[i].Line);
                    if (msg == null && !verified)
                        msg = "The runtime did not confirm this breakpoint.";
                }
                bps.Append("{\"id\":")
                    .Append(DapBpId(key, specs[i].Line))
                    .Append(",\"verified\":")
                    .Append(verified ? "true" : "false")
                    .Append(",\"line\":")
                    .Append(specs[i].Line);
                if (msg != null)
                    bps.Append(",\"message\":").Append(Json.Str(msg));
                bps.Append("}");
            }
            bps.Append("]");
            DapTransport.Response(seq, "setBreakpoints", true, "{\"breakpoints\":" + bps + "}");
        }

        /// <summary>Push every known breakpoint to the runtime (after attach).</summary>
        static void SyncAllBreakpoints(bool announce)
        {
            var files = new List<KeyValuePair<string, List<int>>>();
            var conds = new Dictionary<string, Dictionary<int, string>>();
            lock (DapState.SessionLock)
            {
                foreach (var kv in DapState.PendingBps)
                {
                    string path = DapState.BpPaths.ContainsKey(kv.Key) ? DapState.BpPaths[kv.Key] : kv.Key;
                    files.Add(new KeyValuePair<string, List<int>>(path, new List<int>(kv.Value)));
                    Dictionary<int, string> c;
                    if (DapState.BpConditions.TryGetValue(kv.Key, out c))
                        conds[path] = c;
                }
            }
            foreach (var kv in files)
                IpcClient.SyncFileBreakpoints(kv.Key, kv.Value);
            if (!announce)
                return;
            foreach (var kv in files)
            {
                HashSet<int> acked = IpcClient.WaitForBpAcks(kv.Key, kv.Value, BP_ACK_TIMEOUT_MS);
                string key = DebugClient.NormalizePath(kv.Key);
                foreach (int line in kv.Value)
                {
                    Dictionary<int, string> c;
                    string cond;
                    bool condOk =
                        !conds.TryGetValue(kv.Key, out c)
                        || !c.TryGetValue(line, out cond)
                        || IpcClient.ValidateCondition(cond) == null;
                    bool verified = condOk && acked.Contains(line);
                    DapTransport.Event(
                        "breakpoint",
                        "{\"reason\":\"changed\",\"breakpoint\":{\"id\":"
                            + DapBpId(key, line)
                            + ",\"verified\":"
                            + (verified ? "true" : "false")
                            + ",\"line\":"
                            + line
                            + "}}"
                    );
                }
            }
        }

        static void OnSetExceptionBreakpoints(int seq, Dictionary<string, object> args)
        {
            bool hw = false;
            object v;
            var list = args.TryGetValue("filters", out v) ? v as System.Collections.ArrayList : null;
            if (list != null)
                foreach (object f in list)
                    if (f != null && f.ToString() == FILTER_HW_ERROR)
                        hw = true;
            DapState.BreakOnHardwareErrors = hw;
            DapTransport.Response(seq, "setExceptionBreakpoints", true);
        }

        static void OnContinue(int seq, Dictionary<string, object> args)
        {
            // CONTINUE_ALL runs every suspended task until its next breakpoint.
            IpcClient.ContinueAll();
            DapTransport.Response(seq, "continue", true, "{\"allThreadsContinued\":true}");
        }

        static void OnStep(int seq, Dictionary<string, object> args, uint stepCmd)
        {
            string stepName =
                stepCmd == IpcClient.CMD_STEP_OVER ? "next"
                : stepCmd == IpcClient.CMD_STEP_INTO ? "stepIn"
                : "stepOut";

            int tid = args.GetInt("threadId", 0);
            if (tid <= 0 || !DapState.IsThreadPaused(tid))
            {
                lock (DapState.SessionLock)
                {
                    tid = -1;
                    foreach (int t in DapState.PausedThreads)
                    {
                        tid = t;
                        break;
                    }
                }
            }
            if (tid <= 0)
            {
                DapTransport.Response(seq, stepName, false, null, "No Cicode thread is paused.");
                return;
            }

            IpcClient.Step(tid, stepCmd);
            DapTransport.Response(seq, stepName, true);
        }

        static void OnPause(int seq, Dictionary<string, object> args)
        {
            // The runtime cannot suspend a chosen task: Break suspends whichever background
            // task executes the next Cicode statement.
            IpcClient.Pause();
            DapTransport.Response(seq, "pause", true);
            DapTransport.Output(
                "console",
                "Pause requested: the runtime stops at the next Cicode statement any background task executes.\n"
            );
        }

        static void OnThreads(int seq)
        {
            var sb = new StringBuilder("[");
            bool first = true;
            var ids = new List<int>();
            lock (DapState.SessionLock)
            {
                ids.AddRange(DapState.Threads);
                foreach (int t in DapState.PausedThreads)
                    if (!ids.Contains(t))
                        ids.Add(t);
            }
            ids.Sort();
            foreach (int tid in ids)
            {
                if (!first)
                    sb.Append(',');
                sb.Append("{\"id\":")
                    .Append(tid)
                    .Append(",\"name\":")
                    .Append(Json.Str(ThreadName(tid)))
                    .Append("}");
                first = false;
            }
            if (first)
                sb.Append("{\"id\":1,\"name\":\"Cicode\"}"); // no threads known yet
            sb.Append("]");
            DapTransport.Response(seq, "threads", true, "{\"threads\":" + sb + "}");
        }

        static string ThreadName(int tid)
        {
            // Name the task after its outermost function when the stack is known.
            lock (DapState.VarsLock)
            {
                List<CicodeFrame> f;
                if (DapState.FramesByThread.TryGetValue(tid, out f) && f.Count > 0)
                {
                    string root = f[f.Count - 1].Name;
                    if (!string.IsNullOrEmpty(root))
                        return "Cicode thread " + tid + " (" + root + ")";
                }
            }
            return "Cicode thread " + tid;
        }

        // Frame id encoding:       FRAME_ID_BASE + (tid << 8 | frameIdx) (frameIdx 0 = innermost)
        // Locals varRef encoding:  LOCALS_REF_BASE + (tid << 8 | frameIdx)
        // StepWatch varRef = 1 (frame-independent)
        // Embedding the thread id lets stackTrace -> scopes -> variables round-trip
        // to the right thread's frames (DapState.FramesByThread).
        const int FRAME_ID_BASE = 1000;
        const int LOCALS_REF_BASE = 2000;
        const int STEP_WATCH_REF = 1;
        const int ENC_TID_MAX = 0x3FFFFF; // Citect thread handles are small ints in practice
        const int ENC_FRAME_MAX = 0xFF; // frames rendered per thread

        static bool CanEncodeTid(int tid)
        {
            return tid > 0 && tid <= ENC_TID_MAX;
        }

        static int EncodeFrame(int tid, int frameIdx)
        {
            return CanEncodeTid(tid) ? ((tid << 8) | frameIdx) : frameIdx;
        }

        static void DecodeFrame(int enc, out int tid, out int frameIdx)
        {
            tid = enc >> 8;
            frameIdx = tid > 0 ? (enc & 0xFF) : enc;
        }

        static void OnStackTrace(int seq, Dictionary<string, object> args)
        {
            int tid = args.GetInt("threadId", -1);

            string file;
            int line;
            DapState.TryGetThreadLocation(tid, out file, out line);

            // Wait briefly for this thread's stack payload (PrefetchVars asked for it on stop).
            List<CicodeFrame> frames = DapState.WaitForLocals(tid, 700) ?? new List<CicodeFrame>();

            int renderCount = frames.Count;
            if (renderCount > ENC_FRAME_MAX + 1)
                renderCount = ENC_FRAME_MAX + 1;

            var sb = new StringBuilder("[");
            if (renderCount == 0)
            {
                // Fallback: synthetic single frame from the thread location.
                sb.Append("{\"id\":")
                    .Append(FRAME_ID_BASE + EncodeFrame(tid, 0))
                    .Append(",\"name\":\"Cicode\"");
                if (file != null && line > 0)
                    sb.Append(",\"source\":{\"path\":")
                        .Append(Json.Str(file))
                        .Append("},\"line\":")
                        .Append(line);
                else
                    sb.Append(",\"line\":0");
                sb.Append(",\"column\":0}");
            }
            else
            {
                for (int i = 0; i < renderCount; i++)
                {
                    if (i > 0) sb.Append(',');
                    string name = frames[i].Name;
                    if (string.IsNullOrEmpty(name)) name = "Cicode";
                    sb.Append("{\"id\":")
                        .Append(FRAME_ID_BASE + EncodeFrame(tid, i))
                        .Append(",\"name\":")
                        .Append(Json.Str(name));
                    // Only the innermost frame has a known source location.
                    if (i == 0 && file != null && line > 0)
                        sb.Append(",\"source\":{\"path\":")
                            .Append(Json.Str(file))
                            .Append("},\"line\":")
                            .Append(line);
                    else
                        sb.Append(",\"line\":0,\"presentationHint\":\"subtle\"");
                    sb.Append(",\"column\":0}");
                }
            }
            sb.Append("]");

            int total = renderCount > 0 ? renderCount : 1;
            DapTransport.Response(
                seq,
                "stackTrace",
                true,
                "{\"stackFrames\":" + sb + ",\"totalFrames\":" + total + "}"
            );
        }

        static void OnScopes(int seq, Dictionary<string, object> args)
        {
            int frameId = args.GetInt("frameId", FRAME_ID_BASE);
            int enc = frameId - FRAME_ID_BASE;
            if (enc < 0) enc = 0;
            int tid, frameIdx;
            DecodeFrame(enc, out tid, out frameIdx);
            if (tid > 0 ? !DapState.IsThreadPaused(tid) : !DapState.IsStopped)
            {
                DapTransport.Response(seq, "scopes", true, "{\"scopes\":[]}");
                return;
            }

            // Carry the tid-encoded frame value straight into the locals varRef; OnVariables
            // decodes it. No collision with STEP_WATCH_REF since LOCALS_REF_BASE = 2000.
            int localsRef = LOCALS_REF_BASE + enc;

            DapTransport.Response(
                seq,
                "scopes",
                true,
                "{\"scopes\":["
                    + "{\"name\":\"Locals\",\"variablesReference\":" + localsRef
                    + ",\"expensive\":false,\"presentationHint\":\"locals\"},"
                    + "{\"name\":\"Step Watch\",\"variablesReference\":" + STEP_WATCH_REF
                    + ",\"expensive\":false,\"presentationHint\":\"registers\"}"
                    + "]}"
            );
        }

        static Dictionary<string, string> FrameLocals(int tid, int frameIdx, int waitMs)
        {
            List<CicodeFrame> frames = DapState.WaitForLocals(tid, waitMs);
            if (frames == null || frameIdx < 0 || frameIdx >= frames.Count)
                return null;
            return frames[frameIdx].Locals;
        }

        static void OnVariables(int seq, Dictionary<string, object> args)
        {
            int varRef = args.GetInt("variablesReference");

            if (varRef == STEP_WATCH_REF)
            {
                DapState.StepWatchReady.Wait(400);
                Dictionary<string, string> sw;
                lock (DapState.VarsLock)
                    sw = new Dictionary<string, string>(DapState.StepWatchVars);
                DapTransport.Response(
                    seq,
                    "variables",
                    true,
                    "{\"variables\":"
                        + BuildVarArray(sw, "(none)", "No global or module variables used by this task yet")
                        + "}"
                );
                return;
            }

            if (varRef >= LOCALS_REF_BASE)
            {
                int tid, frameIdx;
                DecodeFrame(varRef - LOCALS_REF_BASE, out tid, out frameIdx);
                var vars = FrameLocals(tid, frameIdx, 500) ?? new Dictionary<string, string>();
                DapTransport.Response(
                    seq,
                    "variables",
                    true,
                    "{\"variables\":" + BuildVarArray(
                        vars,
                        "(pending)",
                        "Local variable data not yet received from the runtime"
                    ) + "}"
                );
                return;
            }

            DapTransport.Response(seq, "variables", true, "{\"variables\":[]}");
        }

        static readonly Regex IdentRx = new Regex(@"^[A-Za-z_][A-Za-z0-9_]*$");

        static void OnEvaluate(int seq, Dictionary<string, object> args)
        {
            string expr = (args.GetStr("expression") ?? "").Trim();
            string context = args.GetStr("context") ?? "repl";
            int frameId = args.GetInt("frameId", -1);

            // A plain identifier that is a local of the selected frame: answer from the stack
            // snapshot (the runtime evaluates CtAPI expressions outside the paused task).
            if (IdentRx.IsMatch(expr) && frameId >= FRAME_ID_BASE)
            {
                int tid, frameIdx;
                DecodeFrame(frameId - FRAME_ID_BASE, out tid, out frameIdx);
                var locals = FrameLocals(tid, frameIdx, 300);
                if (locals != null)
                    foreach (var kv in locals)
                        if (string.Equals(kv.Key, expr, StringComparison.OrdinalIgnoreCase))
                        {
                            DapTransport.Response(
                                seq,
                                "evaluate",
                                true,
                                "{\"result\":" + Json.Str(kv.Value) + ",\"variablesReference\":0}"
                            );
                            return;
                        }
            }

            if (context == "hover")
            {
                // Never run Cicode for a hover: an identifier may be a function that would execute.
                DapTransport.Response(seq, "evaluate", false, null, "not a local variable");
                return;
            }

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

        static void OnExceptionInfo(int seq, Dictionary<string, object> args)
        {
            int tid = args.GetInt("threadId", -1);
            DapState.ErrorInfo e = DapState.GetErrorInfo(tid);
            if (e == null)
            {
                DapTransport.Response(seq, "exceptionInfo", false, null, "No Cicode hardware error on this thread.");
                return;
            }
            string exceptionId = "Hardware error " + e.Code;
            var desc = new StringBuilder();
            desc.Append(string.IsNullOrEmpty(e.Message) ? "Cicode hardware error" : e.Message);
            if (!string.IsNullOrEmpty(e.ErrPage))
                desc.Append(" (raised by ").Append(e.ErrPage).Append(')');
            if (!string.IsNullOrEmpty(e.ErrDesc))
                desc.Append(" in ").Append(e.ErrDesc);
            var trace = new StringBuilder();
            if (!string.IsNullOrEmpty(e.Detail))
                trace.Append(e.Detail.Replace("\r", "")).Append('\n');
            if (e.File != null)
                trace.Append("at ").Append(e.File).Append(':').Append(e.Line).Append('\n');
            if (e.PauseLine > 0 && e.PauseLine != e.Line)
                trace.Append("The task is suspended before line ").Append(e.PauseLine)
                    .Append("; stepping continues from there.\n");
            DapTransport.Response(
                seq,
                "exceptionInfo",
                true,
                "{\"exceptionId\":" + Json.Str(exceptionId)
                    + ",\"description\":" + Json.Str(desc.ToString())
                    + ",\"breakMode\":\"always\""
                    + ",\"details\":{\"message\":" + Json.Str(e.Text ?? desc.ToString())
                    + ",\"typeName\":\"Cicode hardware error\""
                    + ",\"stackTrace\":" + Json.Str(trace.ToString().TrimEnd()) + "}}"
            );
        }

        static void OnDisconnect(int seq, string cmd)
        {
            DapTransport.Response(seq, cmd, true);
            IpcClient.Disconnect();
            DapState.Reset();
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
