using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;

namespace CicodeDebugAdapter
{
    /// <summary>
    /// Static facade over DebugClient : PaClient.
    /// All protocol machinery lives in PaClient; this class only exposes the
    /// public API used by DapHandlers and tracks CMB debug events.
    /// </summary>
    static class IpcClient
    {
        // CMB command opcodes
        public const uint CMD_SESSION_START = 0x1020;
        public const uint CMD_SESSION_STOP = 0x1021;
        public const uint CMD_BP_SET = 0x1023;
        public const uint CMD_BP_CLR = 0x102C;
        public const uint CMD_CONTINUE_ALL = 0x102E;
        public const uint CMD_RESUME_THREAD = 0x102F;
        public const uint CMD_STEP_OVER = 0x1031;
        public const uint CMD_STEP_INTO = 0x1030;
        public const uint CMD_STEP_OUT = 0x1032;
        public const uint CMD_GET_STEP_WATCH = 0x1029;
        public const uint CMD_GET_LOCALS_LIVE = 0x102A;
        public const uint CMD_SEND_WATCH = 0x1033;

        // Test hooks
        public static Action<byte[]> WatchRespHook = null;
        public static Action<byte[]> Evt100CHook = null;

        public class BpHitInfo
        {
            public int ThreadId;
            public string File;
            public int Line;
        }

        public static volatile BpHitInfo LastBpHit = null;

        static readonly DebugClient _inst = new DebugClient();

        public static bool Stopping
        {
            get { return _inst.Stopping; }
        }
        public static string PipeName
        {
            get { return _inst.PipeName; }
        }

        public static void InitCrc() { } // no-op: PaClient constructor builds the table

        public static void Connect(string pipeName)
        {
            _inst.Connect(pipeName);
        }

        public static void Disconnect()
        {
            _inst.Disconnect();
        }

        public static void Reconnect()
        {
            _inst.Reconnect();
        }

        public static void SendCmd(uint cmd, byte[] payload)
        {
            _inst.SendCmd(cmd, payload);
        }

        public static void SendBp(uint cmd, string file, int line)
        {
            _inst.SendBp(cmd, file, line);
        }

        public static void SendBpClrAll()
        {
            _inst.SendBpClrAll();
        }

        public static string ValidateCondition(string cond)
        {
            return DebugClient.ValidateCondition(cond);
        }
    }

    class DebugClient : PaClient
    {
        // CMB event opcodes
        const uint EVT_RESUMED = 0x1000;
        const uint EVT_STOPPED = 0x1001;
        const uint EVT_SOURCE_LOC = 0x1002;
        const uint EVT_BP_HIT = 0x1003;
        const uint EVT_STEP_WATCH = 0x1009;
        const uint EVT_LOCALS_LIVE = 0x100A;
        const uint EVT_TEXT_OUTPUT = 0x100C;
        const uint EVT_WATCH_EVAL_RESP = 0x100F;

        public string PipeName;

        bool _sentTranType;

        readonly HashSet<string> _staleClearedKeys = new HashSet<string>();
        readonly Dictionary<string, string[]> _sourceCache = new Dictionary<string, string[]>(
            StringComparer.OrdinalIgnoreCase
        );

        protected override PipeOptions PipeOptions
        {
            get { return PipeOptions.Asynchronous; }
        }

        protected override void RegisterTypes()
        {
            RegisterTypeHint(ScadaVersion.HashTran, "TranEncapsulationMessage");
            RegisterTypeHint(ScadaVersion.HashTranLegacy, "TranEncapsulationMessage");
            RegisterTypeHint(ScadaVersion.HashRtMsg, "RuntimeManagerTimestampedMessage");
        }

        protected override void OnConnected()
        {
            Thread.Sleep(500);
            Logger.Ipc("Sending SESSION_START");
            SendTranCmd(IpcClient.CMD_SESSION_START, new byte[4]);
        }

        protected override void OnDisconnected()
        {
            Logger.Reader("DebugClient: exited");
            if (!Stopping)
                DapTransport.Event("terminated");
            base.OnDisconnected();
        }

        protected override void OnResetState()
        {
            _sentTranType = false;
            _staleClearedKeys.Clear();
            IpcClient.LastBpHit = null;
        }

        public void Connect(string pipeName)
        {
            PipeName = pipeName;
            Logger.Ipc("Connecting to \\\\.\\pipe\\" + pipeName + " ...");
            ConnectPipe(pipeName);
        }

