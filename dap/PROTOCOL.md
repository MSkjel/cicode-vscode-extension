# Citect Debug IPC Protocol

Named pipe: `\\.\pipe\Citect.Debug`

Established from binary analysis of the Cicode Editor (`CtCicode.exe`), the runtime's debugger (`Client.dll`), and the managed transport (`Citect.Platform.Transport`). Checked against a live AVEVA Plant SCADA 2023 R2 (v8.50) runtime.

Every statement is tagged:

- **(live)**: observed on the wire against a running runtime.
- **(binary)**: taken from the binaries only.

---

## Which process listens

Every runtime component runs in its own `Citect32.exe`: Client, IOServer, Alarm, Report and Trend. Only **one** of them opens the debug pipe.

The process is chosen by `[Debug]CodeDebug` in `citect.ini`, which the runtime reads at startup:

- The values are `Client`, `IOServer`, `Alarm`, `Report` or `Trend`, optionally written as `<Cluster>.<Component>`.
- The default is the Client.
- Cicode that runs in any other component cannot be debugged. **(live)** With `CodeDebug=IOServer`, breakpoints hit in IOServer-only tasks.
- You can recognise the component from the process command line, for example `/R[C:Client]` or `/R[I:Cluster1.IOServer1]`.

The listener serves one debug session at a time. A second client completes the handshake, but its `SESSION_START` gets no answer. **(live)**

---

## Connection handshake

```
1. Cipher suite      client -> server   {CanSecure, MustSecure}  (00 00: no encryption)
                     server -> client   its own flags; MustSecure = 1 means an unencrypted peer is dropped

2. GUID challenge    client -> server   16-byte GUID
                     server -> client   connects to \\.\pipe\{GUID} and echoes the 16 bytes back

3. IdentifyMessage   client -> server   183 bytes, PacketAdapterV100 format (20-byte header)
                     server -> client   183 bytes  (server IdentifyMessage)

4. Running session   PacketAdapter v2.2 frames in both directions
```

---

## PacketAdapter v2.2 frame

```
Offset  Size  Field
  0      4    Marker:     01 02 FF FF
  4      4    SeqId:      uint32 LE, id of the first non-ACK message in the frame (0 = ACK-only frame)
  8      4    PayloadLen: uint32 LE
 12      4    CRC32:      over payload, then header[0..11]
```

**CRC32:** poly `0xEDB88320`, seed `0x7DB49658`, no final XOR.

If any of these rules is broken, the server drops the session **(binary)**:

- The SeqIds of non-zero frames must be strictly consecutive. The first frame may have any SeqId.
- Every non-ACK message consumes one id. A type declaration does not.
- An ACK must lie in `(lastAcked, lastSent]`. ACK 0 and a repeated ACK are both fatal.
- A bad CRC is fatal.
- Heartbeats: each side sends one every 5 s. The server restarts the transport after 15 s of silence.

---

## Payload: message types

Each payload starts with a **type hash** (4 bytes LE). The first time a type is used, the hash is followed by a LEB128 length and the UTF-8 assembly-qualified type name, then the hash again and the body. After that, only the hash and the body are sent.

| Type                        | Body                        |
|-----------------------------|-----------------------------|
| HeartbeatMessage            | 0 bytes                     |
| AcknowledgementMessage      | uint32 ackSeqId             |
| TranEncapsulationMessage    | int16 0 + int32 dataLen + data (CMB block) |

The hashes are the **x86** .NET Framework `string.GetHashCode()` of the type name, so they change with the product version. `ScadaVersion.cs` computes them from the installed `Citect.Platform.Net.Message.dll`.

**(live)** A client built for x64 hashes the names differently. The runtime still acknowledges its frames, but ignores its `SESSION_START`.

---

## CMB block

```
Offset  Size  Field
  0      4    "CMB\0"
  4      4    TotalLen (whole block)
  8      4    Code (command or event)
 12      4    Thread id (commands: argument; events: thread, -1 = none)
 16      ...  Arguments
```

