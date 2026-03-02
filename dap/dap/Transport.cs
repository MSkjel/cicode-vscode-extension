using System.Text;
using System.Threading;

namespace CicodeDebugAdapter
{
    /// <summary>
    /// DAP stdout framing: Content-Length header + JSON body, sent to VS Code.
    /// Guarded via DapState.StdoutLock.
    /// </summary>
    static class DapTransport
    {
        public static void Send(string json)
        {
            Logger.DapOut(json.Length > 200 ? json.Substring(0, 200) + "..." : json);
            var body = Encoding.UTF8.GetBytes(json);
            var header = Encoding.ASCII.GetBytes("Content-Length: " + body.Length + "\r\n\r\n");
            lock (DapState.StdoutLock)
            {
                DapState.Stdout.Write(header, 0, header.Length);
                DapState.Stdout.Write(body, 0, body.Length);
                DapState.Stdout.Flush();
            }
        }

        public static void Response(
            int reqSeq,
            string cmd,
            bool ok,
            string body = null,
            string msg = null
        )
        {
            int seq = Interlocked.Increment(ref DapState.Seq);
            var sb = new StringBuilder();
            sb.Append("{\"seq\":")
                .Append(seq)
                .Append(",\"type\":\"response\",\"request_seq\":")
                .Append(reqSeq)
                .Append(",\"success\":")
                .Append(ok ? "true" : "false")
                .Append(",\"command\":")
                .Append(Json.Str(cmd));
            if (msg != null)
                sb.Append(",\"message\":").Append(Json.Str(msg));
            sb.Append(",\"body\":").Append(body ?? "{}").Append("}");
            Send(sb.ToString());
        }

        public static void Event(string evtName, string body = null)
        {
            int seq = Interlocked.Increment(ref DapState.Seq);
            var sb = new StringBuilder();
            sb.Append("{\"seq\":")
                .Append(seq)
                .Append(",\"type\":\"event\",\"event\":")
                .Append(Json.Str(evtName))
                .Append(",\"body\":")
                .Append(body ?? "{}")
                .Append("}");
            Send(sb.ToString());
        }

        public static void Output(string category, string text)
        {
            Event(
                "output",
                "{\"category\":" + Json.Str(category) + ",\"output\":" + Json.Str(text) + "}"
            );
        }
    }
}
