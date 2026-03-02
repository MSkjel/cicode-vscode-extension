// Cicode Debug Adapter. entry point + DAP stdin/stdout loop.
// VS Code communicates via stdin/stdout; logging goes to stderr + cicode-dap.log.
using System;
using System.IO;
using System.Text;

namespace CicodeDebugAdapter
{
    static class Program
    {
        static void Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            DapState.Stdout = Console.OpenStandardOutput();

            string logPath = Path.Combine(
                Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location)
                    ?? ".",
                "cicode-dap.log"
            );
            try
            {
                Logger.Open(logPath);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("Failed to open log file: " + ex.Message);
            }

            Logger.Dap(
                "Cicode Debug Adapter starting (pid="
                    + System.Diagnostics.Process.GetCurrentProcess().Id
                    + ")"
            );

            IpcClient.InitCrc();
            ScadaVersion.Init();
            RuntimeClient.Start();

            var stdin = Console.OpenStandardInput();
            var stdinBuf = new byte[65536];
            int stdinOff = 0;

            while (true)
            {
                int contentLen = -1;
                int headerEnd = -1;

                while (true)
                {
                    // Scan for \r\n\r\n or \n\n header terminator
                    for (int i = 0; i <= stdinOff - 2; i++)
                    {
                        if (
                            stdinBuf[i] == '\r'
                            && stdinBuf[i + 1] == '\n'
                            && i + 3 < stdinOff
                            && stdinBuf[i + 2] == '\r'
                            && stdinBuf[i + 3] == '\n'
                        )
                        {
                            headerEnd = i + 4;
                            break;
                        }
                        if (stdinBuf[i] == '\n' && i + 1 < stdinOff && stdinBuf[i + 1] == '\n')
                        {
                            headerEnd = i + 2;
                            break;
                        }
                    }
                    if (headerEnd >= 0)
                        break;

                    if (stdinOff >= stdinBuf.Length)
                    {
                        if (stdinBuf.Length >= 10 * 1024 * 1024)
                        {
                            Logger.Warn("stdin header block exceeds 10 MB. aborting");
                            goto done;
                        }
                        var nb = new byte[stdinBuf.Length * 2];
                        Array.Copy(stdinBuf, 0, nb, 0, stdinOff);
                        stdinBuf = nb;
                    }
                    int nr = stdin.Read(stdinBuf, stdinOff, stdinBuf.Length - stdinOff);
                    if (nr == 0)
                    {
                        Logger.Dap("stdin EOF reading headers");
                        goto done;
                    }
                    stdinOff += nr;
                }

                string headerBlock = Encoding.ASCII.GetString(stdinBuf, 0, headerEnd);
                foreach (
                    string hline in headerBlock.Split(
                        new char[] { '\r', '\n' },
                        StringSplitOptions.RemoveEmptyEntries
                    )
                )
                {
                    Logger.Hdr(hline);
                    if (hline.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
                    {
                        if (!int.TryParse(hline.Substring(15).Trim(), out contentLen))
                        {
                            Logger.Warn("Malformed Content-Length: " + hline);
                            contentLen = -1;
                        }
                    }
                }
                Array.Copy(stdinBuf, headerEnd, stdinBuf, 0, stdinOff - headerEnd);
                stdinOff -= headerEnd;

                if (contentLen < 0)
                {
                    Logger.Dap("no Content-Length, skipping");
                    continue;
                }
                if (contentLen > 10 * 1024 * 1024)
                {
                    Logger.Warn("Content-Length " + contentLen + " exceeds 10 MB. aborting");
                    goto done;
                }

                while (stdinOff < contentLen)
                {
                    if (stdinOff + contentLen > stdinBuf.Length)
                    {
                        var nb = new byte[stdinOff + contentLen + 4096];
                        Array.Copy(stdinBuf, 0, nb, 0, stdinOff);
                        stdinBuf = nb;
                    }
                    int nb2 = stdin.Read(stdinBuf, stdinOff, contentLen - stdinOff);
                    if (nb2 == 0)
                    {
                        Logger.Dap("stdin EOF reading body");
                        goto done;
                    }
                    stdinOff += nb2;
                }

                string json = Encoding.UTF8.GetString(stdinBuf, 0, contentLen);
                Array.Copy(stdinBuf, contentLen, stdinBuf, 0, stdinOff - contentLen);
                stdinOff -= contentLen;

                Logger.Raw(json.Length > 400 ? json.Substring(0, 400) + "..." : json);
                try
                {
                    DapHandlers.HandleRequest(json);
                }
                catch (Exception ex)
                {
                    Logger.Dap("HandleRequest error: " + ex);
                }
            }

            done:
            Logger.Dap("stdin closed. exiting");
            Logger.Close();
        }
    }
}