Strings are ANSI in the system code page.

---

## Commands (IDE to runtime)

Offsets below are relative to the CMB start. Outside a session, the runtime ignores everything except `0x1020`.

| Code     | Name              | Arguments / effect |
|----------|-------------------|--------------------|
| `0x1020` | SESSION_START     | tid 0. Answered by `0x1000` **(live)**. Ignored if a session already exists. There is no answer at all if the running project has no Cicode debug information **(binary)**. |
| `0x1021` | SESSION_STOP      | Clears all breakpoints, resumes all threads, answers `0x1001` and closes the connection **(live)**. The same cleanup runs when the client disconnects. |
| `0x1022` | SELECT_THREAD     | tid. Answered by `0x1002` with the thread's location, without suspending it. |
| `0x1023` | SET_BREAKPOINT    | +0xC thread filter (-1 = any), +0x14 line, +0x18 path\0. Answered by `0x100C` **(live)**. There is no dedupe. The path must match the compiled file (case-insensitive). |
| `0x1024` | RESUME_THREAD     | tid. Resumes one suspended thread **(live)**. |
| `0x1025` | SUSPEND_THREAD    | tid |
| `0x1026` | THREAD_FIRST      | Answered by `0x1006` with an info line **(live)**. |
| `0x1027` | THREAD_NEXT       | tid. Answered by `0x1007` with the next thread's info line. tid -1 plus a header line means the end of the list **(live)**. |
| `0x1028` | THREAD_INFO       | tid. Answered by `0x1008`. An **empty** line means there is no such thread **(live)**. |
| `0x1029` | GET_STEP_WATCH    | Answered by `0x1009` (tid -1) with `name = value` lines. The list fills itself with up to 50 global/module variables used by the task being debugged. |
| `0x102A` | GET_STACK         | tid. Answered by `0x100A` with the call stack and locals. There is **no answer** if tid is not a live thread **(live)**. |
| `0x102C` | CLEAR_BREAKPOINT  | +0x10 = the 16-bit **breakpoint id from `0x100C`** **(live)**. Id -1 clears **all**. The rest of the payload is zeros plus an empty path. |
| `0x102D` | SET_OPTION        | +0x10 name char[32], +0x30 value\0. The names are `BreakOnError`, `BreakAllThreads`, `BreakErrorActive` and `ForBreakWarning`. |
| `0x102E` | CONTINUE_ALL      | Resumes every suspended thread. The argument is ignored. Safe with nothing suspended **(live)**. |
| `0x102F` | BREAK             | **Pause**: the next statement executed by any background thread suspends it and sends `0x1002` **(live)**. See the notes below. |
| `0x1030` | STEP_INTO         | tid |
| `0x1031` | STEP_OVER         | tid |
| `0x1032` | STEP_OUT          | tid |
| `0x1033` | WATCH             | tid + name\0 ... \0. Answered by `0x100F`. It evaluates in the task's VBA context, so Cicode values come back empty. |

`SESSION_START` sets `BreakOnError=1`, `BreakErrorActive=1`, `BreakAllThreads=0` and `ForBreakWarning=1`.

**Stepping releases every other suspended thread** **(live)**. Thread B, paused at a breakpoint, runs on when thread A is stepped.

**A step that leaves the outermost function produces no event**, for example the task's final `RETURN` or `END` **(live)**:

- The runtime leaves the thread parked.
- `0x1028` still reports the thread.
- `0x102A` returns a stack with no call line, only `CiCode Register = ...`.
- `0x1024` or `0x102E` releases the thread, and it then ends.

**A pending BREAK stays armed** until a thread is suspended. `CONTINUE_ALL` and `RESUME_THREAD` do not cancel it **(binary)**. A thread whose current function has no source file is suspended without any event.

---

