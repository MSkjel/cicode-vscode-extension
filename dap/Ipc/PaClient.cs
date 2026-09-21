using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;

namespace CicodeDebugAdapter
{
    /// <summary>
    /// Shared base for all PacketAdapter v2.2 named-pipe clients.
    /// Handles CRC32, framing, 3-phase handshake, heartbeat thread, reader thread,
    /// type-name caching, and ACK sending.  Subclasses override OnMessage() to
    /// handle application-level message types and OnConnected()/OnDisconnected()
    /// for lifecycle hooks.
    /// </summary>
    abstract class PaClient
    {
        // PA framing constants
        const uint PA_SEED = 0x7DB49658u;
        const uint PA_POLY = 0xEDB88320u;
        const uint PA_MARKER = 0xFFFF0201u;
        const int PA_HDRLEN = 16;

        // IdentifyMessage (Phase 3)
        const int TYPE_HASH_V100 = unchecked((int)0xCC314E6B);
        const string TYPE_NAME_IDENTIFY =
            "Citect.Platform.Net.Message.IdentifyMessage, "
            + "Citect.Platform.Net.Message, Version=1.0.0.0, "
            + "Culture=neutral, PublicKeyToken=13aaee2494f61799";
        const int SERVICE_ID = unchecked((int)0x7DD2111F);
        const short PROTO_VER = 0x0202;
        const int HDR_LEN = 20;

        uint[] _crcTable;

        protected NamedPipeClientStream _pipe;
        internal volatile bool Stopping;

        // True only between a completed handshake and the next ConnectPipe/disconnect.
        // Gates SendFrameLocked so heartbeat/ThreadPool senders can never write into
        // a new connection's raw handshake bytes.
        volatile bool _sendReady;
        protected readonly object SendLock = new object();

        // Incremented per ConnectPipe. Reader/heartbeat threads capture it at start;
        // a thread whose generation is stale must not touch state or report disconnect.
        int _generation;

        uint _outSeqId;
        uint _recvSeqId;
        uint _ackedSeqId;

        bool _sentHbType;
        bool _sentAckType;

        readonly HashSet<uint> _recvTypeHashes = new HashSet<uint>();
        readonly Dictionary<uint, string> _recvTypeNames = new Dictionary<uint, string>();

        // Signaled by OnDisconnected so a reconnect loop can wait.
        protected readonly ManualResetEventSlim _disconnected = new ManualResetEventSlim(false);

        protected PaClient()
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

        // PipeOptions for the main pipe. Asynchronous by default so a Close() during
        // a pending BeginRead (ReadExact timeout) cancels the overlapped read instead
        // of stranding a thread-pool thread blocked in ReadFile. Synchronous Read()
        // in ReaderLoop works fine on an Asynchronous handle.
        protected virtual PipeOptions PipeOptions
        {
            get { return PipeOptions.Asynchronous; }
        }

        // Override to seed extra type-name hints into _recvTypeNames before reading starts.
        protected virtual void RegisterTypes() { }

        // Called from RegisterTypes() to pre-seed the receive-type name cache.
        protected void RegisterTypeHint(uint hash, string name)
        {
            _recvTypeNames[hash] = name;
        }

        // Called after handshake, before the reader/heartbeat threads start.
        protected virtual void OnConnected() { }

        // Called when the reader thread exits. Default signals _disconnected.
        protected virtual void OnDisconnected()
        {
            _disconnected.Set();
        }

        // Called when resetting per-connection state; subclass resets its own send-type bools.
        protected virtual void OnResetState() { }

        // Must return true with off advanced past the body, or false to stop parsing the frame.
        // off is positioned immediately after the hash (and type-name if first occurrence).
        protected abstract bool OnMessage(string typeName, byte[] buf, ref int off, int end);

        protected void ConnectPipe(string pipeName)
        {
            _sendReady = false;
            Interlocked.Increment(ref _generation);
            ResetState();
            _disconnected.Reset();

            _pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions);
            _pipe.Connect(5000);
            Logger.Ipc(GetType().Name + ": connected to " + pipeName);