        public void Disconnect()
        {
            Stopping = true;
            try
            {
                SendTranCmd(IpcClient.CMD_SESSION_STOP, new byte[4]);
            }
            catch { }
            CtApiClient.Close();
            try
            {
                _pipe.Close();
            }
            catch { }
        }

        public void Reconnect()
        {
            Logger.Ipc("Reconnect: stopping current session");

            if (DapState.IsStopped)
            {
                DapState.IsStopped = false;
                DapTransport.Event("continued", "{\"allThreadsContinued\":true}");
            }

            Stopping = true;
            try
            {
                SendTranCmd(IpcClient.CMD_SESSION_STOP, new byte[4]);
            }
            catch { }
            try
            {
                _pipe.Close();
            }
            catch { }
            Thread.Sleep(400);

            lock (DapState.SessionLock)
            {
                DapState.Threads.Clear();
                DapState.ThreadFile.Clear();
                DapState.ThreadLine.Clear();
                DapState.SteppingThread = -1;
            }
            lock (DapState.VarsLock)
            {
                DapState.StoppedThreadId = -1;
            }

            Stopping = false;
            Logger.Ipc("Reconnect: reconnecting to " + PipeName);
            ConnectPipe(PipeName);
            Logger.Ipc("Reconnect: done");
        }

        public void SendCmd(uint cmd, byte[] payload)
        {
            try
            {
                SendTranCmd(cmd, payload);
            }
            catch (Exception ex)
            {
                Logger.Ipc("Send error: " + ex.Message);
            }
        }

        public void SendBp(uint cmd, string file, int line)
        {
            SendCmd(cmd, BuildBpData(file, (uint)line));
        }

        public void SendBpClrAll()
        {
            SendCmd(
                IpcClient.CMD_BP_CLR,
                new byte[]
                {
                    0xFF,
                    0xFF,
                    0xFF,
                    0xFF,
                    0x00,
                    0x00,
                    0x00,
                    0x00,
                    0x00,
                    0x00,
                    0x00,
                    0x00,
                    0x00,
                }
            );
        }

        protected override bool OnMessage(string typeName, byte[] buf, ref int off, int end)
        {
            if (!typeName.Contains("TranEncapsulationMessage"))
            {
                Logger.Ipc(string.Format("DebugClient: unknown type {0}", typeName));
                return false;
            }

            if (end - off < 6)
                return false;
            int dataOff = off + 2; // skip 2-byte pad
            int dataLen = (int)LE32(buf, dataOff);
            off += 6 + dataLen;
            if (off > end)
            {
                off -= 6 + dataLen;
                return false;
            }

            int dataStart = dataOff + 4;
            bool hasCmb =
                dataLen >= 12
                && buf[dataStart] == 'C'
                && buf[dataStart + 1] == 'M'
                && buf[dataStart + 2] == 'B'
                && buf[dataStart + 3] == 0;

            if (hasCmb)
            {
                uint cmbCmd = LE32(buf, dataStart + 8);
                int cmbPayloadOff = dataStart + 12;
                int cmbPayloadLen = dataLen - 12;
                Logger.PaIn(
                    string.Format("TranEncap cmd=0x{0:X4} payloadLen={1}", cmbCmd, cmbPayloadLen)
                );
                OnIpcEvent(cmbCmd, buf, cmbPayloadOff, cmbPayloadLen);
            }
            return true;
        }

