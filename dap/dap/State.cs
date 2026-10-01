using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;

namespace CicodeDebugAdapter
{
    /// <summary>One entry in the Cicode call stack as reported by the runtime.</summary>
    class CicodeFrame
    {
        public string Name;       // function name parsed from call signature
        public string CallText;   // raw "FuncName(arg1, arg2, ...);" line
        public List<string> Args = new List<string>();   // raw arg values parsed from call
        public Dictionary<string, string> Locals = new Dictionary<string, string>();
    }

    /// <summary>
    /// All shared DAP session state.  Accessed from both the DAP handlers (main thread)
    /// and the IPC reader thread. Locking is done at the call sites.
    /// </summary>
    static class DapState
    {
        public static int Seq = 0;

        public static bool Attached = false;
        public static bool ConfigDone = false;
        public static volatile bool StripQualityTags = true; // written main, read reader

        // Exception filter "hardwareError": true = stop on Cicode hardware errors,
        // false = only log them to the Debug Console and let the task continue.
        public static volatile bool BreakOnHardwareErrors = true;

        /// <summary>A Cicode hardware error a thread is currently stopped on.</summary>
        public class ErrorInfo
        {
            public int Code;
            public string Text;      // "Thread N Hardware error (code) 'msg' ErrPage: .. ErrDesc: .."
            public string Message;   // 'msg'
            public string ErrPage;   // the Cicode function that raised it (e.g. TagRead)
            public string ErrDesc;   // the user function it happened in
            public string Detail;    // 0x100E text
            public string File;
            public int Line;         // the failing statement
            public int PauseLine;    // where the task is actually suspended (next statement)
        }

        public static readonly HashSet<int> Threads = new HashSet<int>();
        public static readonly Dictionary<int, string> ThreadFile = new Dictionary<int, string>();
        public static readonly Dictionary<int, int> ThreadLine = new Dictionary<int, int>();
        public static readonly HashSet<int> PausedThreads = new HashSet<int>(); // suspended, shown as stopped
        public static readonly Dictionary<int, ErrorInfo> ThreadErrors = new Dictionary<int, ErrorInfo>();
        public static volatile int SteppingThread = -1; // written main+reader

        // Breakpoints + thread location: key = normalised lower-case path
        public static readonly Dictionary<string, List<int>> PendingBps =
            new Dictionary<string, List<int>>();
        public static readonly Dictionary<string, string> BpPaths =
            new Dictionary<string, string>();
        public static readonly Dictionary<string, Dictionary<int, string>> BpConditions =
            new Dictionary<string, Dictionary<int, string>>();
        // guards Threads, ThreadFile, ThreadLine, PausedThreads, ThreadErrors, PendingBps, BpPaths, BpConditions
        public static readonly object SessionLock = new object();

        public static readonly Dictionary<string, string> StepWatchVars =
            new Dictionary<string, string>();
        // Per-thread call stacks from EVT_LOCALS_LIVE, keyed by Cicode thread id.
        // Index 0 = innermost (currently executing) frame, last = outermost.
        public static readonly Dictionary<int, List<CicodeFrame>> FramesByThread =
            new Dictionary<int, List<CicodeFrame>>();
        // Threads whose locals request is still outstanding. Guarded by VarsLock;
        // waiters Monitor.Wait on VarsLock.
        static readonly HashSet<int> LocalsPending = new HashSet<int>();
        public static volatile bool StepWatchPending = false;

        // Signaled when the step-watch response arrives; Reset() before sending the request.
        public static readonly ManualResetEventSlim StepWatchReady = new ManualResetEventSlim(true);
        public static readonly object VarsLock = new object();

        public static Stream Stdout;
        public static readonly object StdoutLock = new object();

        public static bool IsStopped
        {
            get
            {
                lock (SessionLock)
                    return PausedThreads.Count > 0;
            }
        }

        public static bool IsThreadPaused(int tid)
        {
            lock (SessionLock)
                return PausedThreads.Contains(tid);
        }

        /// <summary>Record a thread's current source location (thread-safe).</summary>
        public static void SetThreadLocation(int tid, string file, int line)
        {
            lock (SessionLock)
            {
                Threads.Add(tid);
                ThreadFile[tid] = file;
                ThreadLine[tid] = line;
            }
        }

