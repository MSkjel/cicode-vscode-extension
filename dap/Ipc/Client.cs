using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;

namespace CicodeDebugAdapter
{
    /// <summary>
    /// Everything IPC: CRC32, PacketAdapter v2.2 framing, named-pipe connection,
    /// the 4-phase handshake, heartbeat/reader threads, IPC->DAP event translation.
    ///
    /// Wire protocol summary:
    ///   Phase 1b: version bytes (0x00 0x00 echoed)
    ///   Phase 2:  GUID security challenge/response via callback pipe
    ///   Phase 3:  IdentifyMessage (PacketAdapterV100 format, Version=1.0.0.0)
    ///   Running:  PacketAdapter v2.2 frames → TranEncapsulationMessage → CMB payload
    /// </summary>
    static class IpcClient
    {
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

        const uint EVT_RESUMED = 0x1000;
        const uint EVT_STOPPED = 0x1001;
        const uint EVT_SOURCE_LOC = 0x1002;
        const uint EVT_BP_HIT = 0x1003;
        const uint EVT_STEP_WATCH = 0x1009;
        const uint EVT_LOCALS_LIVE = 0x100A;
        const uint EVT_TEXT_OUTPUT = 0x100C;
        const uint EVT_WATCH_EVAL_RESP = 0x100F;

        // Test hook: called with the raw payload bytes when EVT_WATCH_EVAL_RESP arrives.
        public static Action<byte[]> WatchRespHook = null;

        // Test hook: set to the most recent BP hit for polling by a test harness.
        public class BpHitInfo
        {
            public int ThreadId;
            public string File;
            public int Line;
        }

        public static volatile BpHitInfo LastBpHit = null;

        // IdentifyMessage Phase 3, PacketAdapterV100 format.
        const int TYPE_HASH_V100 = unchecked((int)0xCC314E6B);
        const string TYPE_NAME_IDENTIFY =
            "Citect.Platform.Net.Message.IdentifyMessage, "
            + "Citect.Platform.Net.Message, Version=1.0.0.0, "
            + "Culture=neutral, PublicKeyToken=13aaee2494f61799";
        const int SERVICE_ID = unchecked((int)0x7DD2111F); // captured from sniffer
        const short PROTO_VER = 0x0202; // PacketAdapter wire protocol version
        const int HDR_LEN = 20; // IdentifyMessage header length

        // CRC32 (PacketAdapter seed + polynomial)
        const uint PA_SEED = 0x7DB49658u;
        const uint PA_POLY = 0xEDB88320u;
        const uint PA_MARKER = 0xFFFF0201u;
        const int PA_HDRLEN = 16;

        static uint[] _crcTable;

        public static void InitCrc()
        {
            _crcTable = new uint[256];
            for (int i = 0; i < 256; i++)
            {
                uint c = (uint)i;
                for (int j = 0; j < 8; j++)
                    c = (c & 1u) != 0 ? (c >> 1) ^ PA_POLY : c >> 1;
                _crcTable[i] = c;
            }
        }

        static uint CrcCompute(uint crc, byte[] buf, int start, int len)
        {
            for (int i = start; i < start + len; i++)
                crc = (crc >> 8) ^ _crcTable[(buf[i] ^ crc) & 0xFF];
            return crc;
        }

        static NamedPipeClientStream _pipe;
        public static volatile bool Stopping = false;
        static readonly object _sendLock = new object();
        public static string PipeName = null;

        static uint _outSeqId = 0;
        static uint _recvSeqId = 0;
        static uint _ackedSeqId = 0;

        // Type-name cache: once we've sent/received a type name, subsequent frames
        // only carry the hash.  Each bool tracks whether we've sent the full name.
        static bool _sentHbType = false;
        static bool _sentAckType = false;
        static bool _sentTranType = false;

        static readonly HashSet<uint> _sentTypeHashes = new HashSet<uint>();
        static readonly Dictionary<uint, string> _recvTypeNames = new Dictionary<uint, string>();
        static readonly HashSet<uint> _recvTypeHashes = new HashSet<uint>();

        // Lines for which we've already logged a stale-hit warning this session.
        // After the first log, subsequent flood hits are logged as "(flood)" to avoid spam.
        // Cleared on RESUMED so future removals are handled fresh.
        static readonly HashSet<string> _staleClearedKeys = new HashSet<string>();