        void OnIpcEvent(uint cmd, byte[] buf, int payloadOff, int payloadLen)
        {
            switch (cmd)
            {
                case EVT_RESUMED:
                    Logger.Ipc("RESUMED");
                    _staleClearedKeys.Clear();
                    lock (DapState.SessionLock)
                    {
                        DapState.Threads.Clear();
                        DapState.ThreadFile.Clear();
                        DapState.ThreadLine.Clear();
                    }
                    if (DapState.IsStopped)
                    {
                        DapState.IsStopped = false;
                        DapTransport.Event("continued", "{\"allThreadsContinued\":true}");
                    }
                    break;

                case EVT_STOPPED:
                    Logger.Ipc("STOPPED/DISCONNECTED. terminating session");
                    DapTransport.Event("terminated");
                    Stopping = true;
                    try
                    {
                        _pipe.Close();
                    }
                    catch { }
                    break;

                case EVT_BP_HIT:
                    if (payloadLen >= 12)
                    {
                        int tid;
                        int line;
                        string file;
                        ParseLocationPayload(
                            buf,
                            payloadOff,
                            payloadLen,
                            out tid,
                            out line,
                            out file
                        );

                        Logger.Ipc("BP_HIT thread=" + tid + " line=" + line + " file=" + file);
                        DapState.SetThreadLocation(tid, file, line);
                        IpcClient.LastBpHit = new IpcClient.BpHitInfo
                        {
                            ThreadId = tid,
                            File = file,
                            Line = line,
                        };

                        if (!IsBpActive(file, line))
                        {
                            string staleKey = NormalizePath(file) + ":" + line;
                            if (_staleClearedKeys.Add(staleKey))
                                Logger.Ipc("BP_HIT stale. silently continuing");
                            else
                                Logger.Ipc("BP_HIT stale (flood). CONTINUE_ALL only");
                            SendCmd(
                                IpcClient.CMD_CONTINUE_ALL,
                                BitConverter.GetBytes(unchecked((uint)-1))
                            );
                            break;
                        }

                        PrefetchVars(tid, file, line);

                        string condition = GetBpCondition(file, line);
                        if (condition != null)
                        {
                            int captTid = tid;
                            string captFile = file;
                            int captLine = line;
                            ThreadPool.QueueUserWorkItem(_ =>
                                EvalAndFireOrSkip(captTid, captFile, captLine, condition)
                            );
                        }
                        else
                        {
                            FireBreakpointStopped(tid, file, line);
                        }
                    }
                    break;

                case EVT_SOURCE_LOC:
                    if (payloadLen >= 12)
                    {
                        int tid;
                        int line;
                        string file;
                        ParseLocationPayload(
                            buf,
                            payloadOff,
                            payloadLen,
                            out tid,
                            out line,
                            out file
                        );

                        Logger.Ipc("SOURCE_LOC thread=" + tid + " line=" + line + " file=" + file);
                        DapState.SetThreadLocation(tid, file, line);

                        if (tid == DapState.SteppingThread)
                        {
                            DapState.SteppingThread = -1;
                            DapState.IsStopped = true;
                            PrefetchVars(tid, file, line);
                            DapTransport.Event(
                                "stopped",
                                "{\"reason\":\"step\",\"threadId\":"
                                    + tid
                                    + ",\"allThreadsStopped\":false}"
                            );
                        }
                    }
                    break;

                case EVT_STEP_WATCH:
                    if (payloadLen > 4)
                    {
                        string text = Encoding.ASCII.GetString(buf, payloadOff + 4, payloadLen - 4);
                        Logger.Ipc("STEP_WATCH: " + text.Replace("\r", "").Replace("\n", "  |  "));
                        lock (DapState.VarsLock)
                        {
                            DapState.StepWatchVars.Clear();
                            ParseKeyValueLines(text, DapState.StepWatchVars, skipCallStack: false);
                            DapState.StepWatchPending = false;
                        }
                        DapState.StepWatchReady.Set();
                    }
                    else
                    {
                        lock (DapState.VarsLock)
                        {
                            DapState.StepWatchPending = false;
                        }
                        DapState.StepWatchReady.Set();
                    }
                    break;

                case EVT_LOCALS_LIVE:
                    Logger.Ipc(
                        string.Format("EVT_LOCALS_LIVE (0x100A) payloadLen={0}", payloadLen)
                    );
                    if (payloadLen > 4)
                    {
                        try
                        {
                            int textLen = payloadLen - 4;
                            for (int ni = 0; ni < textLen; ni++)
                                if (buf[payloadOff + 4 + ni] == 0)
                                {
                                    textLen = ni;
                                    break;
                                }
                            string text = Encoding.ASCII.GetString(buf, payloadOff + 4, textLen);
                            Logger.Ipc("  locals text: " + text.Replace("\r\n", " | "));

                            string sourceFile;
                            int stoppedLine;
                            lock (DapState.VarsLock)
                            {
                                sourceFile = DapState.StoppedFile;
                                stoppedLine = DapState.StoppedLine;
                            }

                            string innermostCall = null;
                            foreach (
                                string ln in text.Split(
                                    new[] { '\r', '\n' },
                                    StringSplitOptions.RemoveEmptyEntries
                                )
                            )
                            {
                                string t = ln.TrimEnd();
                                if (t.EndsWith(";") && t.Contains("("))
                                    innermostCall = t;
                                else
                                    break;
                            }

                            lock (DapState.VarsLock)
                            {
                                DapState.LocalVars.Clear();
                                if (innermostCall != null)
                                {
                                    List<string> paramNames = GetFunctionParams(
                                        sourceFile,
                                        stoppedLine
                                    );
                                    List<string> paramVals = SplitCallArgs(innermostCall);
                                    for (
                                        int pi = 0;
                                        pi < paramNames.Count && pi < paramVals.Count;
                                        pi++
                                    )
                                        DapState.LocalVars[paramNames[pi]] = StripQuality(
                                            paramVals[pi]
                                        );
                                    Logger.Ipc(
                                        "  params parsed: "
                                            + paramNames.Count
                                            + " names, "
                                            + paramVals.Count
                                            + " values"
                                    );
                                }
                                ParseKeyValueLines(text, DapState.LocalVars, skipCallStack: true);
                                DapState.LocalVarsPending = false;
                            }
                            DapState.LocalsReady.Set();
                            Logger.Ipc("  total vars: " + DapState.LocalVars.Count);
                        }
                        catch (Exception ex)
                        {
                            Logger.Ipc("  parse error: " + ex.Message);
                            lock (DapState.VarsLock)
                            {
                                DapState.LocalVarsPending = false;
                            }
                            DapState.LocalsReady.Set();
                        }
                    }
                    else
                    {
                        lock (DapState.VarsLock)
                        {
                            DapState.LocalVarsPending = false;
                        }
                        DapState.LocalsReady.Set();
                    }
                    break;

                case EVT_TEXT_OUTPUT:
                    if (payloadLen >= 12)
                    {
                        uint f0 = LE32(buf, payloadOff),
                            f1 = LE32(buf, payloadOff + 4),
                            f2 = LE32(buf, payloadOff + 8);
                        int fnEnd100c = payloadOff + 12;
                        while (fnEnd100c < payloadOff + payloadLen && buf[fnEnd100c] != 0)
                            fnEnd100c++;
                        string fn100c = Encoding.ASCII.GetString(
                            buf,
                            payloadOff + 12,
                            fnEnd100c - (payloadOff + 12)
                        );
                        Logger.Ipc(
                            string.Format(
                                "EVT_0x100C: f0=0x{0:X8} f1=0x{1:X8} f2={2} file={3}",
                                f0,
                                f1,
                                f2,
                                fn100c
                            )
                        );
                        if (IpcClient.Evt100CHook != null)
                        {
                            var p = new byte[payloadLen];
                            Array.Copy(buf, payloadOff, p, 0, payloadLen);
                            IpcClient.Evt100CHook(p);
                        }
                    }
                    break;

                case EVT_WATCH_EVAL_RESP:
                    Logger.Ipc(
                        string.Format("EVT_WATCH_EVAL_RESP (0x100F) payloadLen={0}", payloadLen)
                    );
                    if (IpcClient.WatchRespHook != null && payloadLen > 0)
                    {
                        var payload = new byte[payloadLen];
                        Array.Copy(buf, payloadOff, payload, 0, payloadLen);
                        IpcClient.WatchRespHook(payload);
                    }
                    break;
            }
        }