        /// <summary>Read a thread's source location. Returns false if unknown.</summary>
        public static bool TryGetThreadLocation(int tid, out string file, out int line)
        {
            lock (SessionLock)
            {
                if (ThreadFile.ContainsKey(tid))
                {
                    file = ThreadFile[tid];
                    line = ThreadLine[tid];
                    return true;
                }
            }
            file = null;
            line = 0;
            return false;
        }

        public static void MarkPaused(int tid)
        {
            lock (SessionLock)
            {
                Threads.Add(tid);
                PausedThreads.Add(tid);
            }
        }

        /// <summary>The thread was resumed (step, single-thread resume).</summary>
        public static void MarkRunning(int tid)
        {
            lock (SessionLock)
            {
                PausedThreads.Remove(tid);
                ThreadErrors.Remove(tid);
            }
            lock (VarsLock)
                FramesByThread.Remove(tid);
        }

        /// <summary>All threads were resumed (CONTINUE_ALL).</summary>
        public static void ClearPaused()
        {
            lock (SessionLock)
            {
                PausedThreads.Clear();
                ThreadErrors.Clear();
                Threads.Clear();
                ThreadFile.Clear();
                ThreadLine.Clear();
            }
            lock (VarsLock)
                FramesByThread.Clear();
        }

        /// <summary>The thread no longer exists in the runtime.</summary>
        public static void RemoveThread(int tid)
        {
            lock (SessionLock)
            {
                PausedThreads.Remove(tid);
                ThreadErrors.Remove(tid);
                Threads.Remove(tid);
                ThreadFile.Remove(tid);
                ThreadLine.Remove(tid);
            }
            lock (VarsLock)
            {
                FramesByThread.Remove(tid);
                if (LocalsPending.Remove(tid))
                    Monitor.PulseAll(VarsLock);
            }
        }

        public static void SetErrorInfo(int tid, ErrorInfo info)
        {
            lock (SessionLock)
                ThreadErrors[tid] = info;
        }

        public static ErrorInfo GetErrorInfo(int tid)
        {
            lock (SessionLock)
            {
                ErrorInfo e;
                if (ThreadErrors.TryGetValue(tid, out e))
                    return e;
                // exceptionInfo without a usable threadId: any error stop will do
                foreach (var kv in ThreadErrors)
                    return kv.Value;
            }
            return null;
        }

        /// <summary>A locals/step-watch request for tid is about to be sent.</summary>
        public static void BeginFetchVars(int tid, string file, int line)
        {
            lock (VarsLock)
            {
                StepWatchVars.Clear();
                FramesByThread.Remove(tid); // don't serve this thread's stale frames mid-refetch
                LocalsPending.Add(tid);
                StepWatchPending = true;
                StepWatchReady.Reset();
            }
        }

        /// <summary>The locals answer for tid arrived (frames null = unusable payload).</summary>
        public static void CompleteLocals(int tid, List<CicodeFrame> frames)
        {
            lock (VarsLock)
            {
                if (frames != null)
                    FramesByThread[tid] = frames;
                LocalsPending.Remove(tid);
                Monitor.PulseAll(VarsLock);
            }
        }

        /// <summary>Wait (bounded) until tid's locals are in; returns its frames or null.</summary>
        public static List<CicodeFrame> WaitForLocals(int tid, int timeoutMs)
        {
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            lock (VarsLock)
            {
                while (LocalsPending.Contains(tid))
                {
                    int left = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                    if (left <= 0)
                        break;
                    Monitor.Wait(VarsLock, left);
                }
                List<CicodeFrame> f;
                return FramesByThread.TryGetValue(tid, out f) ? new List<CicodeFrame>(f) : null;
            }
        }

        /// <summary>
        /// Reset per-session state after a disconnect.
        /// Preserves pending breakpoints so they can be re-sent on re-attach.
        /// </summary>
        public static void Reset()
        {
            Attached = false;
            ConfigDone = false;
            SteppingThread = -1;
            StepWatchPending = false;
            StepWatchReady.Set();
            lock (SessionLock)
            {
                Threads.Clear();
                ThreadFile.Clear();
                ThreadLine.Clear();
                PausedThreads.Clear();
                ThreadErrors.Clear();
            }
            lock (VarsLock)
            {
                StepWatchVars.Clear();
                FramesByThread.Clear();
                LocalsPending.Clear();
                Monitor.PulseAll(VarsLock);
            }
        }
    }
}
