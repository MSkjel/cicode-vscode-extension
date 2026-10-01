using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
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
        // CMB command opcodes (IDE -> runtime), see PROTOCOL.md
        public const uint CMD_SESSION_START = 0x1020;
        public const uint CMD_SESSION_STOP = 0x1021;
        public const uint CMD_BP_SET = 0x1023;
        public const uint CMD_RESUME_THREAD = 0x1024; // resume ONE paused thread
        public const uint CMD_THREAD_INFO = 0x1028; // -> 0x1008, empty text = no such thread
        public const uint CMD_GET_STEP_WATCH = 0x1029;
        public const uint CMD_GET_LOCALS_LIVE = 0x102A;
        public const uint CMD_BP_CLR = 0x102C; // clears ONE bp by its runtime id (-1 = all)
        public const uint CMD_SET_OPTION = 0x102D;
        public const uint CMD_CONTINUE_ALL = 0x102E;
        public const uint CMD_BREAK = 0x102F; // break at the next statement any task runs
        public const uint CMD_STEP_INTO = 0x1030;
        public const uint CMD_STEP_OVER = 0x1031;
        public const uint CMD_STEP_OUT = 0x1032;

        static readonly DebugClient _inst = new DebugClient();

        public static bool Stopping
        {
            get { return _inst.Stopping; }
        }
        public static string PipeName
        {
            get { return _inst.PipeName; }
        }

        public static void Connect(string pipeName)
        {
            _inst.Connect(pipeName);
        }

        public static void Disconnect()
        {
            _inst.Disconnect();
        }

        public static void SendCmd(uint cmd, byte[] payload)
        {
            _inst.SendCmd(cmd, payload);
        }

        public static void SendThreadCmd(uint cmd, int tid)
        {
            _inst.SendCmd(cmd, BitConverter.GetBytes(tid));
        }

        /// <summary>Make the runtime's breakpoints for one file match `lines` (adds and removes).</summary>
        public static void SyncFileBreakpoints(string path, IList<int> lines)
        {
            _inst.SyncFileBreakpoints(path, lines);
        }

        /// <summary>Wait until the runtime acknowledged the given breakpoints; returns the acked lines.</summary>
        public static HashSet<int> WaitForBpAcks(string path, IList<int> lines, int timeoutMs)
        {
            return _inst.WaitForBpAcks(path, lines, timeoutMs);
        }

        public static void Step(int tid, uint stepCmd)
        {
            _inst.Step(tid, stepCmd);
        }

        public static void ContinueAll()
        {
            _inst.ContinueAll();
        }

        public static void Pause()
        {
            _inst.Pause();
        }

        public static string ValidateCondition(string cond)
        {
            return DebugClient.ValidateCondition(cond);
        }
    }

    class DebugClient : PaClient
    {
        // CMB event opcodes (runtime -> IDE)
        const uint EVT_SESSION_STARTED = 0x1000; // answer to SESSION_START (not "resumed")
        const uint EVT_SESSION_ENDED = 0x1001;
        const uint EVT_PAUSED_AT = 0x1002; // thread paused at file:line (step/break/error)
        const uint EVT_BP_HIT = 0x1003;
        const uint EVT_THREAD_STARTED = 0x1004; // header only; tasks traced with CodeTrace mode 16
        const uint EVT_THREAD_ENDED = 0x1005; // header only; tasks traced with CodeTrace mode 16
        const uint EVT_THREAD_INFO = 0x1008; // answer to THREAD_INFO
        const uint EVT_STEP_WATCH = 0x1009;
        const uint EVT_LOCALS_LIVE = 0x100A;
        const uint EVT_MESSAGE = 0x100B; // free text, tid -1 (hardware-error announce, notices)
        const uint EVT_BP_ACK = 0x100C; // tid(-1) + bpId + line + path
        const uint EVT_HW_ERROR = 0x100E; // tid + (unused) + code + text; also rejections and notices
        const uint EVT_WATCH_RESULT = 0x100F;

        // 0x100E codes that are not hardware errors
        const int CODE_THREAD_REJECTED = 0; // "Thread N has terminated|is a foreground thread. Cannot ..."
        const int CODE_FOREGROUND_BREAK = 343; // "Foreground Cicode cannot break" (once per session)

        const int SESSION_START_TIMEOUT_MS = 5000;
        const int ERROR_PAUSE_TIMEOUT_MS = 1000; // wait for the post-error pause location
        const int STEP_CHECK_FIRST_MS = 500; // first "did the stepping thread end?" probe

        public string PipeName;

        bool _sentTranType;

        // Session handshake: set by SESSION_STARTED/SESSION_ENDED while Connect() waits.
        readonly ManualResetEventSlim _sessionStarted = new ManualResetEventSlim(false);
        volatile bool _sessionRefused;
        volatile string _lastMessage; // last 0x100B text

        // Runtime breakpoints. The runtime identifies a breakpoint only by the id it returns
        // in BP_ACK, and CLR takes that id, so every set BP is tracked until it is cleared.
        // Ids are a 16-bit counter that is never reset while the runtime runs; -1 means the
        // runtime could not create the breakpoint (and as a CLR argument, "clear all").
        class RtBp
        {
            public string Path;
            public int Line;
            public int Id;
            public bool Acked; // Id is valid
            public bool Failed; // the runtime answered -1
            public bool Wanted = true; // false = clear as soon as the id is known
        }

        readonly object _bpLock = new object();
        readonly Dictionary<string, List<RtBp>> _rtBps = new Dictionary<string, List<RtBp>>(); // key -> set order

        // Hardware-error state per thread: announce (0x100B) -> location at the error line
        // (0x1002, thread still running) -> detail (0x100E) -> pause at the next statement (0x1002).
        enum ErrPhase
        {
            Announced,
            Located,
        }

        class PendingError
        {
            public ErrPhase Phase;
            public string Text;
            public int Code;
            public string Message;
            public string ErrPage;
            public string ErrDesc;
            public string Detail;
            public string File;
            public int Line;
            public Timer Timeout;
        }

        static readonly Regex HwErrorRx = new Regex(
            @"^Thread\s+(\d+)\s+Hardware error\s+\((-?\d+)\)\s+'(.*?)'\s+ErrPage:\s+'(.*?)'\s+ErrDesc:\s+'(.*?)'\s*$",
            RegexOptions.Singleline
        );
        static readonly Regex ThreadRejectRx = new Regex(
            @"^Thread\s+(\d+)\s+(has terminated|is a foreground thread)",
            RegexOptions.IgnoreCase
        );

        readonly object _ctlLock = new object(); // guards _errors, _pauseRequested, step probes
        readonly Dictionary<int, PendingError> _errors = new Dictionary<int, PendingError>();
        bool _pauseRequested;
        DateTime _debugBreakAnnounced = DateTime.MinValue; // "DebugBreak() called." seen
        int _debugBreakTid = -1; // task whose DebugBreak() location was reported (still running)
        Timer _stepProbe;
        int _stepProbeTid = -1;
        int _stepProbeDelayMs;
        bool _stepProbeAwaitingStack; // probe asked for the stack of a thread that still exists
        int _stepProbeReleases; // parked-thread resumes sent for the current step (capped)

        class CachedSource
        {
            public DateTime LastWriteUtc;
            public string[] Lines;
        }

        readonly Dictionary<string, CachedSource> _sourceCache = new Dictionary<
            string,
            CachedSource
        >(StringComparer.OrdinalIgnoreCase);

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

        protected override void OnDisconnected()
        {
            Logger.Reader("DebugClient: exited");
            if (!Stopping)
            {
                DapTransport.Output(
                    "console",
                    "Lost the connection to the Cicode debugger in the runtime.\n"
                );
                DapTransport.Event("terminated");
            }
            base.OnDisconnected();
        }

        protected override void OnResetState()
        {
            _sentTranType = false;
            _sessionStarted.Reset();
            _sessionRefused = false;
            _lastMessage = null;
            lock (_bpLock)
                _rtBps.Clear(); // a new session starts with no runtime breakpoints
            lock (_ctlLock)
            {
                foreach (var e in _errors.Values)
                    if (e.Timeout != null)
                        e.Timeout.Dispose();
                _errors.Clear();
                _pauseRequested = false;
                _debugBreakAnnounced = DateTime.MinValue;
                _debugBreakTid = -1;
                StopStepProbe();
            }
        }

        public void Connect(string pipeName)
        {
            PipeName = pipeName;
            Logger.Ipc("Connecting to \\\\.\\pipe\\" + pipeName + " ...");
            ConnectPipe(pipeName);

            // SESSION_START, then wait for SESSION_STARTED before sending anything else. The
            // runtime ignores every other command outside a session, and answers nothing at all
            // if another debugger already owns the session.
            SendTranCmd(IpcClient.CMD_SESSION_START, new byte[4]);
            if (!_sessionStarted.Wait(SESSION_START_TIMEOUT_MS) || _sessionRefused)
            {
                string why = _sessionRefused
                    ? "The runtime refused the debug session"
                        + (_lastMessage != null ? " (" + _lastMessage.Trim() + ")" : "")
                        + ". Is the project compiled with debug information?"
                    : "The runtime did not answer the debug session request. Another debugger "
                        + "(the Cicode Editor or another VS Code window) may already be attached, or "
                        + "the running project has no Cicode debug information.";
                Stopping = true;
                try
                {
                    _pipe.Close();
                }
                catch { }
                throw new Exception(why);
            }

            // BreakOnError stays on for the whole session; whether a hardware error stops in
            // VS Code or is only logged is decided here (see the exception filter).
            SetOption("BreakOnError", "1");
            SetOption("BreakAllThreads", "0");
            SetOption("ForBreakWarning", "1");

            ReportServerProcess();
        }

        public void Disconnect()
        {
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
            CtApiClient.Close();
        }

        public void SendCmd(uint cmd, byte[] payload)
        {
            try
            {
                SendTranCmd(cmd, payload);
            }
            catch (Exception ex)
            {
                Logger.Warn("Send 0x" + cmd.ToString("X4") + " failed: " + ex.Message);
            }
        }

        void SetOption(string name, string value)
        {
            // cmdPayload: tid(4)=0 + name char[32] + value\0
            var buf = new byte[4 + 32 + value.Length + 1];
            Encoding.ASCII.GetBytes(name, 0, Math.Min(name.Length, 31), buf, 4);
            Encoding.ASCII.GetBytes(value, 0, value.Length, buf, 36);
            SendCmd(IpcClient.CMD_SET_OPTION, buf);
        }

        // ------------------------------------------------------------------ breakpoints

        static string BpKey(string path, int line)
        {
            return NormalizePath(path) + ":" + line;
        }

        public void SyncFileBreakpoints(string path, IList<int> lines)
        {
            string norm = NormalizePath(path);
            var wanted = new HashSet<int>(lines);
            var toSet = new List<int>();
            var toClear = new List<int>();
            lock (_bpLock)
            {
                // Remove lines no longer wanted.
                foreach (var kv in _rtBps)
                {
                    if (!kv.Key.StartsWith(norm + ":", StringComparison.Ordinal))
                        continue;
                    foreach (var bp in kv.Value)
                    {
                        if (!bp.Wanted || wanted.Contains(bp.Line))
                            continue;
                        bp.Wanted = false;
                        if (bp.Acked)
                            toClear.Add(bp.Id);
                    }
                }
                // Add lines that have no live runtime breakpoint yet.
                foreach (int line in wanted)
                {
                    List<RtBp> list;
                    string key = BpKey(path, line);
                    if (_rtBps.TryGetValue(key, out list) && list.Exists(b => b.Wanted && !b.Failed))
                        continue;
                    if (list == null)
                        _rtBps[key] = list = new List<RtBp>();
                    list.Add(new RtBp { Path = path, Line = line });
                    toSet.Add(line);
                }
                PruneClearedLocked();
            }
            foreach (int id in toClear)
                SendBpClear(id);
            foreach (int line in toSet)
                SendCmd(IpcClient.CMD_BP_SET, BuildBpData(path, (uint)line));
        }

        void PruneClearedLocked()
        {
            var empty = new List<string>();
            foreach (var kv in _rtBps)
            {
                kv.Value.RemoveAll(b => b.Failed || (!b.Wanted && b.Acked));
                if (kv.Value.Count == 0)
                    empty.Add(kv.Key);
            }
            foreach (string k in empty)
                _rtBps.Remove(k);
        }

        /// <summary>Wait until the runtime answered the given breakpoints; returns the acknowledged lines.</summary>
        public HashSet<int> WaitForBpAcks(string path, IList<int> lines, int timeoutMs)
        {
            var acked = new HashSet<int>();
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            lock (_bpLock)
            {
                while (true)
                {
                    acked.Clear();
                    int pending = 0;
                    foreach (int line in lines)
                    {
                        List<RtBp> list;
                        if (!_rtBps.TryGetValue(BpKey(path, line), out list))
                            continue; // answered with -1 and pruned
                        if (list.Exists(b => b.Wanted && b.Acked))
                            acked.Add(line);
                        else if (list.Exists(b => b.Wanted && !b.Failed))
                            pending++;
                    }
                    int left = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                    if (pending == 0 || left <= 0 || Stopping)
                        return acked;
                    Monitor.Wait(_bpLock, left);
                }
            }
        }

        void OnBpAck(int id, int line, string file)
        {
            // The id is a signed 16-bit counter; -1 means the breakpoint was not created.
            id = (short)id;
            bool clear = false;
            lock (_bpLock)
            {
                List<RtBp> list;
                RtBp bp = null;
                if (_rtBps.TryGetValue(BpKey(file, line), out list))
                    bp = list.Find(b => !b.Acked && !b.Failed);
                if (id == -1)
                {
                    if (bp != null)
                        bp.Failed = true;
                    Logger.Warn("The runtime could not create the breakpoint at " + file + ":" + line);
                }
                else if (bp == null)
                {
                    // Not ours (or already superseded): make sure it cannot fire.
                    clear = true;
                }
                else
                {
                    bp.Id = id;
                    bp.Acked = true;
                    clear = !bp.Wanted;
                }
                PruneClearedLocked();
                Monitor.PulseAll(_bpLock);
            }
            Logger.Ipc("BP_ACK id=" + id + " line=" + line + " file=" + file + (clear ? " (clearing)" : ""));
            if (clear)
                SendBpClear(id);
        }

        void SendBpClear(int id)
        {
            // cmdPayload: tid(-1) + bpId (low 16 bits; -1 would clear every breakpoint) + line(0) + empty path
            if ((short)id == -1)
                return;
            var buf = new byte[13];
            WriteLE32(buf, 0, 0xFFFFFFFF);
            WriteLE32(buf, 4, (uint)(ushort)id);
            SendCmd(IpcClient.CMD_BP_CLR, buf);
        }

        // ------------------------------------------------------------------ execution control

        public void ContinueAll()
        {
            lock (_ctlLock)
            {
                _pauseRequested = false;
                StopStepProbe();
            }
            DapState.SteppingThread = -1;
            DapState.ClearPaused();
            // The runtime ignores the thread argument of CONTINUE_ALL.
            SendCmd(IpcClient.CMD_CONTINUE_ALL, new byte[4]);
        }

        public void Step(int tid, uint stepCmd)
        {
            // A step resumes every other suspended task too (the runtime clears their break
            // flags), so they are no longer paused either.
            bool othersPaused;
            lock (DapState.SessionLock)
                othersPaused = DapState.PausedThreads.Count > (DapState.PausedThreads.Contains(tid) ? 1 : 0);
            DapState.SteppingThread = tid;
            DapState.ClearPaused();
            SendCmd(stepCmd, BitConverter.GetBytes(tid));
            if (othersPaused)
                DapTransport.Event("continued", "{\"threadId\":" + tid + ",\"allThreadsContinued\":true}");
            // Stepping past the last statement of a task sends no event at all (the runtime parks
            // the thread instead of ending it). Probe with THREAD_INFO until it stops or is gone.
            lock (_ctlLock)
            {
                _stepProbeReleases = 0;
                StartStepProbe(tid, STEP_CHECK_FIRST_MS);
            }
        }

        public void Pause()
        {
            lock (_ctlLock)
                _pauseRequested = true;
            SendCmd(IpcClient.CMD_BREAK, new byte[4]);
        }

        void ResumeThread(int tid)
        {
            DapState.MarkRunning(tid);
            SendCmd(IpcClient.CMD_RESUME_THREAD, BitConverter.GetBytes(tid));
        }

        void StartStepProbe(int tid, int delayMs)
        {
            StopStepProbe();
            _stepProbeTid = tid;
            _stepProbeDelayMs = delayMs;
            _stepProbe = new Timer(_ => ProbeSteppingThread(tid), null, delayMs, Timeout.Infinite);
        }

        void StopStepProbe()
        {
            if (_stepProbe != null)
            {
                _stepProbe.Dispose();
                _stepProbe = null;
            }
            _stepProbeTid = -1;
            _stepProbeAwaitingStack = false;
        }

        void ProbeSteppingThread(int tid)
        {
            if (Stopping || DapState.SteppingThread != tid)
                return;
            SendCmd(IpcClient.CMD_THREAD_INFO, BitConverter.GetBytes(tid));
        }

        void OnThreadInfo(int tid, string text)
        {
            lock (_ctlLock)
            {
                if (tid != _stepProbeTid || DapState.SteppingThread != tid)
                    return;
                if (text.Trim().Length > 0)
                {
                    // The thread still exists: either busy in a long statement, or parked after
                    // stepping out of its outermost function (the runtime suspends it there and
                    // never resumes it). Its stack tells which. GET_STACK is not answered if the
                    // task ends meanwhile, so keep the next THREAD_INFO probe scheduled.
                    StartStepProbe(tid, Math.Min(_stepProbeDelayMs * 2, 5000));
                    _stepProbeAwaitingStack = true;
                    SendCmd(IpcClient.CMD_GET_LOCALS_LIVE, BitConverter.GetBytes(tid));
                    return;
                }
                StopStepProbe();
            }
            // No such thread: the step ran off the end of the task.
            DapState.SteppingThread = -1;
            OnThreadGone(tid, "finished");
        }

        // Called with the stack of the thread the step probe is watching.
        void OnStepProbeStack(int tid, int frameCount)
        {
            bool parked;
            lock (_ctlLock)
            {
                if (tid != _stepProbeTid || !_stepProbeAwaitingStack || DapState.SteppingThread != tid)
                    return;
                _stepProbeAwaitingStack = false;
                parked = frameCount == 0 && _stepProbeReleases < 3;
                if (!parked)
                    return; // busy: the next probe is already scheduled
                _stepProbeReleases++;
                // Release it and confirm it is gone shortly.
                StartStepProbe(tid, 300);
            }
            if (parked)
            {
                Logger.Ipc("step probe: thread " + tid + " left its last function; resuming it");
                SendCmd(IpcClient.CMD_RESUME_THREAD, BitConverter.GetBytes(tid));
            }
        }

        void OnThreadGone(int tid, string how)
        {
            DapState.RemoveThread(tid);
            DapTransport.Output("console", "Cicode thread " + tid + " " + how + ".\n");
            DapTransport.Event("thread", "{\"reason\":\"exited\",\"threadId\":" + tid + "}");
        }

        // ------------------------------------------------------------------ inbound frames

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
            if (dataLen < 0 || dataLen > end - off - 6)
            {
                Logger.Warn("DebugClient: bad TranEncap dataLen=" + dataLen + ". dropping packet");
                return false;
            }
            off += 6 + dataLen;

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
                try
                {
                    OnIpcEvent(cmbCmd, buf, cmbPayloadOff, cmbPayloadLen);
                }
                catch (Exception ex)
                {
                    // One bad event must not end the session.
                    Logger.Warn("Event 0x" + cmbCmd.ToString("X4") + " handling failed: " + ex);
                }
            }
            return true;
        }

        void OnIpcEvent(uint cmd, byte[] buf, int payloadOff, int payloadLen)
        {
            int tid = payloadLen >= 4 ? (int)LE32(buf, payloadOff) : -1;
            switch (cmd)
            {
                case EVT_SESSION_STARTED:
                    Logger.Ipc("SESSION_STARTED");
                    _sessionStarted.Set();
                    break;

                case EVT_SESSION_ENDED:
                    Logger.Ipc("SESSION_ENDED");
                    if (!_sessionStarted.IsSet)
                    {
                        _sessionRefused = true;
                        _sessionStarted.Set(); // wake Connect()
                        break;
                    }
                    if (!Stopping)
                    {
                        Stopping = true; // OnDisconnected must not report it a second time
                        DapTransport.Output("console", "The runtime ended the debug session.\n");
                        DapTransport.Event("terminated");
                        try
                        {
                            _pipe.Close();
                        }
                        catch { }
                    }
                    break;

                case EVT_BP_HIT:
                    if (payloadLen >= 12)
                    {
                        int line;
                        string file;
                        ParseLocationPayload(buf, payloadOff, payloadLen, out tid, out line, out file);
                        OnBreakpointHit(tid, file, line);
                    }
                    break;

                case EVT_PAUSED_AT:
                    if (payloadLen >= 12)
                    {
                        int line;
                        string file;
                        ParseLocationPayload(buf, payloadOff, payloadLen, out tid, out line, out file);
                        OnPausedAt(tid, file, line);
                    }
                    break;

                case EVT_MESSAGE:
                    OnMessageText(ReadCString(buf, payloadOff + 4, payloadLen - 4));
                    break;

                case EVT_HW_ERROR:
                    // tid(4) + (unused)(4) + code(4) + text
                    if (payloadLen >= 12)
                        OnHwErrorDetail(
                            tid,
                            (int)LE32(buf, payloadOff + 8),
                            ReadCString(buf, payloadOff + 12, payloadLen - 12)
                        );
                    break;

                case EVT_THREAD_STARTED:
                    Logger.Ipc("THREAD_STARTED tid=" + tid);
                    break;

                case EVT_THREAD_ENDED:
                    Logger.Ipc("THREAD_ENDED tid=" + tid);
                    if (tid == DapState.SteppingThread)
                        DapState.SteppingThread = -1;
                    ClearStepStateFor(tid);
                    OnThreadGone(tid, "has terminated");
                    break;

                case EVT_THREAD_INFO:
                    OnThreadInfo(tid, ReadCString(buf, payloadOff + 4, payloadLen - 4));
                    break;

                case EVT_BP_ACK:
                    if (payloadLen >= 12)
                    {
                        int line;
                        string file;
                        int dummy;
                        ParseLocationPayload(buf, payloadOff, payloadLen, out dummy, out line, out file);
                        OnBpAck((int)LE32(buf, payloadOff + 4), line, file);
                    }
                    break;

                case EVT_STEP_WATCH:
                    OnStepWatch(payloadLen > 4 ? ReadCString(buf, payloadOff + 4, payloadLen - 4) : "");
                    break;

                case EVT_LOCALS_LIVE:
                    OnLocals(tid, payloadLen > 4 ? ReadCString(buf, payloadOff + 4, payloadLen - 4) : null);
                    break;

                case EVT_WATCH_RESULT:
                    Logger.Ipc(string.Format("EVT_WATCH_RESULT (0x100F) payloadLen={0}", payloadLen));
                    break;

                default:
                    Logger.Ipc(string.Format("unhandled event 0x{0:X4} tid={1} len={2}", cmd, tid, payloadLen));
                    break;
            }
        }

        void OnBreakpointHit(int tid, string file, int line)
        {
            Logger.Ipc("BP_HIT thread=" + tid + " line=" + line + " file=" + file);
            ClearStepStateFor(tid);
            if (tid == DapState.SteppingThread)
                DapState.SteppingThread = -1; // a step that lands on a breakpoint ends here

            // After a hardware error the task is suspended at the next statement; when that
            // statement has a breakpoint the pause is reported as a breakpoint hit.
            PendingError err = null;
            lock (_ctlLock)
            {
                if (_errors.TryGetValue(tid, out err) && err.Phase == ErrPhase.Located)
                {
                    _errors.Remove(tid);
                    if (err.Timeout != null)
                        err.Timeout.Dispose();
                }
                else
                    err = null;
            }
            if (err != null)
            {
                OnErrorPause(tid, err, file, line);
                return;
            }

            DapState.SetThreadLocation(tid, file, line);

            if (!IsBpActive(file, line))
            {
                // A breakpoint that is being removed fired before its CLR landed. Release only
                // this thread: CONTINUE_ALL would also release threads the user is looking at.
                Logger.Ipc("BP_HIT for a removed breakpoint. resuming thread " + tid);
                ResumeThread(tid);
                return;
            }

            PrefetchVars(tid, file, line);

            string condition = GetBpCondition(file, line);
            if (condition != null)
            {
                ThreadPool.QueueUserWorkItem(_ => EvalAndFireOrSkip(tid, file, line, condition));
                return;
            }
            FireStopped(
                tid,
                "breakpoint",
                "Breakpoint at " + Path.GetFileName(file) + ":" + line,
                null
            );
        }

        void OnPausedAt(int tid, string file, int line)
        {
            // Every 0x1002 means the thread is now suspended at file:line (end of a step,
            // a Break/pause, or the statement after a hardware error or DebugBreak()). The
            // exceptions are the locations reported while announcing a hardware error or a
            // DebugBreak(): the task is still finishing that statement.
            PendingError err = null;
            bool errorPause = false;
            bool debugBreak = false;
            lock (_ctlLock)
            {
                if (_debugBreakTid == tid)
                {
                    _debugBreakTid = -1;
                    debugBreak = true;
                }
                else if (
                    _debugBreakAnnounced > DateTime.UtcNow.AddMilliseconds(-ERROR_PAUSE_TIMEOUT_MS)
                    && !_errors.ContainsKey(tid)
                )
                {
                    _debugBreakAnnounced = DateTime.MinValue;
                    _debugBreakTid = tid;
                    Logger.Ipc("DebugBreak located thread=" + tid + " line=" + line);
                    return;
                }
                if (_errors.TryGetValue(tid, out err))
                {
                    if (err.Phase == ErrPhase.Announced)
                    {
                        err.Phase = ErrPhase.Located;
                        err.File = file;
                        err.Line = line;
                        ArmErrorTimeout(tid, err);
                        Logger.Ipc("HW_ERROR located thread=" + tid + " line=" + line);
                        return;
                    }
                    _errors.Remove(tid);
                    if (err.Timeout != null)
                        err.Timeout.Dispose();
                    errorPause = true;
                }
            }

            ClearStepStateFor(tid);
            bool wasStepping = tid == DapState.SteppingThread;
            if (wasStepping)
                DapState.SteppingThread = -1;

            if (errorPause)
            {
                OnErrorPause(tid, err, file, line);
                return;
            }

            Logger.Ipc("PAUSED_AT thread=" + tid + " line=" + line + " file=" + file);
            DapState.SetThreadLocation(tid, file, line);
            PrefetchVars(tid, file, line);

            string reason;
            string description;
            if (wasStepping)
            {
                reason = "step";
                description = null;
            }
            else
            {
                bool requested;
                lock (_ctlLock)
                {
                    requested = _pauseRequested;
                    _pauseRequested = false;
                }
                reason = "pause";
                description = debugBreak ? "DebugBreak() called"
                    : requested ? "Paused"
                    : "Paused by the runtime";
            }
            FireStopped(tid, reason, description, null);
        }

        void ClearStepStateFor(int tid)
        {
            lock (_ctlLock)
            {
                if (_stepProbeTid == tid)
                    StopStepProbe();
            }
        }

        // ------------------------------------------------------------------ hardware errors

        void OnMessageText(string text)
        {
            _lastMessage = text;
            Logger.Ipc("MESSAGE: " + text);
            if (text.Length == 0)
                return;

            Match m = HwErrorRx.Match(text);
            if (m.Success)
            {
                int tid = int.Parse(m.Groups[1].Value);
                var err = new PendingError
                {
                    Phase = ErrPhase.Announced,
                    Text = text,
                    Code = int.Parse(m.Groups[2].Value),
                    Message = m.Groups[3].Value,
                    ErrPage = m.Groups[4].Value,
                    ErrDesc = m.Groups[5].Value,
                };
                lock (_ctlLock)
                {
                    PendingError old;
                    if (_errors.TryGetValue(tid, out old) && old.Timeout != null)
                        old.Timeout.Dispose();
                    _errors[tid] = err;
                    ArmErrorTimeout(tid, err);
                }
                return;
            }

            if (text.StartsWith("DebugBreak() called", StringComparison.OrdinalIgnoreCase))
            {
                lock (_ctlLock)
                    _debugBreakAnnounced = DateTime.UtcNow;
            }

            // Other runtime notices (DebugBreak(), TraceMsg() text, ...).
            DapTransport.Output("console", "[Cicode] " + text.TrimEnd() + "\n");
        }

        void OnHwErrorDetail(int tid, int code, string detail)
        {
            Logger.Ipc("HW_ERROR_DETAIL thread=" + tid + " code=" + code + " : " + detail.Replace("\n", " | "));
            lock (_ctlLock)
            {
                PendingError err;
                if (_errors.TryGetValue(tid, out err))
                {
                    err.Code = code;
                    err.Detail = detail;
                    ArmErrorTimeout(tid, err);
                    return;
                }
            }
            if (code == CODE_THREAD_REJECTED)
                OnThreadRejected(tid, detail);
            else if (code == CODE_FOREGROUND_BREAK)
                OnForegroundBreak(tid, detail);
            else
                DapTransport.Output("stderr", "[Cicode] " + detail.Replace("\r", "").TrimEnd() + "\n");
        }

        void ArmErrorTimeout(int tid, PendingError err)
        {
            // Called with _ctlLock held. If the thread never pauses after the error (a
            // foreground task, or the error was on the task's last statement) the error is
            // only logged.
            if (err.Timeout != null)
                err.Timeout.Dispose();
            err.Timeout = new Timer(_ => OnErrorTimeout(tid, err), null, ERROR_PAUSE_TIMEOUT_MS, Timeout.Infinite);
        }

        void OnErrorTimeout(int tid, PendingError err)
        {
            lock (_ctlLock)
            {
                PendingError cur;
                if (!_errors.TryGetValue(tid, out cur) || cur != err)
                    return;
                _errors.Remove(tid);
                err.Timeout.Dispose();
            }
            LogHwError(tid, err, "the task was not suspended");
        }

        void OnErrorPause(int tid, PendingError err, string pauseFile, int pauseLine)
        {
            string errFile = err.File ?? pauseFile;
            int errLine = err.File != null ? err.Line : pauseLine;
            var info = new DapState.ErrorInfo
            {
                Code = err.Code,
                Text = err.Text,
                Message = err.Message,
                ErrPage = err.ErrPage,
                ErrDesc = err.ErrDesc,
                Detail = err.Detail,
                File = errFile,
                Line = errLine,
                PauseLine = pauseLine,
            };
            Logger.Ipc("HW_ERROR stop thread=" + tid + " error line=" + errLine + " paused at=" + pauseLine);

            if (!DapState.BreakOnHardwareErrors)
            {
                // "Log only": report and let the task carry on.
                LogHwError(tid, err, null);
                ResumeThread(tid);
                return;
            }

            LogHwError(tid, err, null);
            // Pin the frame to the failing statement; the task itself is suspended at the
            // start of the next statement (pauseLine), which is where stepping continues.
            DapState.SetThreadLocation(tid, errFile, errLine);
            DapState.SetErrorInfo(tid, info);
            PrefetchVars(tid, errFile, errLine);
            FireStopped(
                tid,
                "exception",
                "Cicode hardware error",
                err.Text ?? ("Hardware error (" + err.Code + ")")
            );
        }

        static void LogHwError(int tid, PendingError err, string note)
        {
            var sb = new StringBuilder();
            sb.Append("Cicode hardware error ").Append(err.Code);
            if (!string.IsNullOrEmpty(err.Message))
                sb.Append(" '").Append(err.Message).Append("'");
            sb.Append(" in thread ").Append(tid);
            if (!string.IsNullOrEmpty(err.ErrDesc))
                sb.Append(", ").Append(err.ErrDesc);
            if (!string.IsNullOrEmpty(err.ErrPage))
                sb.Append(" (").Append(err.ErrPage).Append(")");
            if (err.File != null)
                sb.Append(" at ").Append(err.File).Append(':').Append(err.Line);
            if (note != null)
                sb.Append(" [").Append(note).Append(']');
            DapTransport.Output("stderr", sb.Append('\n').ToString());
        }

        // "Thread N has terminated. Cannot step this thread." or "... is a foreground thread ...".
        void OnThreadRejected(int tid, string msg)
        {
            Logger.Ipc("THREAD_REJECTED tid=" + tid + ": " + msg);
            DapTransport.Output("console", "[Cicode] " + msg.TrimEnd() + "\n");
            if (tid == DapState.SteppingThread)
                DapState.SteppingThread = -1;
            ClearStepStateFor(tid);
            Match m = ThreadRejectRx.Match(msg);
            if (m.Success && m.Groups[2].Value.StartsWith("has", StringComparison.OrdinalIgnoreCase))
                OnThreadGone(tid, "has terminated");
            else
                DapState.MarkRunning(tid);
        }

        // A breakpoint hit by foreground Cicode is reported, but the task is not suspended.
        void OnForegroundBreak(int tid, string msg)
        {
            Logger.Ipc("FOREGROUND_BREAK tid=" + tid + ": " + msg);
            if (DapState.IsThreadPaused(tid))
            {
                DapState.MarkRunning(tid);
                DapTransport.Event("continued", "{\"threadId\":" + tid + ",\"allThreadsContinued\":false}");
            }
            DapTransport.Output(
                "console",
                "[Cicode] " + msg.Replace("\r", "").TrimEnd()
                    + " (foreground Cicode is never suspended; the runtime reports this once per session)\n"
            );
        }

        // ------------------------------------------------------------------ stop reporting

        static void FireStopped(int tid, string reason, string description, string text)
        {
            DapState.MarkPaused(tid);
            var sb = new StringBuilder();
            sb.Append("{\"reason\":")
                .Append(Json.Str(reason))
                .Append(",\"threadId\":")
                .Append(tid)
                .Append(",\"allThreadsStopped\":false,\"preserveFocusHint\":false");
            if (description != null)
                sb.Append(",\"description\":").Append(Json.Str(description));
            if (text != null)
                sb.Append(",\"text\":").Append(Json.Str(text));
            sb.Append("}");
            DapTransport.Event("stopped", sb.ToString());
        }

        void EvalAndFireOrSkip(int tid, string file, int line, string condition)
        {
            DapState.WaitForLocals(tid, 1000);
            bool condMet;
            lock (DapState.VarsLock)
            {
                List<CicodeFrame> tf;
                Dictionary<string, string> vars =
                    DapState.FramesByThread.TryGetValue(tid, out tf) && tf.Count > 0
                        ? tf[0].Locals
                        : new Dictionary<string, string>();
                condMet = EvaluateCondition(condition, vars);
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
                FireStopped(tid, "breakpoint", "Breakpoint at " + Path.GetFileName(file) + ":" + line, null);
            else
                ResumeThread(tid); // only this thread; others may be paused for the user
        }

        // ------------------------------------------------------------------ variables

        void PrefetchVars(int tid, string file, int line)
        {
            DapState.BeginFetchVars(tid, file, line);
            SendCmd(IpcClient.CMD_GET_STEP_WATCH, BitConverter.GetBytes(tid));
            SendCmd(IpcClient.CMD_GET_LOCALS_LIVE, BitConverter.GetBytes(tid));
        }

        void OnStepWatch(string text)
        {
            Logger.Ipc("STEP_WATCH: " + text.Replace("\r", "").Replace("\n", "  |  "));
            lock (DapState.VarsLock)
            {
                DapState.StepWatchVars.Clear();
                ParseKeyValueLines(text, DapState.StepWatchVars, skipCallStack: false);
                DapState.StepWatchPending = false;
            }
            DapState.StepWatchReady.Set();
        }

        void OnLocals(int locTid, string text)
        {
            if (text == null)
            {
                DapState.CompleteLocals(locTid, null);
                return;
            }
            Logger.Ipc("  locals thread=" + locTid + " text: " + text.Replace("\r\n", " | "));
            List<CicodeFrame> parsed = null;
            try
            {
                string sourceFile;
                int stoppedLine;
                DapState.TryGetThreadLocation(locTid, out sourceFile, out stoppedLine);

                // Interleaved: <call line>; [kv line]* <call line>; [kv line]* ...
                // Each call line opens a frame; kv lines that follow belong to it.
                // Runtime order is outermost-first, we reverse to innermost-first.
                parsed = new List<CicodeFrame>();
                CicodeFrame cur = null;
                foreach (
                    string ln in text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                )
                {
                    string t = ln.TrimEnd();
                    if (t.EndsWith(";") && t.Contains("("))
                    {
                        cur = new CicodeFrame
                        {
                            CallText = t,
                            Name = ExtractFuncName(t),
                            Args = SplitCallArgs(t),
                        };
                        parsed.Add(cur);
                        continue;
                    }
                    int eq = ln.IndexOf('=');
                    if (eq <= 0 || cur == null)
                        continue;
                    string vname = ln.Substring(0, eq).Trim();
                    string vval = StripQuality(ln.Substring(eq + 1).Trim());
                    if (vname.Length > 0)
                        cur.Locals[vname] = vval;
                }
                parsed.Reverse();

                // Innermost frame: map call args to real parameter names from the source.
                // Outer frames fall back to arg0/arg1/...
                if (parsed.Count > 0)
                {
                    var inner = parsed[0];
                    List<string> paramNames = GetFunctionParams(sourceFile, inner.Name, stoppedLine);
                    for (int pi = 0; pi < inner.Args.Count; pi++)
                    {
                        string pname = pi < paramNames.Count ? paramNames[pi] : ("arg" + pi);
                        inner.Locals[pname] = StripQuality(inner.Args[pi]);
                    }
                }
                for (int fi = 1; fi < parsed.Count; fi++)
                {
                    var f = parsed[fi];
                    for (int pi = 0; pi < f.Args.Count; pi++)
                        f.Locals["arg" + pi] = StripQuality(f.Args[pi]);
                }
                Logger.Ipc(
                    "  frames=" + parsed.Count + " innermost vars=" + (parsed.Count > 0 ? parsed[0].Locals.Count : 0)
                );
            }
            catch (Exception ex)
            {
                Logger.Warn("locals parse error: " + ex.Message);
                parsed = null;
            }
            DapState.CompleteLocals(locTid, parsed);
            if (parsed != null)
                OnStepProbeStack(locTid, parsed.Count);
        }

        // ------------------------------------------------------------------ framing helpers

        internal void SendTranCmd(uint cmdType, byte[] cmdPayload)
        {
            int plen = cmdPayload != null ? cmdPayload.Length : 0;
            int dataLen = 4 + 4 + 4 + plen;

            var data = new byte[dataLen];
            data[0] = (byte)'C';
            data[1] = (byte)'M';
            data[2] = (byte)'B';
            data[3] = 0;
            WriteLE32(data, 4, (uint)dataLen);
            WriteLE32(data, 8, cmdType);
            if (cmdPayload != null)
                Array.Copy(cmdPayload, 0, data, 12, plen);

            int bodyLen = 2 + 4 + dataLen;
            var body = new byte[bodyLen];
            WriteLE32(body, 2, (uint)dataLen);
            Array.Copy(data, 0, body, 6, dataLen);

            Logger.PaOut(string.Format("TranCmd 0x{0:X4} dataLen={1}", cmdType, dataLen));
            SendMessage(ScadaVersion.HashTran, ScadaVersion.TnTran, ref _sentTranType, body);
        }

        static byte[] BuildBpData(string file, uint line)
        {
            file = file.Replace('/', '\\');
            byte[] fileBytes = Ansi.GetBytes(file + "\0");
            var buf = new byte[4 + 4 + 4 + fileBytes.Length];
            WriteLE32(buf, 0, 0xFFFFFFFF); // thread filter: any thread
            WriteLE32(buf, 4, 0);
            WriteLE32(buf, 8, line);
            fileBytes.CopyTo(buf, 12);
            return buf;
        }

        // ------------------------------------------------------------------ attach diagnostics

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint serverProcessId);

        void ReportServerProcess()
        {
            uint pid = 0;
            try
            {
                if (!GetNamedPipeServerProcessId(_pipe.SafePipeHandle.DangerousGetHandle(), out pid))
                    pid = 0;
            }
            catch { }
            ThreadPool.QueueUserWorkItem(_ =>
            {
                string component = pid != 0 ? RuntimeComponentOf(pid) : null;
                string where = component != null ? "the " + component + " process" : "the runtime";
                DapTransport.Output(
                    "console",
                    "Attached to the Cicode debugger in "
                        + where
                        + (pid != 0 ? " (Citect32 pid " + pid + ")" : "")
                        + ".\n"
                        + "Only Cicode running in this process can be debugged. To debug another "
                        + "component, set [Debug]CodeDebug in citect.ini to IOServer, Alarm, Report "
                        + "or Trend (optionally <Cluster>.<Component>) and restart the runtime.\n"
                );
            });
        }

        static string RuntimeComponentOf(uint pid)
        {
            // Citect32 command lines carry the component: /R[C:Client], /R[I:Cluster1.IOServer1] ...
            try
            {
                using (
                    var s = new System.Management.ManagementObjectSearcher(
                        "SELECT CommandLine FROM Win32_Process WHERE ProcessId = " + pid
                    )
                )
                {
                    foreach (System.Management.ManagementObject o in s.Get())
                    {
                        string cl = o["CommandLine"] as string;
                        if (cl == null)
                            continue;
                        Match m = Regex.Match(cl, @"/R\[\w:([^\]]+)\]");
                        if (m.Success)
                            return m.Groups[1].Value;
                    }
                }
            }
            catch (Exception ex)
            {
                Logger.Ipc("RuntimeComponentOf failed: " + ex.Message);
            }
            return null;
        }

        // ------------------------------------------------------------------ source helpers

        string[] GetSourceLines(string path)
        {
            DateTime stamp = File.GetLastWriteTimeUtc(path);
            CachedSource entry;
            if (!_sourceCache.TryGetValue(path, out entry) || entry.LastWriteUtc != stamp)
            {
                entry = new CachedSource { LastWriteUtc = stamp, Lines = File.ReadAllLines(path) };
                _sourceCache[path] = entry;
            }
            return entry.Lines;
        }

        // Parameter names of funcName, from the nearest "FUNCTION funcName" header at or above
        // stoppedLine. The parameter list may hold comments and strings, and may be omitted.
        List<string> GetFunctionParams(string sourceFile, string funcName, int stoppedLine)
        {
            var result = new List<string>();
            if (sourceFile == null || string.IsNullOrEmpty(funcName) || !File.Exists(sourceFile))
                return result;
            try
            {
                string[] lines = GetSourceLines(sourceFile);
                int upto = Math.Max(0, Math.Min(stoppedLine, lines.Length));
                string code = BlankComments(string.Join("\n", lines, 0, upto));
                var header = new Regex(
                    @"\bFUNCTION\s+" + Regex.Escape(funcName) + @"(?![\w\\])",
                    RegexOptions.IgnoreCase
                );
                Match last = null;
                for (Match m = header.Match(code); m.Success; m = m.NextMatch())
                    last = m;
                if (last == null)
                    return result;

                // The list may continue past stoppedLine only when stopped inside the header.
                string rest = BlankComments(string.Join("\n", lines)).Substring(last.Index + last.Length);
                int i = 0;
                while (i < rest.Length && char.IsWhiteSpace(rest[i]))
                    i++;
                if (i >= rest.Length || rest[i] != '(')
                    return result; // "FUNCTION Name" without parentheses: no parameters
                int depth = 0;
                bool inStr = false;
                var cur = new StringBuilder();
                var parts = new List<string>();
                for (; i < rest.Length; i++)
                {
                    char c = rest[i];
                    if (inStr)
                    {
                        if (c == '^' && i + 1 < rest.Length)
                            cur.Append(c).Append(rest[++i]);
                        else
                        {
                            if (c == '"')
                                inStr = false;
                            cur.Append(c);
                        }
                        continue;
                    }
                    if (c == '"')
                        inStr = true;
                    else if (c == '(')
                    {
                        if (depth++ == 0)
                            continue;
                    }
                    else if (c == ')')
                    {
                        if (--depth == 0)
                            break;
                    }
                    else if (c == ',' && depth == 1)
                    {
                        parts.Add(cur.ToString());
                        cur.Clear();
                        continue;
                    }
                    cur.Append(c);
                }
                parts.Add(cur.ToString());
                foreach (string raw in parts)
                {
                    string p = raw;
                    int eq = p.IndexOf('=');
                    if (eq >= 0)
                        p = p.Substring(0, eq);
                    string[] words = p.Split(
                        new[] { ' ', '\t', '\r', '\n' },
                        StringSplitOptions.RemoveEmptyEntries
                    );
                    if (words.Length > 0)
                        result.Add(words[words.Length - 1]);
                }
            }
            catch (Exception ex)
            {
                Logger.Ipc("GetFunctionParams error: " + ex.Message);
            }
            return result;
        }

        // Replace comments (! and // to end of line, /* */) with spaces, keeping strings,
        // offsets and line breaks.
        static string BlankComments(string text)
        {
            var sb = new StringBuilder(text);
            int i = 0;
            while (i < text.Length)
            {
                char c = text[i];
                if (c == '"')
                {
                    i++;
                    while (i < text.Length && text[i] != '"')
                        i += text[i] == '^' ? 2 : 1;
                    i++;
                }
                else if (c == '!' || (c == '/' && i + 1 < text.Length && text[i + 1] == '/'))
                {
                    while (i < text.Length && text[i] != '\n')
                        sb[i++] = ' ';
                }
                else if (c == '/' && i + 1 < text.Length && text[i + 1] == '*')
                {
                    int end = text.IndexOf("*/", i + 2, StringComparison.Ordinal);
                    end = end < 0 ? text.Length : end + 2;
                    for (; i < end; i++)
                        if (text[i] != '\n')
                            sb[i] = ' ';
                }
                else
                    i++;
            }
            return sb.ToString();
        }

        static string ExtractFuncName(string callText)
        {
            if (callText == null) return "";
            int paren = callText.IndexOf('(');
            string head = paren > 0 ? callText.Substring(0, paren) : callText;
            return head.Trim();
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
            for (int i = 0; i < inner.Length; i++)
            {
                char c = inner[i];
                if (inStr && c == '^' && i + 1 < inner.Length)
                {
                    // Cicode escape (^" ^^ ^n ...): keep both chars, never toggles the string.
                    sb.Append(c).Append(inner[++i]);
                }
                else if (c == '"')
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

        internal static string NormalizePath(string file)
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
                return lines.Contains(line);
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

        // The runtime is an ANSI (char*) program: paths, tag names and messages are in the
        // system code page. ASCII would turn letters like "å" into "?", and a breakpoint path
        // that no longer matches the compiled file never hits.
        static readonly Encoding Ansi = Encoding.Default;

        // Read a null-terminated ANSI string from buf[off..off+maxLen).
        static string ReadCString(byte[] buf, int off, int maxLen)
        {
            if (maxLen <= 0)
                return "";
            int end = off;
            int limit = off + maxLen;
            while (end < limit && buf[end] != 0)
                end++;
            return Ansi.GetString(buf, off, end - off);
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
            // tid(4) + (unused/garbage)(4) + line(4) + path\0
            tid = (int)LE32(buf, payloadOff);
            line = (int)LE32(buf, payloadOff + 8);
            file = ReadCString(buf, payloadOff + 12, payloadLen - 12);
        }

        // ------------------------------------------------------------------ conditions

        // Condition operators shared by ValidateCondition and EvaluateCondition so the
        // two can never drift apart. Order matters: longest/most specific first
        // ("<>" before "<"). The word operators need surrounding whitespace so they never
        // match inside an identifier (e.g. "bContainsX").
        static readonly string[] CondOps =
        {
            " notcontains ",
            " contains ",
            ">=",
            "<=",
            "<>",
            "!=",
            "==",
            "=",
            ">",
            "<",
        };

        static int FindOp(string condition, string op, out int opLen)
        {
            opLen = op.Length;
            if (op[0] != ' ')
                return condition.IndexOf(op, StringComparison.Ordinal);
            Match m = Regex.Match(condition, @"\s" + op.Trim() + @"\s", RegexOptions.IgnoreCase);
            if (!m.Success)
                return -1;
            opLen = m.Length;
            return m.Index;
        }

        public static string ValidateCondition(string condition)
        {
            if (string.IsNullOrWhiteSpace(condition))
                return "Empty condition.";
            condition = condition.Trim();
            foreach (string op in CondOps)
            {
                int opLen;
                int idx = FindOp(condition, op, out opLen);
                if (idx < 0)
                    continue;
                string varName = condition.Substring(0, idx).Trim();
                string expected = condition.Substring(idx + opLen).Trim();
                string opName = op.Trim();
                if (varName.Length == 0)
                    return "Missing variable name before '" + opName + "'.";
                if (expected.Length == 0)
                    return "Missing value after '" + opName + "'.";
                foreach (char c in varName)
                    if (!char.IsLetterOrDigit(c) && c != '_')
                        return "Invalid variable name: '" + varName + "'.";
                if (opName == ">" || opName == ">=" || opName == "<" || opName == "<=")
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
                        return "Operator '" + opName + "' requires a numeric value.";
                }
                return null;
            }
            foreach (char c in condition)
                if (!char.IsLetterOrDigit(c) && c != '_')
                    return "Invalid expression. Supported forms: varName, varName == value, "
                        + "varName contains value, etc.";
            return null;
        }

        static bool TryGetVarIgnoreCase(Dictionary<string, string> vars, string name, out string value)
        {
            if (vars.TryGetValue(name, out value))
                return true;
            foreach (var kv in vars)
                if (string.Equals(kv.Key, name, StringComparison.OrdinalIgnoreCase))
                {
                    value = kv.Value;
                    return true;
                }
            value = null;
            return false;
        }

        static bool EvaluateCondition(string condition, Dictionary<string, string> vars)
        {
            condition = condition.Trim();
            foreach (string op in CondOps)
            {
                int opLen;
                int idx = FindOp(condition, op, out opLen);
                if (idx < 0)
                    continue;
                string opName = op.Trim().ToLowerInvariant();
                string varName = condition.Substring(0, idx).Trim();
                string expected = condition.Substring(idx + opLen).Trim();
                // TRUE and FALSE are labels for 1 and 0; locals show the numbers.
                if (string.Equals(expected, "TRUE", StringComparison.OrdinalIgnoreCase))
                    expected = "1";
                else if (string.Equals(expected, "FALSE", StringComparison.OrdinalIgnoreCase))
                    expected = "0";
                if (
                    expected.Length >= 2
                    && (
                        (expected[0] == '"' && expected[expected.Length - 1] == '"')
                        || (expected[0] == '\'' && expected[expected.Length - 1] == '\'')
                    )
                )
                    expected = expected.Substring(1, expected.Length - 2);
                string varValue;
                if (!TryGetVarIgnoreCase(vars, varName, out varValue))
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
                var inv = System.Globalization.CultureInfo.InvariantCulture;
                var ns = System.Globalization.NumberStyles.Any;
                if (double.TryParse(varValue, ns, inv, out lhs) && double.TryParse(expected, ns, inv, out rhs))
                {
                    switch (opName)
                    {
                        case "==":
                        case "=":
                            return lhs == rhs;
                        case "!=":
                        case "<>":
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
                switch (opName)
                {
                    case "==":
                    case "=":
                        return string.Equals(varValue, expected, StringComparison.OrdinalIgnoreCase);
                    case "<>":
                    case "!=":
                        return !string.Equals(varValue, expected, StringComparison.OrdinalIgnoreCase);
                    case "contains":
                        return varValue.IndexOf(expected, StringComparison.OrdinalIgnoreCase) >= 0;
                    case "notcontains":
                        return varValue.IndexOf(expected, StringComparison.OrdinalIgnoreCase) < 0;
                }
                return false;
            }
            string val;
            if (!TryGetVarIgnoreCase(vars, condition, out val))
            {
                Logger.Ipc("Condition: var '" + condition + "' not found in locals");
                return false;
            }
            val = StripQuality(val).Trim();
            double dv;
            return double.TryParse(
                val,
                System.Globalization.NumberStyles.Any,
                System.Globalization.CultureInfo.InvariantCulture,
                out dv
            )
                ? dv != 0.0
                : val.Length > 0;
        }
    }
}