        internal void SendTranCmd(uint cmdType, byte[] cmdPayload)
        {
            int plen = cmdPayload != null ? cmdPayload.Length : 0;
            int dataLen = 4 + 4 + 4 + plen;

            var data = new byte[dataLen];
            data[0] = (byte)'C';
            data[1] = (byte)'M';
            data[2] = (byte)'B';
            data[3] = 0;
            data[4] = (byte)dataLen;
            data[5] = (byte)(dataLen >> 8);
            data[6] = (byte)(dataLen >> 16);
            data[7] = (byte)(dataLen >> 24);
            data[8] = (byte)cmdType;
            data[9] = (byte)(cmdType >> 8);
            data[10] = (byte)(cmdType >> 16);
            data[11] = (byte)(cmdType >> 24);
            if (cmdPayload != null)
                Array.Copy(cmdPayload, 0, data, 12, plen);

            int bodyLen = 2 + 4 + dataLen;
            var body = new byte[bodyLen];
            body[2] = (byte)dataLen;
            body[3] = (byte)(dataLen >> 8);
            body[4] = (byte)(dataLen >> 16);
            body[5] = (byte)(dataLen >> 24);
            Array.Copy(data, 0, body, 6, dataLen);

            lock (SendLock)
            {
                uint seqId = NextSeqId();
                Logger.PaOut(
                    string.Format("TranCmd 0x{0:X4} dataLen={1} seqId={2}", cmdType, dataLen, seqId)
                );
                SendFrameLocked(
                    seqId,
                    BuildMsgPayload(
                        ScadaVersion.HashTran,
                        ScadaVersion.TnTran,
                        ref _sentTranType,
                        body
                    )
                );
            }
        }