        // Source file cache, read-only files, accessed only from the reader thread.
        static readonly Dictionary<string, string[]> _sourceCache = new Dictionary<
            string,
            string[]
        >(StringComparer.OrdinalIgnoreCase);

        static string[] GetSourceLines(string path)
        {
            string[] lines;
            if (!_sourceCache.TryGetValue(path, out lines))
            {
                lines = File.ReadAllLines(path);
                _sourceCache[path] = lines;
            }
            return lines;
        }

        /// <summary>Connect to the SCADA runtime, run the 4-phase handshake, start threads.</summary>
        public static void Connect(string pipeName)
        {
            PipeName = pipeName;
            Logger.Ipc("Connecting to \\\\.\\pipe\\" + pipeName + " ...");
            _pipe = new NamedPipeClientStream(
                ".",
                pipeName,
                PipeDirection.InOut,
                PipeOptions.Asynchronous
            );
            _pipe.Connect(5000);
            Logger.Ipc("Connected");

            // Phase 1b: version handshake
            WriteFull(_pipe, new byte[] { 0x00, 0x00 });
            var verIn = new byte[2];
            ReadExact(_pipe, verIn, 2, 3000);
            Logger.Ipc("Version echo: " + Hex(verIn));

            // Phase 2: GUID security challenge/response via callback pipe
            var guid = Guid.NewGuid();
            var guidBytes = guid.ToByteArray();
            var cbPipe = new NamedPipeServerStream(
                guid.ToString(),
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous
            );
            WriteFull(_pipe, guidBytes);
            Logger.Ipc("GUID sent, waiting for callback...");
            var iac = cbPipe.BeginWaitForConnection(null, null);
            if (!iac.AsyncWaitHandle.WaitOne(5000))
                throw new Exception("Server did not connect to callback pipe in time");
            cbPipe.EndWaitForConnection(iac);
            var echo = new byte[16];
            try
            {
                ReadExact(cbPipe, echo, 16, 3000);
            }
            catch { }
            cbPipe.Close();
            Logger.Ipc("Security check passed");

            // Phase 3: IdentifyMessage (V100 format)
            byte[] identify = BuildIdentifyMessage();
            WriteFull(_pipe, identify);
            var resp = new byte[identify.Length];
            try
            {
                ReadExact(_pipe, resp, identify.Length, 5000);
            }
            catch (Exception ex)
            {
                Logger.Ipc("IdentifyMessage resp: " + ex.Message);
            }
            Logger.Ipc("IdentifyMessage exchanged");

            RegisterKnownTypes();
            StartThreads();

            // Brief settle delay then SESSION_START
            Thread.Sleep(500);
            Logger.Ipc("Sending SESSION_START");
            SendTranCmd(CMD_SESSION_START, new byte[4]);
        }

        /// <summary>Send SESSION_STOP and close the pipe.</summary>
        public static void Disconnect()
        {
            Stopping = true;
            try
            {
                SendTranCmd(CMD_SESSION_STOP, new byte[4]);
            }
            catch { }
            try
            {
                _pipe.Close();
            }
            catch { }
        }