            NamedPipeServerStream cbPipe = null;
            try
            {
                // Phase 1: cipher suite {CanSecure, MustSecure}. We offer no encryption, so a
                // server that requires it would drop the connection later.
                PipeWrite(new byte[] { 0x00, 0x00 });
                var suite = new byte[2];
                ReadExact(_pipe, suite, 2, 3000);
                Logger.Ipc(GetType().Name + ": server cipher suite " + suite[0] + "," + suite[1]);
                if (suite[1] != 0)
                    throw new Exception(
                        "The runtime requires an encrypted IPC connection, which this debugger does not support."
                    );

                // Phase 2: GUID security challenge/response via callback pipe
                var guid = Guid.NewGuid();
                cbPipe = new NamedPipeServerStream(
                    guid.ToString(),
                    PipeDirection.InOut,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous
                );
                PipeWrite(guid.ToByteArray());
                var iac = cbPipe.BeginWaitForConnection(null, null);
                if (!iac.AsyncWaitHandle.WaitOne(5000))
                    throw new Exception("GUID callback pipe timeout");
                cbPipe.EndWaitForConnection(iac);
                try
                {
                    ReadExact(cbPipe, new byte[16], 16, 3000);
                }
                catch { }
                cbPipe.Close();

                // Phase 3: IdentifyMessage. The server echoes it back; a timeout in
                // ReadExact disposes _pipe, so failure here must abort the handshake
                // rather than be swallowed (we would otherwise ride a closed pipe).
                byte[] identify = BuildIdentifyMessage();
                PipeWrite(identify);
                ReadExact(_pipe, new byte[identify.Length], identify.Length, 5000);
            }
            catch
            {
                try
                {
                    if (cbPipe != null)
                        cbPipe.Close();
                }
                catch { }
                try
                {
                    _pipe.Close();
                }
                catch { }
                throw;
            }
            Logger.Ipc(GetType().Name + ": handshake done");
            _sendReady = true;

            _recvTypeNames[ScadaVersion.HashHb] = "HeartbeatMessage";
            _recvTypeNames[ScadaVersion.HashAck] = "AcknowledgementMessage";
            RegisterTypes();

            OnConnected();
            StartThreads();
        }

        void ResetState()
        {
            lock (SendLock)
            {
                _outSeqId = 0;
                _recvSeqId = 0;
                _ackedSeqId = 0;
            }
            _sentHbType = false;
            _sentAckType = false;
            _recvTypeHashes.Clear();
            _recvTypeNames.Clear();
            OnResetState();
        }

        int CurrentGeneration
        {
            get { return Interlocked.CompareExchange(ref _generation, 0, 0); }
        }

        void StartThreads()
        {
            int gen = CurrentGeneration;
            var pipe = _pipe;

            // The server restarts the transport after 15 s without traffic; it sends a heartbeat
            // every 5 s, so do we.
            new Thread(() =>
            {
                Thread.Sleep(1000);
                while (!Stopping && gen == CurrentGeneration && !_disconnected.IsSet)
                {
                    try
                    {
                        SendHeartbeat();
                    }
                    catch (Exception ex)
                    {
                        // Transient failures must not end the heartbeat for a live connection;
                        // a dead pipe ends the reader, which ends this loop.
                        Logger.Reader(GetType().Name + ": heartbeat failed: " + ex.Message);
                    }
                    for (
                        int i = 0;
                        i < 50 && !Stopping && gen == CurrentGeneration && !_disconnected.IsSet;
                        i++
                    )
                        Thread.Sleep(100);
                }
            })
            {
                IsBackground = true,
            }.Start();

            new Thread(() => ReaderLoop(pipe, gen)) { IsBackground = true }.Start();
        }