## Events (runtime to IDE)

| Code     | Name              | Payload (after tid at +0xC) |
|----------|-------------------|-----------------------------|
| `0x1000` | SESSION_STARTED   | Only the answer to `0x1020`. It does not mean "resumed" **(live)**. |
| `0x1001` | SESSION_ENDED     | |
| `0x1002` | PAUSED_AT         | +0x14 line, +0x18 path. The thread is suspended here after a step, a BREAK, or the statement after a hardware error or DebugBreak() **(live)**. +0x10 is garbage. |
| `0x1003` | BP_HIT            | Same layout as `0x1002`. The thread is suspended at a breakpoint **(live)**. |
| `0x1004` | THREAD_STARTED    | Header only. Sent only for tasks traced with CodeTrace mode 16 **(binary)**. |
| `0x1005` | THREAD_ENDED      | Header only. Sent only for tasks traced with CodeTrace mode 16 **(binary)**. |
| `0x1006` / `0x1007` | THREAD_LIST | +0x10 info line: `name  hnd user cpu state cpu_time poll slice use% duty%` |
| `0x1008` | THREAD_INFO       | +0x10 info line (empty = no such thread) |
| `0x1009` | STEP_WATCH        | +0x10 `name = value\r\n` ... |
| `0x100A` | STACK             | +0x10 call lines `Func(arg {quality},...);` (outermost first). Each is followed by its `name = value {quality[, ts]}` locals. String arguments are quoted **(live)**. |
| `0x100B` | MESSAGE           | tid -1, +0x10 text. Carries the hardware-error announce, `DebugBreak() called.` **(live)**, and TraceMsg() text. |
| `0x100C` | BP_ACK            | tid = filter, +0x10 **breakpoint id** **(live)**, +0x14 line, +0x18 path. The id is a signed 16-bit counter that is never reset while the runtime runs; -1 means the breakpoint was not created. |
| `0x100E` | HW_ERROR          | +0x14 code, +0x18 text (+0x10 unused). See the codes below. |
| `0x100F` | WATCH_RESULT      | `name=value\0` ... |

`0x100E` carries three kinds of report, told apart by the code:

- **Hardware error:** the real error code, followed by `DESC: '..'\nERRPAGE: '..'\nERRDESC: '..'` **(live)**.
- **Code 0: a command was rejected**, for example "Thread N has terminated|is a foreground thread. Cannot step this thread." **(binary)**
- **Code 343:** "Foreground Cicode cannot break" **(binary)**.

### Hardware error sequence (BreakOnError=1) **(live)**

```
0x100B  tid -1  "Thread T Hardware error (424) 'Tag not found' ErrPage: 'TagRead' ErrDesc: 'GetTagVal'"
0x1002  tid T   line of the failing statement      (thread still running)
0x100E  tid T   code 424 + DESC/ERRPAGE/ERRDESC
0x1002  tid T   line of the NEXT statement          (thread is now suspended)
```

If the next statement has a breakpoint, the last event is a `0x1003` **(live)**.

A foreground thread (page and animation Cicode) cannot be suspended. It sends the first three events only, once until the next `CONTINUE_ALL` **(binary)**.

### Breakpoints in foreground Cicode **(binary)**

A breakpoint in foreground Cicode sends `0x1003` followed by `0x100E` code 343, and the thread keeps running. This happens once per session: the runtime then clears `ForBreakWarning`.

### DebugBreak()

`DebugBreak()` sends `0x100B` `DebugBreak() called.`.

- Called from Cicode source, it then sends `0x1002` at the DebugBreak line while the task still runs, and another `0x1002` at the next statement, where it is suspended **(binary)**.
- Called without source, for example through CtAPI, only the message is sent **(live)**.

### CtAPI calls

`ctCicode` runs its function as a background task **(live)**. A breakpoint in a function called through CtAPI suspends that task, and the CtAPI call blocks until the task is resumed.
