using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace CicodeDebugAdapter
{
    static class CtApiClient
    {
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        static extern bool SetDllDirectory(string lpPathName);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr CreateEvent(
            IntPtr lpEventAttributes,
            bool bManualReset,
            bool bInitialState,
            IntPtr lpName
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("CtApi.dll", EntryPoint = "ctSetManagedBinDirectory", SetLastError = true)]
        static extern bool CtSetManagedBinDirectory(string path);

        [DllImport("CtApi.dll", EntryPoint = "ctOpen", SetLastError = true)]
        static extern IntPtr CtOpen(string computer, string user, string password, uint mode);

        // Overlapped form: result buffer and CTOVERLAPPED passed as raw unmanaged pointers.
        [DllImport("CtApi.dll", EntryPoint = "ctCicode", SetLastError = true)]
        static extern uint CtCicode(
            IntPtr hCTAPI,
            string sCmd,
            uint hWin,
            uint nMode,
            IntPtr sResult,
            int dwLength,
            IntPtr pctOverlapped
        );

        [DllImport("CtApi.dll", EntryPoint = "ctGetOverlappedResult", SetLastError = true)]
        static extern bool CtGetOverlappedResult(
            IntPtr hCTAPI,
            IntPtr lpctOverlapped,
            out uint lpBytes,
            bool bWait
        );

        // BOOL ctCancelIO(HANDLE hCTAPI, CTOVERLAPPED* pctOverlapped): a NULL overlapped would
        // cancel every pending call on the shared handle, so pass the one that timed out.
        [DllImport("CtApi.dll", EntryPoint = "ctCancelIO", SetLastError = true)]
        static extern bool CtCancelIO(IntPtr hCTAPI, IntPtr pctOverlapped);

        [DllImport("CtApi.dll", EntryPoint = "ctClose", SetLastError = true)]
        static extern bool CtClose(IntPtr hCTAPI);

        const int ERROR_IO_PENDING = 997;
        const uint WAIT_OBJECT_0 = 0x00000000u;
        const uint WAIT_TIMEOUT = 0x00000102u;
        const uint CallTimeoutMs = 5000u; // 5-second timeout per ctCicode call
        const uint CancelWaitMs = 1000u; // grace period after ctCancelIO
        const int ResultBufSize = 16384; // a result longer than the buffer fails the whole call
        const int OvlSize = 32;
        const int OvlHEventOfs = 16; // byte offset of hEvent field

        static IntPtr _handle = IntPtr.Zero;
        static readonly object _lock = new object();
        static int _inFlight; // native ctCicode calls currently running
        static int _abandonedOps; // overlapped ops abandoned still-pending (see leakBufs)
        static volatile bool _closing;

        /// <summary>
        /// Execute a Cicode expression and return the result string.
        /// Nested function calls in arguments are pre-evaluated automatically.
        /// Returns an empty string for void functions.
        /// Each ctCicode call has a 5-second timeout. Timed-out calls are cancelled via ctCancelIO.
        /// Throws if CtApi.dll is not found, ctOpen fails, or a ctCicode call fails / times out.
        /// </summary>
        public static string Execute(string expression)
        {
            // Increment before checking _closing so Close() either sees us in flight
            // or we see _closing set; never both miss.
            Interlocked.Increment(ref _inFlight);
            try
            {
                if (_closing)
                    throw new Exception("CTAPI connection is closing");

                // Only lock for the one-time handle setup; ctCiCode itself is thread-safe
                // so concurrent overlapped calls  proceed independently rather than queuing behind the stuck call.
                IntPtr handle;
                lock (_lock)
                {
                    EnsureOpen();
                    handle = _handle;
                }
                return Resolve(expression.Trim(), handle);
            }
            finally
            {
                Interlocked.Decrement(ref _inFlight);
            }
        }

        // Recursively resolve any nested function-call arguments, then call ctCicode.
        static string Resolve(string expr, IntPtr handle)
        {
            int parenOpen = IndexOfUnquoted(expr, '(');
            if (parenOpen < 0)
                return RawCall(expr, handle); // no parens at all. pass through as-is

            string funcName = expr.Substring(0, parenOpen).Trim();
            // Find matching close paren
            int parenClose = MatchingClose(expr, parenOpen);
            string argsStr = expr.Substring(parenOpen + 1, parenClose - parenOpen - 1).Trim();

            if (argsStr.Length == 0)
                return RawCall(expr, handle); // e.g. Time(). No arguments to resolve

            // Split args on top-level commas, resolve each one that is itself a call
            string[] args = SplitArgs(argsStr);
            bool anyResolved = false;
            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i].Trim();
                if (arg.Length > 0 && IndexOfUnquoted(arg, '(') >= 0)
                {
                    // Always quote the resolved result. Cicode will coerce the string to
                    // the expected type automagically :P.
                    // Cicode's string escape character is ^ (^" = literal quote, ^^ = caret).
                    // Double the carets first so those introduced for quotes aren't re-doubled.
                    string resolved = Resolve(arg, handle);
                    args[i] = "\"" + resolved.Replace("^", "^^").Replace("\"", "^\"") + "\"";
                    anyResolved = true;
                }
                else
                {
                    args[i] = arg;
                }
            }

            if (!anyResolved)
                return RawCall(expr, handle); // nothing nested: call original string unchanged

            // Rebuild with resolved args and call
            string rebuilt = funcName + "(" + string.Join(",", args) + ")";
            return RawCall(rebuilt, handle);
        }

        // Dispatch a single ctCicode call via CTOVERLAPPED with a 5-second timeout.
        // Unmanaged memory is used for the result buffer and CTOVERLAPPED struct so that
        // they remain valid even if the operation is still in-flight when we time out.
        static string RawCall(string expr, IntPtr handle)
        {
            IntPtr resultBuf = Marshal.AllocHGlobal(ResultBufSize);
            IntPtr ovlBuf = Marshal.AllocHGlobal(OvlSize);
            IntPtr hEvent = IntPtr.Zero;
            bool leakBufs = false; // set true when op is still in-flight on hard timeout

            try
            {
                for (int i = 0; i < ResultBufSize; i++)
                    Marshal.WriteByte(resultBuf, i, 0);
                for (int i = 0; i < OvlSize; i++)
                    Marshal.WriteByte(ovlBuf, i, 0);

                // Manual-reset event, initially non-signaled
                hEvent = CreateEvent(IntPtr.Zero, true, false, IntPtr.Zero);
                if (hEvent == IntPtr.Zero)
                    throw new Exception("CreateEvent failed: " + Marshal.GetLastWin32Error());

                Marshal.WriteIntPtr(ovlBuf, OvlHEventOfs, hEvent);

                uint ok = CtCicode(handle, expr, 0, 0, resultBuf, ResultBufSize, ovlBuf);

                if (ok == 0)
                {
                    int err = Marshal.GetLastWin32Error();
                    if (err != ERROR_IO_PENDING)
                        throw new Exception("ctCicode error " + err);

                    // Operation is pending
                    uint waitRes = WaitForSingleObject(hEvent, CallTimeoutMs);
                    if (waitRes == WAIT_TIMEOUT)
                    {
                        Logger.Warn("ctCicode timeout: " + expr);
                        CtCancelIO(handle, ovlBuf);
                        uint cancelWait = WaitForSingleObject(hEvent, CancelWaitMs);
                        if (cancelWait != WAIT_OBJECT_0)
                        {
                            Logger.Warn(
                                "ctCancelIO did not complete, buffers leaked to avoid use-after-free"
                            );
                            leakBufs = true; // native code still owns the buffers
                            Interlocked.Increment(ref _abandonedOps);
                        }
                        throw new Exception(
                            "ctCicode timed out after " + (CallTimeoutMs / 1000) + "s"
                        );
                    }
                }

                uint bytes;
                if (!CtGetOverlappedResult(handle, ovlBuf, out bytes, false))
                    throw new Exception(
                        "ctGetOverlappedResult error " + Marshal.GetLastWin32Error()
                    );

                return Marshal.PtrToStringAnsi(resultBuf) ?? "";
            }
            finally
            {
                // Do not touch handles / buffers if the native op is still running.
                if (!leakBufs)
                {
                    if (hEvent != IntPtr.Zero)
                        CloseHandle(hEvent);
                    Marshal.FreeHGlobal(ovlBuf);
                    Marshal.FreeHGlobal(resultBuf);
                }
            }
        }

        // Split a comma-separated argument list, respecting nested parens and quoted strings.
        static string[] SplitArgs(string argsStr)
        {
            var parts = new List<string>();
            int depth = 0;
            bool inStr = false;
            int start = 0;
            for (int i = 0; i < argsStr.Length; i++)
            {
                char c = argsStr[i];
                if (inStr && c == '^')
                {
                    i++; // Cicode escape (^" ^^ ...): the next char never ends the string
                    continue;
                }
                if (c == '"')
                    inStr = !inStr;
                if (!inStr)
                {
                    if (c == '(')
                        depth++;
                    else if (c == ')')
                        depth--;
                    else if (c == ',' && depth == 0)
                    {
                        parts.Add(argsStr.Substring(start, i - start));
                        start = i + 1;
                    }
                }
            }
            parts.Add(argsStr.Substring(start));
            return parts.ToArray();
        }

        // Find the first occurrence of ch that is not inside a double-quoted string.
        static int IndexOfUnquoted(string s, char ch)
        {
            bool inStr = false;
            for (int i = 0; i < s.Length; i++)
            {
                if (inStr && s[i] == '^')
                {
                    i++;
                    continue;
                }
                if (s[i] == '"')
                    inStr = !inStr;
                if (!inStr && s[i] == ch)
                    return i;
            }
            return -1;
        }

        // Find the closing ')' that matches the '(' at openIdx.
        static int MatchingClose(string s, int openIdx)
        {
            int depth = 0;
            bool inStr = false;
            for (int i = openIdx; i < s.Length; i++)
            {
                if (inStr && s[i] == '^')
                {
                    i++;
                    continue;
                }
                if (s[i] == '"')
                    inStr = !inStr;
                if (!inStr)
                {
                    if (s[i] == '(')
                        depth++;
                    else if (s[i] == ')')
                    {
                        depth--;
                        if (depth == 0)
                            return i;
                    }
                }
            }
            return s.Length - 1; // malformed. Best effort
        }

        static void EnsureOpen()
        {
            if (_handle != IntPtr.Zero)
                return;

            string binFolder = ScadaVersion.BinFolder;
            if (binFolder == null)
                throw new Exception("Plant SCADA not found in registry - cannot locate CtApi.dll");

            string ctApiPath = Path.Combine(binFolder, "CtApi.dll");
            if (!File.Exists(ctApiPath))
                throw new Exception("CtApi.dll not found at: " + ctApiPath);

            SetDllDirectory(binFolder);
            CtSetManagedBinDirectory(binFolder);

            try
            {
                _handle = CtOpen(null, null, null, 0);
            }
            catch (DllNotFoundException)
            {
                throw new Exception("Failed to load CtApi.dll from: " + ctApiPath);
            }
            if (_handle == IntPtr.Zero)
                throw new Exception("ctOpen failed: error " + Marshal.GetLastWin32Error());
        }

        /// <summary>Close the CTAPI connection. Called when the debug session ends.</summary>
        public static void Close()
        {
            _closing = true;
            try
            {
                // Wait (bounded) for in-flight ctCicode calls so we never CtClose a handle
                // another thread is still using inside a native call.
                for (
                    int i = 0;
                    i < 200 && Interlocked.CompareExchange(ref _inFlight, 0, 0) != 0;
                    i++
                )
                    Thread.Sleep(10);
                // Never CtClose while native code can still touch the session: a straggling
                // RawCall may yet call CtCancelIO/CtGetOverlappedResult on the handle, and an
                // abandoned overlapped op (leakBufs) still owns it inside CtApi.dll. Leak the
                // handle instead; the process exits right after disconnect anyway.
                bool unsafeToClose =
                    Interlocked.CompareExchange(ref _inFlight, 0, 0) != 0
                    || Interlocked.CompareExchange(ref _abandonedOps, 0, 0) != 0;
                if (unsafeToClose)
                    Logger.Warn(
                        "CtApiClient.Close: native call still in flight, leaking CTAPI handle to avoid use-after-free"
                    );

                // Use a timeout so a stuck ctCiCode call on another thread does not block disconnect.
                if (!Monitor.TryEnter(_lock, 3000))
                    return;
                try
                {
                    if (_handle == IntPtr.Zero)
                        return;
                    if (!unsafeToClose)
                    {
                        try
                        {
                            CtClose(_handle);
                        }
                        catch { }
                    }
                    _handle = IntPtr.Zero;
                }
                finally
                {
                    Monitor.Exit(_lock);
                }
            }
            finally
            {
                _closing = false;
            }
        }
    }
}