        static byte[] BuildBpData(string file, uint line)
        {
            file = file.Replace('/', '\\');
            byte[] fileBytes = Encoding.ASCII.GetBytes(file + "\0");
            var buf = new byte[4 + 4 + 4 + fileBytes.Length];
            WriteLE32(buf, 0, 0xFFFFFFFF);
            WriteLE32(buf, 4, 0);
            WriteLE32(buf, 8, line);
            fileBytes.CopyTo(buf, 12);
            return buf;
        }

        void PrefetchVars(int tid, string file, int line)
        {
            lock (DapState.VarsLock)
            {
                DapState.StoppedThreadId = tid;
                DapState.StoppedFile = file;
                DapState.StoppedLine = line;
                DapState.StepWatchVars.Clear();
                DapState.LocalVars.Clear();
                DapState.StepWatchPending = true;
                DapState.LocalVarsPending = true;
                DapState.StepWatchReady.Reset();
                DapState.LocalsReady.Reset();
            }
            SendCmd(IpcClient.CMD_GET_STEP_WATCH, BitConverter.GetBytes((uint)tid));
            SendCmd(IpcClient.CMD_GET_LOCALS_LIVE, BitConverter.GetBytes((uint)tid));
        }

        string[] GetSourceLines(string path)
        {
            string[] lines;
            if (!_sourceCache.TryGetValue(path, out lines))
            {
                lines = File.ReadAllLines(path);
                _sourceCache[path] = lines;
            }
            return lines;
        }

        List<string> GetFunctionParams(string sourceFile, int stoppedLine)
        {
            var result = new List<string>();
            if (sourceFile == null || !File.Exists(sourceFile))
                return result;
            try
            {
                string[] lines = GetSourceLines(sourceFile);
                int startIdx = Math.Min(stoppedLine - 1, lines.Length - 1);
                for (int i = startIdx; i >= 0; i--)
                {
                    string trimmed = lines[i].Trim();
                    if (!trimmed.StartsWith("FUNCTION", StringComparison.OrdinalIgnoreCase))
                        continue;
                    var sb = new StringBuilder(trimmed);
                    int j = i + 1;
                    while (!sb.ToString().Contains(")") && j < lines.Length)
                        sb.Append(" ").Append(lines[j++].Trim());
                    string decl = sb.ToString();
                    int parenOpen = decl.IndexOf('(');
                    int parenClose = decl.LastIndexOf(')');
                    if (parenOpen < 0 || parenClose <= parenOpen)
                        return result;
                    string paramStr = decl.Substring(parenOpen + 1, parenClose - parenOpen - 1)
                        .Trim();
                    if (paramStr.Length == 0)
                        return result;
                    foreach (string token in SplitCallArgs(paramStr))
                    {
                        string p = token.Trim();
                        int eq = p.IndexOf('=');
                        if (eq >= 0)
                            p = p.Substring(0, eq).Trim();
                        string[] parts = p.Split(
                            new char[] { ' ', '\t' },
                            StringSplitOptions.RemoveEmptyEntries
                        );
                        if (parts.Length > 0)
                            result.Add(parts[parts.Length - 1]);
                    }
                    return result;
                }
            }
            catch (Exception ex)
            {
                Logger.Ipc("GetFunctionParams error: " + ex.Message);
            }
            return result;
        }

