using System;
using System.IO;
using System.Text;
using System.Threading;

namespace CicodeDebugAdapter
{
    /// <summary>
    /// Connects to SE.Citect.RuntimeManager and forwards DiagnosticsKerMsg (type=26)
    /// as DAP stdout output events.
    /// </summary>
    static class RuntimeClient
    {
        static readonly RuntimePaClient _inst = new RuntimePaClient();

        public static void Start()
        {
            new Thread(_inst.RunLoop) { IsBackground = true, Name = "RuntimeClient" }.Start();
        }
    }

    class RuntimePaClient : PaClient
    {
        const string PIPE_NAME = "SE.Citect.RuntimeManager";
        const int RT_MSG_DIAG_KER = 26; // RuntimeManagerMessageType.DiagnosticsKerMsg

        bool _sentPicType;
        readonly StringBuilder _lineBuf = new StringBuilder();

        protected override void RegisterTypes()
        {
            RegisterTypeHint(ScadaVersion.HashRtMsg, "RuntimeManagerTimestampedMessage");
        }

        protected override void OnConnected()
        {
            // Identify as RuntimeManagerUI so the server routes kernel output to us.
            Thread.Sleep(300);
            SendProcessInfoChanged();
            DapTransport.Output("console", "Kernel output monitor connected.\n");
        }

        protected override void OnDisconnected()
        {
            base.OnDisconnected(); // signals _disconnected so RunLoop can retry
        }

        protected override void OnResetState()
        {
            _sentPicType = false;
            _lineBuf.Clear();
        }

        internal void RunLoop()
        {
            while (true)
            {
                try
                {
                    ConnectPipe(PIPE_NAME);
                    _disconnected.Wait();
                }
                catch (Exception ex)
                {
                    Logger.Ipc("RuntimeClient: " + ex.Message + " - retry in 10s");
                }
                for (int i = 0; i < 100; i++)
                    Thread.Sleep(100);
            }
        }

        protected override bool OnMessage(string typeName, byte[] buf, ref int off, int end)
        {
            if (!typeName.Contains("RuntimeManagerTimestampedMessage"))
            {
                Logger.Ipc(string.Format("RuntimeClient: unknown type {0}", typeName));
                return false;
            }

            // int64 Timestamp + int32 Type + int32 IntField + BinaryReader.ReadString()
            if (end - off < 17)
                return false;

            off += 8; // Timestamp (skip)
            int msgType = (int)LE32(buf, off);
            off += 4;
            off += 4; // IntField (skip)

            // BinaryReader.ReadString: 7-bit encoded length + UTF-8 bytes
            int strLen = 0,
                shift = 0;
            while (off < end)
            {
                byte b = buf[off++];
                strLen |= (b & 0x7F) << shift;
                shift += 7;
                if ((b & 0x80) == 0)
                    break;
            }
            if (strLen < 0 || off + strLen > end)
                return false;

            string text = strLen > 0 ? Encoding.UTF8.GetString(buf, off, strLen) : "";
            off += strLen;

            Logger.PaIn(string.Format("RT RtMsg type={0} textLen={1}", msgType, strLen));

            if (msgType == RT_MSG_DIAG_KER && text.Length > 0)
                BufferKernelOutput(text);

            return true;
        }

        void BufferKernelOutput(string text)
        {
            foreach (char c in text)
            {
                if (c == '\n')
                    FlushLine();
                else if (c != '\r' && c != '\0')
                    _lineBuf.Append(c);
            }
        }

        void FlushLine()
        {
            if (_lineBuf.Length == 0)
                return;
            string line = _lineBuf.ToString();
            _lineBuf.Clear();
            DapTransport.Output("stdout", line + "\n");
        }

        void SendProcessInfoChanged()
        {
            byte[] body = BuildProcessInfoBody();
            lock (SendLock)
            {
                uint seqId = NextSeqId();
                Logger.Ipc(
                    "RuntimeClient: sending ProcessInfoChangedMessage (ProcessToString=RuntimeManagerUI)"
                );
                SendFrameLocked(
                    seqId,
                    BuildMsgPayload(
                        ScadaVersion.HashProcessInfoChanged,
                        ScadaVersion.TnProcessInfoChanged,
                        ref _sentPicType,
                        body
                    )
                );
            }
        }

        static byte[] BuildProcessInfoBody()
        {
            int pid = System.Diagnostics.Process.GetCurrentProcess().Id;
            var ms = new MemoryStream(64);
            var bw = new BinaryWriter(ms);
            bw.Write(""); // CPUs
            bw.Write(pid); // ProcessId
            bw.Write("RuntimeManagerUI"); // ProcessToString
            bw.Write(0); // State
            bw.Write(false); // AttachedProcess
            bw.Write(""); // Message
            bw.Write(0); // Gas
            bw.Write(false); // SysAbortExit
            bw.Write(false); // ExceptionExit
            bw.Write(false); // AbnormalExit
            bw.Write(0L); // StartTime.Ticks
            bw.Write(false); // ProcessRunning
            bw.Write(false); // InDemoMode
            bw.Write(false); // ProcessIs64bit
            bw.Write(0); // numComponents
            bw.Flush();
            return ms.ToArray();
        }
    }
}