        void ReaderLoop(NamedPipeClientStream pipe, int gen)
        {
            var recvBuf = new byte[65536];
            int recvOff = 0;
            var readBuf = new byte[4096];
            bool fatal = false;

            while (!Stopping && !fatal)
            {
                int n;
                try
                {
                    n = pipe.Read(readBuf, 0, readBuf.Length);
                }
                catch (Exception ex)
                {
                    Logger.Reader(GetType().Name + ": " + ex.Message);
                    break;
                }
                if (n == 0)
                {
                    Logger.Reader(GetType().Name + ": EOF");
                    break;
                }

                if (recvOff + n > recvBuf.Length)
                {
                    var nb = new byte[Math.Max(recvBuf.Length * 2, recvOff + n)];
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
                    if (payloadLen < 0 || payloadLen > 4 * 1024 * 1024)
                    {
                        consumed++;
                        continue;
                    }
                    if (recvOff - consumed < PA_HDRLEN + payloadLen)
                        break;

                    uint crc = CrcCompute(PA_SEED, recvBuf, consumed + PA_HDRLEN, payloadLen);
                    crc = CrcCompute(crc, recvBuf, consumed, 12);
                    bool crcOk = crc == LE32(recvBuf, consumed + 12);
                    Logger.Pa(
                        string.Format(
                            "{0} frame seqId={1} payloadLen={2} CRC={3}",
                            GetType().Name,
                            frameSeq,
                            payloadLen,
                            crcOk ? "OK" : "ERR"
                        )
                    );
                    if (!crcOk)
                    {
                        // The server computes the CRC the same way, so a mismatch means a corrupt
                        // frame.
                        Logger.Warn(
                            GetType().Name + ": CRC mismatch, frame seq=" + frameSeq + " len=" + payloadLen + " skipped"
                        );
                        consumed += PA_HDRLEN + payloadLen;
                        continue;
                    }

                    if (gen != CurrentGeneration)
                    {
                        fatal = true;
                        break;
                    }
                    try
                    {
                        ParseFramePayload(recvBuf, consumed + PA_HDRLEN, payloadLen, frameSeq);
                    }
                    catch (Exception ex)
                    {
                        // A malformed frame is skipped; one bad frame must not end the session.
                        Logger.Warn(GetType().Name + ": frame seq=" + frameSeq + " dispatch error: " + ex);
                    }
                    consumed += PA_HDRLEN + payloadLen;
                }

                if (consumed > 0)
                {
                    Array.Copy(recvBuf, consumed, recvBuf, 0, recvOff - consumed);
                    recvOff -= consumed;
                }
            }

            Logger.Reader(GetType().Name + ": exited");
            if (gen != CurrentGeneration)
            {
                Logger.Reader(GetType().Name + ": stale reader, skipping disconnect");
                return;
            }
            OnDisconnected();
        }

        void ParseFramePayload(byte[] buf, int start, int len, uint frameSeqId)
        {
            int off = start;
            int end = start + len;
            // Every non-ACK message in a frame consumes one sequence id, starting at the frame's
            // seqId; type declarations and ACKs do not.
            uint messages = 0;
            bool complete = true;

            while (off < end)
            {
                bool isAck;
                if (!ParseOneMessage(buf, ref off, end, out isAck))
                {
                    complete = false;
                    break;
                }
                if (!isAck)
                    messages++;
            }
            if (!complete && messages == 0)
                messages = 1; // unparseable first message: still acknowledge the frame

            if (messages > 0 && frameSeqId > 0)
            {
                _recvSeqId = frameSeqId + messages - 1;
                try
                {
                    SendAck(_recvSeqId);
                }
                catch { }
            }
        }

        bool ParseOneMessage(byte[] buf, ref int off, int end, out bool isAck)
        {
            isAck = false;
            if (end - off < 4)
                return false;
            uint hash = LE32(buf, off);
            off += 4;

            if (!_recvTypeHashes.Contains(hash))
            {
                // First use of a type: its name follows. This declaration is not a message.
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
                _recvTypeNames[hash] = Encoding.UTF8.GetString(buf, off, byteLen);
                off += byteLen;
                _recvTypeHashes.Add(hash);
                if (end - off < 4)
                    return false;
                off += 4;
            }

            string typeName;
            if (!_recvTypeNames.TryGetValue(hash, out typeName))
                typeName = "";
            Logger.PaIn(
                string.Format(
                    "{0} msg hash=0x{1:X8} type={2}",
                    GetType().Name,
                    hash,
                    typeName.Length > 0 ? typeName : "?"
                )
            );

            if (typeName.Contains("HeartbeatMessage"))
                return true;
            if (typeName.Contains("AcknowledgementMessage"))
            {
                isAck = true;
                if (end - off < 4)
                    return false;
                off += 4;
                return true;
            }
            return OnMessage(typeName, buf, ref off, end);
        }