        static List<string> SplitCallArgs(string callText)
        {
            var result = new List<string>();
            int parenOpen = callText.IndexOf('(');
            int parenClose = callText.LastIndexOf(')');
            string inner =
                (parenOpen >= 0 && parenClose > parenOpen)
                    ? callText.Substring(parenOpen + 1, parenClose - parenOpen - 1)
                    : callText;
            var sb = new StringBuilder();
            bool inStr = false;
            int bDepth = 0;
            foreach (char c in inner)
            {
                if (c == '"')
                {
                    inStr = !inStr;
                    sb.Append(c);
                }
                else if (!inStr && c == '{')
                {
                    bDepth++;
                    sb.Append(c);
                }
                else if (!inStr && c == '}')
                {
                    bDepth--;
                    sb.Append(c);
                }
                else if (!inStr && bDepth == 0 && c == ',')
                {
                    result.Add(sb.ToString().Trim());
                    sb.Clear();
                }
                else
                    sb.Append(c);
            }
            if (sb.Length > 0)
                result.Add(sb.ToString().Trim());
            return result;
        }

        static string StripQuality(string value)
        {
            if (!DapState.StripQualityTags || value == null)
                return value;
            int brace = value.LastIndexOf(" {");
            if (brace >= 0 && value.EndsWith("}"))
                return value.Substring(0, brace);
            return value;
        }

        static void ParseKeyValueLines(
            string text,
            Dictionary<string, string> target,
            bool skipCallStack
        )
        {
            foreach (
                string ln in text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
            )
            {
                if (skipCallStack && ln.TrimEnd().EndsWith(";"))
                    continue;
                int eq = ln.IndexOf('=');
                if (eq <= 0)
                    continue;
                string name = ln.Substring(0, eq).Trim();
                string val = StripQuality(ln.Substring(eq + 1).Trim());
                if (name.Length > 0)
                    target[name] = val;
            }
        }

        static string NormalizePath(string file)
        {
            return file.Replace('/', '\\').ToLowerInvariant();
        }

        static bool IsBpActive(string file, int line)
        {
            string key = NormalizePath(file);
            lock (DapState.SessionLock)
            {
                List<int> lines;
                if (!DapState.PendingBps.TryGetValue(key, out lines))
                {
                    Logger.Ipc(
                        string.Format(
                            "IsBpActive MISS key='{0}' bps_count={1}",
                            key,
                            DapState.PendingBps.Count
                        )
                    );
                    return false;
                }
                bool found = lines.Contains(line);
                if (!found)
                    Logger.Ipc(
                        string.Format(
                            "IsBpActive LINE_MISS key='{0}' line={1} lines=[{2}]",
                            key,
                            line,
                            string.Join(",", lines)
                        )
                    );
                return found;
            }
        }

        static string GetBpCondition(string file, int line)
        {
            string key = NormalizePath(file);
            lock (DapState.SessionLock)
            {
                Dictionary<int, string> fileConds;
                if (!DapState.BpConditions.TryGetValue(key, out fileConds))
                    return null;
                string cond;
                fileConds.TryGetValue(line, out cond);
                return (cond != null && cond.Trim().Length > 0) ? cond : null;
            }
        }

        void EvalAndFireOrSkip(int tid, string file, int line, string condition)
        {
            DapState.LocalsReady.Wait(800);
            bool condMet;
            lock (DapState.VarsLock)
            {
                condMet = EvaluateCondition(condition, DapState.LocalVars);
            }
            Logger.Ipc(
                "Conditional BP "
                    + (condMet ? "TRIGGERED" : "skipped")
                    + ": ["
                    + condition
                    + "] thread="
                    + tid
            );
            if (condMet)
            {
                FireBreakpointStopped(tid, file, line);
            }
            else
            {
                SendCmd(IpcClient.CMD_CONTINUE_ALL, BitConverter.GetBytes(unchecked((uint)-1)));
            }
        }

        static void FireBreakpointStopped(int tid, string file, int line)
        {
            DapState.IsStopped = true;
            DapTransport.Event(
                "stopped",
                "{\"reason\":\"breakpoint\",\"threadId\":"
                    + tid
                    + ",\"allThreadsStopped\":false,\"description\":\"Breakpoint at "
                    + Path.GetFileName(file)
                    + ":"
                    + line
                    + "\"}"
            );
        }

        static void ParseLocationPayload(
            byte[] buf,
            int payloadOff,
            int payloadLen,
            out int tid,
            out int line,
            out string file
        )
        {
            tid = (int)LE32(buf, payloadOff);
            line = (int)LE32(buf, payloadOff + 8);
            int fnEnd = payloadOff + 12;
            while (fnEnd < payloadOff + payloadLen && buf[fnEnd] != 0)
                fnEnd++;
            file = Encoding.ASCII.GetString(buf, payloadOff + 12, fnEnd - (payloadOff + 12));
        }

