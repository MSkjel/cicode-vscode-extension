using System;
using System.Diagnostics;
using System.IO;

namespace CicodeDebugAdapter
{
    /// <summary>
    /// Structured logger with named channels. Call the channel method directly.
    /// No bracket strings in call sites. All output goes to stderr + cicode-dap.log.
    ///
    /// Build with /define:VERBOSE to enable all channels.
    /// Release builds only write WRN entries.
    /// </summary>
    static class Logger
    {
        static StreamWriter _file;
        static readonly object _lock = new object();

        // [Conditional("VERBOSE")] strips the calls, including argument evaluation
        // (string.Format/concat on hot reader paths), from release builds entirely.
        [Conditional("VERBOSE")]
        public static void Dap(string s)
        {
            WriteVerbose("DAP ", s);
        }

        [Conditional("VERBOSE")]
        public static void DapIn(string s)
        {
            WriteVerbose("DAP<", s);
        }

        [Conditional("VERBOSE")]
        public static void DapOut(string s)
        {
            WriteVerbose("DAP>", s);
        }

        [Conditional("VERBOSE")]
        public static void Hdr(string s)
        {
            WriteVerbose("HDR ", s);
        }

        [Conditional("VERBOSE")]
        public static void Raw(string s)
        {
            WriteVerbose("RAW ", s);
        }

        [Conditional("VERBOSE")]
        public static void Ipc(string s)
        {
            WriteVerbose("IPC ", s);
        }

        [Conditional("VERBOSE")]
        public static void Pa(string s)
        {
            WriteVerbose("PA  ", s);
        }

        [Conditional("VERBOSE")]
        public static void PaIn(string s)
        {
            WriteVerbose("PA< ", s);
        }

        [Conditional("VERBOSE")]
        public static void PaOut(string s)
        {
            WriteVerbose("PA> ", s);
        }

        [Conditional("VERBOSE")]
        public static void Reader(string s)
        {
            WriteVerbose("RDR ", s);
        }

        [Conditional("VERBOSE")]
        public static void Scada(string s)
        {
            WriteVerbose("VER ", s);
        }

        public static void Warn(string s)
        {
            Write("WRN ", s);
        } // always on

        public static void Open(string path)
        {
#if VERBOSE
            lock (_lock)
            {
                try
                {
                    if (_file != null)
                        _file.Close();
                }
                catch { }
                var sw = new StreamWriter(path, false);
                sw.AutoFlush = true;
                _file = sw;
            }
#endif
        }

        public static void Close()
        {
            lock (_lock)
            {
                try
                {
                    if (_file != null)
                        _file.Close();
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("Logger close failed: " + ex.Message);
                }
                _file = null;
            }
        }

        static void WriteVerbose(string tag, string s)
        {
#if VERBOSE
            Write(tag, s);
#endif
        }

        static void Write(string tag, string s)
        {
            string line = string.Format(
                "[{0}] [{1}] {2}",
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff"),
                tag,
                s
            );
            lock (_lock)
            {
                try
                {
                    Console.Error.WriteLine(line);
                }
                catch { }
                try
                {
                    if (_file != null)
                        _file.WriteLine(line);
                }
                catch { }
            }
        }
    }
}