        void SendHeartbeat()
        {
            lock (SendLock)
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

        void SendAck(uint ackSeqId)
        {
            lock (SendLock)
            {
                if (ackSeqId == _ackedSeqId)
                    return;
                _ackedSeqId = ackSeqId;
                SendFrameLocked(
                    0,
                    BuildMsgPayload(
                        ScadaVersion.HashAck,
                        ScadaVersion.TnAck,
                        ref _sentAckType,
                        BitConverter.GetBytes(ackSeqId)
                    )
                );
            }
        }

        // Increments _outSeqId and sends. Caller must hold SendLock.
        protected uint NextSeqId()
        {
            _outSeqId++;
            if (_outSeqId == 0)
                _outSeqId = 1;
            return _outSeqId;
        }

        protected void SendFrameLocked(uint seqId, byte[] payload)
        {
            var frame = new byte[PA_HDRLEN + payload.Length];
            frame[0] = 0x01;
            frame[1] = 0x02;
            frame[2] = 0xFF;
            frame[3] = 0xFF;
            WriteLE32(frame, 4, seqId);
            WriteLE32(frame, 8, (uint)payload.Length);
            Array.Copy(payload, 0, frame, PA_HDRLEN, payload.Length);
            uint crc = CrcCompute(PA_SEED, frame, PA_HDRLEN, payload.Length);
            crc = CrcCompute(crc, frame, 0, 12);
            WriteLE32(frame, 12, crc);
            _pipe.Write(frame, 0, frame.Length);
            _pipe.Flush();
        }

        protected byte[] BuildMsgPayload(
            uint hash,
            string typeName,
            ref bool alreadySent,
            byte[] body
        )
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

        protected static byte[] EncodeString(string s)
        {
            byte[] utf8 = Encoding.UTF8.GetBytes(s);
            var result = new List<byte>();
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

        byte[] BuildIdentifyMessage()
        {
            byte[] tnUtf8 = Encoding.UTF8.GetBytes(TYPE_NAME_IDENTIFY);
            byte[] tnEnc = new byte[tnUtf8.Length + 2];
            tnEnc[0] = (byte)((tnUtf8.Length & 0x7F) | 0x80);
            tnEnc[1] = (byte)(tnUtf8.Length >> 7);
            Array.Copy(tnUtf8, 0, tnEnc, 2, tnUtf8.Length);

            int payloadLen = 4 + 4 + tnEnc.Length + 14;
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
                bw.Write(tnEnc, 0, tnEnc.Length);
                bw.Write(SERVICE_ID);
                bw.Write((int)0);
                bw.Write((short)0);
                bw.Write(ScadaVersion.MsgVersion);
                bw.Write(PROTO_VER);
                bw.Flush();
            }
            return ms.ToArray();
        }

        protected void PipeWrite(byte[] data)
        {
            _pipe.Write(data, 0, data.Length);
            _pipe.Flush();
        }

        protected static int ReadExact(Stream s, byte[] buf, int n, int timeoutMs)
        {
            int got = 0;
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (got < n)
            {
                int remaining = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                if (remaining <= 0)
                    throw new TimeoutException("ReadExact timeout (got " + got + "/" + n + ")");
                IAsyncResult ar = s.BeginRead(buf, got, n - got, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(remaining))
                {
                    // Close so the pending read completes instead of blocking forever.
                    try
                    {
                        s.Close();
                    }
                    catch { }
                    throw new TimeoutException("ReadExact timeout (got " + got + "/" + n + ")");
                }
                int r = s.EndRead(ar);
                if (r == 0)
                    throw new EndOfStreamException("EOF");
                got += r;
            }
            return got;
        }

        protected static uint LE32(byte[] b, int o)
        {
            return (uint)(b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24));
        }

        protected static void WriteLE32(byte[] b, int o, uint v)
        {
            b[o] = (byte)v;
            b[o + 1] = (byte)(v >> 8);
            b[o + 2] = (byte)(v >> 16);
            b[o + 3] = (byte)(v >> 24);
        }

        uint CrcCompute(uint crc, byte[] buf, int start, int len)
        {
            for (int i = start; i < start + len; i++)
                crc = (crc >> 8) ^ _crcTable[(buf[i] ^ crc) & 0xFF];
            return crc;
        }
    }
}