        /// <summary>
        /// Disconnect and immediately reconnect to the same pipe.
        /// This clears all runtime breakpoints (Citect32 removes patched bytecode on disconnect),
        /// then re-registers only the BPs still in DapState.PendingBps.
        /// </summary>
        public static void Reconnect()
        {
            Logger.Ipc("Reconnect: stopping current session");

            // If the debugger is stopped at a BP, tell VS Code threads have resumed
            // so it doesn't show a stale "paused" state.
            if (DapState.IsStopped)
            {
                DapState.IsStopped = false;
                DapTransport.Event("continued", "{\"allThreadsContinued\":true}");
            }

            // Stop current session. Stopping=true prevents the reader thread from
            // emitting a spurious "terminated" event when the pipe closes.
            Stopping = true;
            try
            {
                SendTranCmd(CMD_SESSION_STOP, new byte[4]);
            }
            catch { }
            try
            {
                _pipe.Close();
            }
            catch { }

            // Give reader/heartbeat threads time to notice Stopping and exit.
            Thread.Sleep(400);

            // Reset all IPC sequence/type-cache state so the new connection
            // starts from scratch (same as a fresh Connect() call).
            lock (_sendLock)
            {
                _outSeqId = 0;
                _recvSeqId = 0;
                _ackedSeqId = 0;
            }
            _sentHbType = false;
            _sentAckType = false;
            _sentTranType = false;
            _sentTypeHashes.Clear();
            _recvTypeNames.Clear();
            _recvTypeHashes.Clear();
            _staleClearedKeys.Clear();
            LastBpHit = null;

            // Reset DAP thread state. Threads resumed when we disconnected.
            lock (DapState.SessionLock)
            {
                DapState.Threads.Clear();
                DapState.ThreadFile.Clear();
                DapState.ThreadLine.Clear();
                DapState.SteppingThread = -1;
                DapState.StoppedThreadId = -1;
            }

            Stopping = false;
            Logger.Ipc("Reconnect: reconnecting to " + PipeName);
            Connect(PipeName);
            Logger.Ipc("Reconnect: done");
        }

        /// <summary>Send a raw CMB command (fire-and-forget, logs errors).</summary>
        public static void SendCmd(uint cmd, byte[] payload)
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

        /// <summary>Build and send a breakpoint set/clear command.</summary>
        public static void SendBp(uint cmd, string file, int line)
        {
            SendCmd(cmd, BuildBpData(file, (uint)line));
        }

        /// <summary>
        /// Clear ALL runtime breakpoints.
        /// IPC-Log-confirmed format: 0xFFFFFFFF + 0 + line=0 + "\0",
        /// though I cannot for the life of me get it working :(
        /// As a "Temporary-Permanent" "fix", just disconnect the debugsession
        /// and reconnect -> resync -> profit :)
        /// </summary>
        public static void SendBpClrAll()
        {
            SendCmd(
                CMD_BP_CLR,
                new byte[]
                {
                    0xFF,
                    0xFF,
                    0xFF,
                    0xFF, // id = 0xFFFFFFFF
                    0x00,
                    0x00,
                    0x00,
                    0x00, // unk = 0
                    0x00,
                    0x00,
                    0x00,
                    0x00, // line = 0
                    0x00, // path = "\0" (empty)
                }
            );
        }

        static void OnIpcEvent(uint cmd, byte[] buf, int payloadOff, int payloadLen)
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
                        int tid = (int)LE32(buf, payloadOff);
                        int line = (int)LE32(buf, payloadOff + 8);
                        int fnEnd = payloadOff + 12;
                        while (fnEnd < payloadOff + payloadLen && buf[fnEnd] != 0)
                            fnEnd++;
                        string file = Encoding.ASCII.GetString(
                            buf,
                            payloadOff + 12,
                            fnEnd - (payloadOff + 12)
                        );

                        Logger.Ipc("BP_HIT thread=" + tid + " line=" + line + " file=" + file);
                        lock (DapState.SessionLock)
                        {
                            DapState.Threads.Add(tid);
                            DapState.ThreadFile[tid] = file;
                            DapState.ThreadLine[tid] = line;
                        }
                        LastBpHit = new BpHitInfo
                        {
                            ThreadId = tid,
                            File = file,
                            Line = line,
                        };

                        // Stale-hit guard: if the BP was removed since this hit was queued,
                        // silently resume rather than stopping VS Code.
                        // CMD_BP_CLR does not restore the patched bytecode, so the runtime
                        // will keep generating hits until the user disconnects and reconnects.
                        // We log the first occurrence and then suppress the flood, always
                        // sending CONTINUE_ALL so the paused thread doesn't deadlock.
                        // This isnt really needed with the reconnect "hack", but imma keep it anyways :P
                        if (!IsBpActive(file, line))
                        {
                            string staleKey = NormalizePath(file) + ":" + line;
                            if (_staleClearedKeys.Add(staleKey))
                                Logger.Ipc(
                                    "BP_HIT stale. silently continuing (CLR doesn't restore bytecode; reconnect to clear)"
                                );
                            else
                                Logger.Ipc("BP_HIT stale (flood). CONTINUE_ALL only");
                            SendCmd(CMD_CONTINUE_ALL, BitConverter.GetBytes(unchecked((uint)-1)));
                            break;
                        }

