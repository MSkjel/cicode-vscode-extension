using System.Collections.Generic;
using System.IO;
using System.Threading;

namespace CicodeDebugAdapter
{
    /// <summary>
    /// All shared DAP session state.  Accessed from both the DAP handlers (main thread)
    /// and the IPC reader thread. Locking is done at the call sites.
    /// </summary>
    static class DapState
    {
        public static int Seq = 0;

        public static bool Attached = false;
        public static bool ConfigDone = false;
        public static volatile bool IsStopped = false; // written main+reader, read both
        public static volatile bool PendingReconnect = false; // reconnect deferred while paused
        public static volatile bool StripQualityTags = true; // written main, read reader

        public static readonly HashSet<int> Threads = new HashSet<int>();
        public static readonly Dictionary<int, string> ThreadFile = new Dictionary<int, string>();
        public static readonly Dictionary<int, int> ThreadLine = new Dictionary<int, int>();
        public static volatile int SteppingThread = -1; // written main, read reader

        // Breakpoints + thread location: key = normalised lower-case path
        public static readonly Dictionary<string, List<int>> PendingBps =
            new Dictionary<string, List<int>>();
        public static readonly Dictionary<string, string> BpPaths =
            new Dictionary<string, string>();
        public static readonly Dictionary<string, Dictionary<int, string>> BpConditions =
            new Dictionary<string, Dictionary<int, string>>();
        public static readonly object SessionLock = new object(); // guards Threads, ThreadFile, ThreadLine, PendingBps, BpPaths, BpConditions

        public static readonly Dictionary<string, string> StepWatchVars =
            new Dictionary<string, string>();
        public static readonly Dictionary<string, string> LocalVars =
            new Dictionary<string, string>();
        public static int StoppedThreadId = -1; // guarded by VarsLock
        public static string StoppedFile = null; // guarded by VarsLock
        public static int StoppedLine = 0; // guarded by VarsLock
        public static volatile bool StepWatchPending = false;
        public static volatile bool LocalVarsPending = false;

        // Signaled when the respective response arrives; Reset() before sending request.
        public static readonly ManualResetEventSlim LocalsReady = new ManualResetEventSlim(true);
        public static readonly ManualResetEventSlim StepWatchReady = new ManualResetEventSlim(true);
        public static readonly object VarsLock = new object();

        public static Stream Stdout;
        public static readonly object StdoutLock = new object();

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

        /// <summary>
        /// Reset per-session state after a disconnect.
        /// Preserves pending breakpoints so they can be re-sent on re-attach.
        /// </summary>
        public static void Reset()
        {
            Attached = false;
            ConfigDone = false;
            IsStopped = false;
            PendingReconnect = false;
            SteppingThread = -1;
            StepWatchPending = false;
            LocalVarsPending = false;
            LocalsReady.Set();
            StepWatchReady.Set();
            lock (SessionLock)
            {
                Threads.Clear();
                ThreadFile.Clear();
                ThreadLine.Clear();
            }
            lock (VarsLock)
            {
                StoppedThreadId = -1;
                StoppedFile = null;
                StoppedLine = 0;
                StepWatchVars.Clear();
                LocalVars.Clear();
            }
        }
    }
}