        public static string ValidateCondition(string condition)
        {
            if (string.IsNullOrWhiteSpace(condition))
                return "Empty condition.";
            condition = condition.Trim();
            string[] ops = { ">=", "<=", "<>", "!=", "==", "=", ">", "<" };
            foreach (string op in ops)
            {
                int idx = condition.IndexOf(op);
                if (idx < 0)
                    continue;
                string varName = condition.Substring(0, idx).Trim();
                string expected = condition.Substring(idx + op.Length).Trim();
                if (varName.Length == 0)
                    return "Missing variable name before '" + op + "'.";
                if (expected.Length == 0)
                    return "Missing value after '" + op + "'.";
                foreach (char c in varName)
                    if (!char.IsLetterOrDigit(c) && c != '_')
                        return "Invalid variable name: '" + varName + "'.";
                if (op == ">" || op == ">=" || op == "<" || op == "<=")
                {
                    double d;
                    if (
                        !double.TryParse(
                            expected,
                            System.Globalization.NumberStyles.Any,
                            System.Globalization.CultureInfo.InvariantCulture,
                            out d
                        )
                    )
                        return "Operator '" + op + "' requires a numeric value.";
                }
                return null;
            }
            foreach (char c in condition)
                if (!char.IsLetterOrDigit(c) && c != '_')
                    return "Invalid expression. Supported forms: varName, varName == value, etc.";
            return null;
        }

        static bool EvaluateCondition(string condition, Dictionary<string, string> vars)
        {
            condition = condition.Trim();
            string[] ops =
            {
                "notcontains",
                "contains",
                ">=",
                "<=",
                "<>",
                "!=",
                "==",
                "=",
                ">",
                "<",
            };
            foreach (string op in ops)
            {
                int idx = condition.IndexOf(op);
                if (idx < 0)
                    continue;
                string varName = condition.Substring(0, idx).Trim();
                string expected = condition.Substring(idx + op.Length).Trim();
                if (
                    expected.Length >= 2
                    && (
                        (expected[0] == '"' && expected[expected.Length - 1] == '"')
                        || (expected[0] == '\'' && expected[expected.Length - 1] == '\'')
                    )
                )
                    expected = expected.Substring(1, expected.Length - 2);
                string varValue;
                if (!vars.TryGetValue(varName, out varValue))
                {
                    Logger.Ipc("Condition: var '" + varName + "' not found in locals");
                    return false;
                }
                varValue = StripQuality(varValue).Trim();
                if (
                    varValue.Length >= 2
                    && (
                        (varValue[0] == '"' && varValue[varValue.Length - 1] == '"')
                        || (varValue[0] == '\'' && varValue[varValue.Length - 1] == '\'')
                    )
                )
                    varValue = varValue.Substring(1, varValue.Length - 2);
                double lhs,
                    rhs;
                if (double.TryParse(varValue, out lhs) && double.TryParse(expected, out rhs))
                {
                    switch (op)
                    {
                        case "==":
                            return lhs == rhs;
                        case "!=":
                            return lhs != rhs;
                        case ">":
                            return lhs > rhs;
                        case ">=":
                            return lhs >= rhs;
                        case "<":
                            return lhs < rhs;
                        case "<=":
                            return lhs <= rhs;
                    }
                }
                switch (op)
                {
                    case "==":
                    case "=":
                        return string.Equals(
                            varValue,
                            expected,
                            StringComparison.OrdinalIgnoreCase
                        );
                    case "<>":
                    case "!=":
                        return !string.Equals(
                            varValue,
                            expected,
                            StringComparison.OrdinalIgnoreCase
                        );
                    case "contains":
                        return varValue.IndexOf(expected, StringComparison.OrdinalIgnoreCase) >= 0;
                    case "notcontains":
                        return varValue.IndexOf(expected, StringComparison.OrdinalIgnoreCase) < 0;
                }
                return false;
            }
            string val;
            if (!vars.TryGetValue(condition, out val))
            {
                Logger.Ipc("Condition: var '" + condition + "' not found in locals");
                return false;
            }
            val = StripQuality(val).Trim();
            double dv;
            return double.TryParse(val, out dv) ? dv != 0.0 : val.Length > 0;
        }
    }
}