                        PrefetchVars(tid, file, line);

                        string condition = GetBpCondition(file, line);
                        if (condition != null)
                        {
                            // We must NOT block the reader thread
                            // or the locals response will never arrive.
                            int captTid = tid;
                            string captFile = file;
                            int captLine = line;
                            ThreadPool.QueueUserWorkItem(_ =>
                                EvalAndFireOrSkip(captTid, captFile, captLine, condition)
                            );
                        }
                        else
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
                    }
                    break;

                case EVT_SOURCE_LOC:
                    // Step completed
                    if (payloadLen >= 12)
                    {
                        int tid = (int)LE32(buf, payloadOff);
                        int line = (int)LE32(buf, payloadOff + 8);
                        int fnEnd = payloadOff + 12;
                        while (fnEnd < payloadOff + payloadLen && buf[fnEnd] != 0)
                            fnEnd++;
                        string file = Encoding.ASCII.GetString(
                            buf,
                            payloadOff + 12,
                            fnEnd - (payloadOff + 12)
                        );

                        Logger.Ipc("SOURCE_LOC thread=" + tid + " line=" + line + " file=" + file);
                        lock (DapState.SessionLock)
                        {
                            DapState.Threads.Add(tid);
                            DapState.ThreadFile[tid] = file;
                            DapState.ThreadLine[tid] = line;
                        }

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
                        // else: SOURCE_LOC for a thread we didn't step. ignore
                    }
                    break;

                case EVT_STEP_WATCH:
                    // Response to CMD_GET_STEP_WATCH: 4-byte header then "name = value\r\n" lines
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
                    // Response to CMD_GET_LOCALS_LIVE (0x102A). Stack Window local variables.
                    // Payload: thread_id(4) + null-terminated text with \r\n-delimited lines:
                    //   - Call stack entries end with ';'. the innermost one has parameter values
                    //   - Local variables: "name         = value {quality}"
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

                            // Find innermost call-stack entry. it contains positional parameter values.
                            // All call-stack lines end with ';'.  The innermost one has '(' in it.
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
                                    break; // first non-call-stack line. done collecting frames
                            }

                            lock (DapState.VarsLock)
                            {
                                DapState.LocalVars.Clear();

                                // Add parameters first (they appear before locals in the panel)
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

                                // Add locals (may overwrite if a name clashes, which is fine)
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

                case EVT_TEXT_OUTPUT: // 0x100C. also fires as BP registration confirmation
                    if (payloadLen >= 12)
                    {
                        uint f0 = LE32(buf, payloadOff);
                        uint f1 = LE32(buf, payloadOff + 4);
                        uint f2 = LE32(buf, payloadOff + 8);
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
                        if (Evt100CHook != null)
                        {
                            var p = new byte[payloadLen];
                            Array.Copy(buf, payloadOff, p, 0, payloadLen);
                            Evt100CHook(p);
                        }
                    }
                    break;

                case EVT_WATCH_EVAL_RESP:
                    Logger.Ipc(
                        string.Format("EVT_WATCH_EVAL_RESP (0x100F) payloadLen={0}", payloadLen)
                    );
                    if (WatchRespHook != null && payloadLen > 0)
                    {
                        var payload = new byte[payloadLen];
                        Array.Copy(buf, payloadOff, payload, 0, payloadLen);
                        WatchRespHook(payload);
                    }
                    break;
            }
        }

        public static Action<byte[]> Evt100CHook = null;

        static void StartThreads()
        {
            // Heartbeat every 5 s
            new Thread(() =>
            {
                Thread.Sleep(1000);
                while (!Stopping)
                {
                    try
                    {
                        SendHeartbeat();
                    }
                    catch { }
                    for (int i = 0; i < 50 && !Stopping; i++)
                        Thread.Sleep(100);
                }
            })
            {
                IsBackground = true,
            }.Start();

            // Frame reader. accumulates raw bytes, extracts complete PA frames
            new Thread(() =>
            {
                var recvBuf = new byte[65536];
                int recvOff = 0;
                var readBuf = new byte[4096];

                while (!Stopping)
                {
                    int n;
                    try
                    {
                        n = _pipe.Read(readBuf, 0, readBuf.Length);
                    }
                    catch (Exception ex)
                    {
                        Logger.Reader("" + ex.Message);
                        break;
                    }
                    if (n == 0)
                    {
                        Logger.Reader("EOF");
                        break;
                    }

                    if (recvOff + n > recvBuf.Length)
                    {
                        var nb = new byte[recvBuf.Length * 2];
                        Array.Copy(recvBuf, 0, nb, 0, recvOff);
                        recvBuf = nb;
                    }
                    Array.Copy(readBuf, 0, recvBuf, recvOff, n);
                    recvOff += n;

                    int consumed = 0;
                    while (recvOff - consumed >= PA_HDRLEN)
                    {
                        if (LE32(recvBuf, consumed) != PA_MARKER)
                        {
                            consumed++;
                            continue;
                        }
                        uint frameSeq = LE32(recvBuf, consumed + 4);
                        int payloadLen = (int)LE32(recvBuf, consumed + 8);
                        int totalLen = PA_HDRLEN + payloadLen;
                        if (recvOff - consumed < totalLen)
                            break; // wait for more data

                        uint crc = CrcCompute(PA_SEED, recvBuf, consumed + 16, payloadLen);
                        crc = CrcCompute(crc, recvBuf, consumed, 12);
                        Logger.Pa(
                            string.Format(
                                "Frame seqId={0} payloadLen={1} CRC={2}",
                                frameSeq,
                                payloadLen,
                                crc == LE32(recvBuf, consumed + 12) ? "OK" : "ERR"
                            )
                        );

                        ParseFramePayload(recvBuf, consumed + 16, payloadLen, (int)frameSeq);
                        consumed += totalLen;
                    }

                    if (consumed > 0)
                    {
                        Array.Copy(recvBuf, consumed, recvBuf, 0, recvOff - consumed);
                        recvOff -= consumed;
                    }
                }

                Logger.Reader("Exited");
                if (!Stopping)
                    DapTransport.Event("terminated");
            })
            {
                IsBackground = true,
            }.Start();
        }

        static void SendHeartbeat()
        {
            lock (_sendLock)
            {
                _outSeqId++;
                if (_outSeqId == 0)
                    _outSeqId = 1;
                SendFrameLocked(
                    _outSeqId,
                    BuildMsgPayload(ScadaVersion.HashHb, ScadaVersion.TnHb, ref _sentHbType, null)
                );
            }
        }

        static void SendAck(uint ackSeqId)
        {
            lock (_sendLock)
            {
                if (ackSeqId == _ackedSeqId)
                    return;
                _ackedSeqId = ackSeqId;
                var body = new byte[4];
                body[0] = (byte)ackSeqId;
                body[1] = (byte)(ackSeqId >> 8);
                body[2] = (byte)(ackSeqId >> 16);
                body[3] = (byte)(ackSeqId >> 24);
                SendFrameLocked(
                    0,
                    BuildMsgPayload(
                        ScadaVersion.HashAck,
                        ScadaVersion.TnAck,
                        ref _sentAckType,
                        body
                    )
                );
            }
        }

        static void SendTranCmd(uint cmdType, byte[] cmdPayload)
        {
            int plen = cmdPayload != null ? cmdPayload.Length : 0;
            int dataLen = 4 + 4 + 4 + plen; // "CMB\0" + dataLen(4) + cmdType(4) + payload

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

            // TranEncapsulationMessage body: 2-byte pad + 4-byte dataLen + CMB block
            int bodyLen = 2 + 4 + dataLen;
            var body = new byte[bodyLen];
            body[2] = (byte)dataLen;
            body[3] = (byte)(dataLen >> 8);
            body[4] = (byte)(dataLen >> 16);
            body[5] = (byte)(dataLen >> 24);
            Array.Copy(data, 0, body, 6, dataLen);

            lock (_sendLock)
            {
                _outSeqId++;
                if (_outSeqId == 0)
                    _outSeqId = 1;
                Logger.PaOut(
                    string.Format(
                        "TranCmd 0x{0:X4} dataLen={1} seqId={2}",
                        cmdType,
                        dataLen,
                        _outSeqId
                    )
                );
                SendFrameLocked(
                    _outSeqId,
                    BuildMsgPayload(
                        ScadaVersion.HashTran,
                        ScadaVersion.TnTran,
                        ref _sentTranType,
                        body
                    )
                );
            }
        }

        // Caller must hold _sendLock.
        static void SendFrameLocked(uint seqId, byte[] payload)
        {
            var frame = new byte[PA_HDRLEN + payload.Length];
            // Magic marker: 01 02 FF FF
            frame[0] = 0x01;
            frame[1] = 0x02;
            frame[2] = 0xFF;
            frame[3] = 0xFF;
            WriteLE32(frame, 4, seqId);
            WriteLE32(frame, 8, (uint)payload.Length);
            Array.Copy(payload, 0, frame, 16, payload.Length);
            uint crc = CrcCompute(PA_SEED, frame, 16, payload.Length);
            crc = CrcCompute(crc, frame, 0, 12);
            WriteLE32(frame, 12, crc);
            _pipe.Write(frame, 0, frame.Length);
            _pipe.Flush();
        }

        static void RegisterKnownTypes()
        {
            _recvTypeNames[ScadaVersion.HashHb] = "HeartbeatMessage";
            _recvTypeNames[ScadaVersion.HashAck] = "AcknowledgementMessage";
            _recvTypeNames[ScadaVersion.HashTran] = "TranEncapsulationMessage";
            _recvTypeNames[ScadaVersion.HashTranLegacy] = "TranEncapsulationMessage";
        }

        static void ParseFramePayload(byte[] buf, int start, int len, int frameSeqId)
        {
            int off = start;
            int end = start + len;
            bool hasNonAck = false;

            while (off < end)
            {
                int offBefore = off;
                if (!ParseOneMessage(buf, ref off, end))
                    break;

                uint hash = LE32(buf, offBefore);
                string tn = _recvTypeNames.ContainsKey(hash) ? _recvTypeNames[hash] : "";
                if (!tn.Contains("AcknowledgementMessage"))
                    hasNonAck = true;
            }

            if (hasNonAck && frameSeqId > 0)
            {
                _recvSeqId = (uint)frameSeqId;
                try
                {
                    SendAck(_recvSeqId);
                }
                catch { }
            }
        }

        static bool ParseOneMessage(byte[] buf, ref int off, int end)
        {
            if (end - off < 4)
                return false;
            uint hash = LE32(buf, off);
            off += 4;

            // First time we see this hash: read the length-prefixed type name
            if (!_recvTypeHashes.Contains(hash))
            {
                int byteLen = 0,
                    shift = 0;
                while (off < end)
                {
                    byte b = buf[off++];
                    byteLen |= (b & 0x7F) << shift;
                    shift += 7;
                    if ((b & 0x80) == 0)
                        break;
                }
                if (off + byteLen > end)
                {
                    off -= 4;
                    return false;
                }
                string typeName = Encoding.UTF8.GetString(buf, off, byteLen);
                off += byteLen;
                _recvTypeHashes.Add(hash);
                _recvTypeNames[hash] = typeName;
                if (end - off < 4)
                    return false;
                off += 4; // second copy of the hash follows the type name
            }

            string tn = _recvTypeNames.ContainsKey(hash) ? _recvTypeNames[hash] : "";

            if (tn.Contains("HeartbeatMessage"))
            {
                // no body
            }
            else if (tn.Contains("AcknowledgementMessage"))
            {
                if (end - off < 4)
                    return false;
                off += 4;
            }
            else if (tn.Contains("TranEncapsulationMessage"))
            {
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
                        string.Format(
                            "TranEncap cmd=0x{0:X4} payloadLen={1}",
                            cmbCmd,
                            cmbPayloadLen
                        )
                    );
                    OnIpcEvent(cmbCmd, buf, cmbPayloadOff, cmbPayloadLen);
                }
            }
            else
            {
                return false; // unknown type. stop parsing this frame
            }

            return true;
        }

        /// <summary>
        /// Build a PacketAdapter message payload.
        /// First call for a given type includes the length-prefixed type name;
        /// subsequent calls only include the hash.
        /// </summary>
        static byte[] BuildMsgPayload(uint hash, string typeName, ref bool alreadySent, byte[] body)
        {
            var ms = new MemoryStream();
            var bw = new BinaryWriter(ms);
            if (!alreadySent)
            {
                bw.Write((int)hash);
                byte[] enc = EncodeString(typeName);
                bw.Write(enc, 0, enc.Length);
                alreadySent = true;
            }
            bw.Write((int)hash);
            if (body != null && body.Length > 0)
                bw.Write(body, 0, body.Length);
            bw.Flush();
            return ms.ToArray();
        }

        /// <summary>Encode a string as a varint-length-prefixed UTF-8 byte sequence.</summary>
        static byte[] EncodeString(string s)
        {
            byte[] utf8 = Encoding.UTF8.GetBytes(s);
            var result = new System.Collections.Generic.List<byte>();
            int len = utf8.Length;
            while (len >= 0x80)
            {
                result.Add((byte)((len & 0x7F) | 0x80));
                len >>= 7;
            }
            result.Add((byte)len);
            result.AddRange(utf8);
            return result.ToArray();
        }

        /// <summary>Build the Phase 3 IdentifyMessage (PacketAdapterV100 wire format).</summary>
        static byte[] BuildIdentifyMessage()
        {
            byte[] typeNameUtf8 = Encoding.UTF8.GetBytes(TYPE_NAME_IDENTIFY);
            byte[] typeNameEncoded = new byte[typeNameUtf8.Length + 2];
            typeNameEncoded[0] = (byte)((typeNameUtf8.Length & 0x7F) | 0x80);
            typeNameEncoded[1] = (byte)(typeNameUtf8.Length >> 7);
            Array.Copy(typeNameUtf8, 0, typeNameEncoded, 2, typeNameUtf8.Length);

            int payloadLen = 4 + 4 + typeNameEncoded.Length + 14;
            var ms = new MemoryStream(HDR_LEN + payloadLen);
            using (var bw = new BinaryWriter(ms))
            {
                bw.Write((int)payloadLen);
                bw.Write((short)0);
                bw.Write((int)0);
                bw.Write((int)0);
                bw.Write((uint)0);
                bw.Write(PROTO_VER);
                bw.Write((int)1);
                bw.Write(TYPE_HASH_V100);
                bw.Write(typeNameEncoded, 0, typeNameEncoded.Length);
                bw.Write(SERVICE_ID);
                bw.Write((int)0);
                bw.Write((short)0);
                bw.Write(ScadaVersion.MsgVersion);
                bw.Write(PROTO_VER);
                bw.Flush();
            }
            return ms.ToArray();
        }

        /// <summary>Build the CMB payload for a breakpoint set/clear command.</summary>
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

        /// <summary>Pre-fetch step-watch and local variables when a thread stops.</summary>
        static void PrefetchVars(int tid, string file, int line)
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
            SendCmd(CMD_GET_STEP_WATCH, BitConverter.GetBytes((uint)tid));
            SendCmd(CMD_GET_LOCALS_LIVE, BitConverter.GetBytes((uint)tid));
        }

        /// <summary>
        /// Read the source file and return the parameter names for the function containing stoppedLine.
        /// Searches backwards from stoppedLine for a FUNCTION declaration, then parses its signature.
        /// </summary>
        static List<string> GetFunctionParams(string sourceFile, int stoppedLine)
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

                    // Accumulate lines until we have the closing ')'
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

                    // Each parameter: [TYPE] name [= default]. last whitespace-delimited word is the name
                    List<string> paramTokens = SplitCallArgs(paramStr);
                    foreach (string token in paramTokens)
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

        /// <summary>
        /// Split a comma-separated argument list, respecting quoted strings and {quality} braces.
        /// Handles both function declaration params and runtime call-stack argument strings.
        /// </summary>
        static List<string> SplitCallArgs(string callText)
        {
            var result = new List<string>();

            // Extract the content inside the outermost parentheses (if present)
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
                {
                    sb.Append(c);
                }
            }
            if (sb.Length > 0)
                result.Add(sb.ToString().Trim());
            return result;
        }

        /// <summary>Strip the trailing SCADA quality tag, e.g. " {Good}" or " {Good, 2024-01-01T...}".</summary>
        static string StripQuality(string value)
        {
            if (!DapState.StripQualityTags || value == null)
                return value;
            int brace = value.LastIndexOf(" {");
            if (brace >= 0 && value.EndsWith("}"))
                return value.Substring(0, brace);
            return value;
        }

        /// <summary>
        /// Parse "name = value\r\n" lines from a runtime variable dump.
        /// When skipCallStack is true, lines ending with ';' (stack frames) are ignored.
        /// </summary>
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

        /// <summary>
        /// Return true if the breakpoint at file:line is still enabled in PendingBps.
        /// </summary>
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

        /// <summary>
        /// Return the condition string for a breakpoint, or null if unconditional.
        /// </summary>
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

        /// <summary>
        /// Called on a fresh thread: wait for locals, evaluate the condition,
        /// then either fire "stopped" to VS Code or silently CONTINUE_ALL.
        /// </summary>
        static void EvalAndFireOrSkip(int tid, string file, int line, string condition)
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
            else
            {
                SendCmd(CMD_CONTINUE_ALL, BitConverter.GetBytes(unchecked((uint)-1)));
            }
        }

        /// <summary>
        /// Validate a condition expression. Returns null if valid, or an error message.
        /// Supports: varName, varName op value  where op is ==, =, !=, &gt;, &gt;=, &lt;, &lt;=
        /// </summary>
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
                return null; // valid
            }
            // Bare var name (truthy check)
            foreach (char c in condition)
                if (!char.IsLetterOrDigit(c) && c != '_')
                    return "Invalid expression. Supported forms: varName, varName == value, varName > value, etc.";
            return null; // valid
        }

        /// <summary>
        /// Evaluate a simple condition expression against a variable dictionary.
        /// Supports: varName op value  where op is ==, =, !=, &gt;, &gt;=, &lt;, &lt;=
        /// Also supports bare varName (truthy: non-zero number or non-empty string).
        /// Quality tags are stripped before comparison.
        /// </summary>
        static bool EvaluateCondition(string condition, Dictionary<string, string> vars)
        {
            condition = condition.Trim();
            string[] ops = { ">=", "<=", "<>", "!=", "==", "=", ">", "<" };
            foreach (string op in ops)
            {
                int idx = condition.IndexOf(op);
                if (idx < 0)
                    continue;

                string varName = condition.Substring(0, idx).Trim();
                string expected = condition.Substring(idx + op.Length).Trim();
                // Strip surrounding quotes from expected value
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
                // Strip surrounding quotes. string vars are stored as "value" in the locals dump
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
                }
                return false;
            }

            // No operator. truthy check: non-zero number or non-empty string
            string val;
            if (!vars.TryGetValue(condition, out val))
            {
                Logger.Ipc("Condition: var '" + condition + "' not found in locals");
                return false;
            }
            val = StripQuality(val).Trim();
            double d;
            return double.TryParse(val, out d) ? d != 0.0 : val.Length > 0;
        }

        static void WriteFull(Stream s, byte[] data)
        {
            s.Write(data, 0, data.Length);
            s.Flush();
        }

        static int ReadExact(Stream s, byte[] buf, int n, int timeoutMs)
        {
            int got = 0;
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (got < n)
            {
                if (DateTime.UtcNow > deadline)
                    throw new TimeoutException("ReadExact timeout (got " + got + "/" + n + ")");
                int r = s.Read(buf, got, n - got);
                if (r == 0)
                    throw new EndOfStreamException("EOF");
                got += r;
            }
            return got;
        }

        static uint LE32(byte[] b, int o)
        {
            return (uint)(b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24));
        }

        static void WriteLE32(byte[] b, int o, uint v)
        {
            b[o] = (byte)v;
            b[o + 1] = (byte)(v >> 8);
            b[o + 2] = (byte)(v >> 16);
            b[o + 3] = (byte)(v >> 24);
        }

        static string Hex(byte[] b)
        {
            var sb = new StringBuilder();
            int n = Math.Min(b.Length, 16);
            for (int i = 0; i < n; i++)
                sb.AppendFormat("{0:X2} ", b[i]);
            return sb.ToString().TrimEnd();
        }
    }
}
