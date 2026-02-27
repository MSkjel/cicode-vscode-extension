> **WIP** - This document is incomplete and may contain inaccuracies. Derived from live packet captures and binary analysis of CtCicode.exe.

# Citect Debug IPC Protocol

Named pipe: `\\.\pipe\Citect.Debug`
Server: `Citect32.exe` - our adapter is the client.

---

## Connection Handshake (4 phases)

```
1. Version bytes     client -> server   00 00
                     server -> client   00 00  (echo)

2. GUID challenge    client -> server   16-byte GUID
                     server -> client   connects to \\.\pipe\{GUID} and echoes the 16 bytes back

3. IdentifyMessage   client -> server   183 bytes, PacketAdapterV100 format (20-byte header)
                     server -> client   183 bytes  (server IdentifyMessage)

4. Running session   PacketAdapter v2.2 frames in both directions
```

---

## PacketAdapter v2.2 Frame

```
Offset  Size  Field
  0      4    Marker:     01 02 FF FF
  4      4    SeqId:      uint32 LE  (0 = ack-only, always accepted)
  8      4    PayloadLen: uint32 LE
 12      4    CRC32:      over header[0..11] + payload

Total header: 16 bytes, followed by PayloadLen bytes of payload.
```

**CRC32:** poly `0xEDB88320`, seed `0x7DB49658`, no final XOR.
Computed as `CRC(seed, payload)` then `CRC(result, header[0..11])`.

---

## Payload: Message Types

Each payload starts with a **type hash** (4 bytes LE).
On first occurrence the hash is followed by a LEB128 length + UTF-8 type name.
Subsequent frames with the same hash omit the name.

| Hash         | Type                        | Body                        |
|--------------|-----------------------------|-----------------------------|
| `0x074EC4CF` | HeartbeatMessage            | 0 bytes                     |
| `0xB8C1265F` | AcknowledgementMessage      | uint32 ackSeqId             |
| `0x74F6C524` | TranEncapsulationMessage    | see below                   |

> Hashes are `.NET x86 string.GetHashCode()` of the assembly-qualified type name.
> They **(might?)** change between AVEVA product versions. `ScadaVersion.cs` detects them at startup.

---

## TranEncapsulationMessage Body

```
Offset  Size  Field
  0      2    Type:    always 0x0000
  2      4    DataLen: uint32 LE
  6      DataLen  Data (CMB block)
```

---

## CMB Block (inside Data)

```
Offset  Size  Field
  0      4    Magic:   "CMB\0"
  4      4    TotalLen
  8      4    CmdCode: uint32 LE  (command or event code)
 12      ...  CmdPayload
```

---

## Commands (IDE to Runtime)

| Code     | Name              | CmdPayload                                     |
|----------|-------------------|------------------------------------------------|
| `0x1020` | SESSION_START     | zeros(4)                                       |
| `0x1021` | SESSION_STOP      | zeros(4)                                       |
| `0x1023` | SET_BREAKPOINT    | id=0xFFFFFFFF(4) + unk=0(4) + line(4) + path\0 |
| `0x102C` | CLR_BREAKPOINT    | id=0xFFFFFFFF(4) + unk=0(4) + 0(4) + null(1)  |
| `0x102E` | CONTINUE_ALL      | threadId=-1 (0xFFFFFFFF)(4)                    |
| `0x102F` | RESUME_THREAD     | threadId(4)                                    |
| `0x1030` | STEP_INTO         | threadId(4)                                    |
| `0x1031` | STEP_OVER         | threadId(4)                                    |
| `0x1032` | STEP_OUT          | threadId(4)                                    |
| `0x1029` | GET_STEP_WATCH    | threadId(4)                                    |
| `0x102A` | GET_LOCALS        | threadId(4)                                    |
| `0x1033` | SEND_WATCH        | threadId(4) + watch names                      |

> **CLR_BREAKPOINT does not work.** It does not restore patched bytecode.
> To clear BPs: disconnect (SESSION_STOP + pipe close), reconnect, re-register only the desired BPs.

---

## Events (Runtime to IDE)

| Code     | Name              | CmdPayload                                          |
|----------|-------------------|-----------------------------------------------------|
| `0x1000` | RESUMED           |                                                     |
| `0x1001` | STOPPED           | session ended                                       |
| `0x1002` | SOURCE_LOC        | threadId(4) + unk(4) + line(4) + path\0             |
| `0x1003` | BP_HIT            | threadId(4) + unk=0(4) + line(4) + path\0           |
| `0x1009` | STEP_WATCH_DATA   | text: `name = value\r\n` pairs                      |
| `0x100A` | LOCALS_LIVE       | threadId(4) + text (call stack lines ending `;`, then `name = value {quality}`) |
| `0x100C` | BP_CONFIRM        | 0xFFFFFFFF(4) + bpCount(4) + line(4) + path\0       |
| `0x100F` | WATCH_EVAL_RESP   | watch expression results                            |

---

## Notes

- Multiple `0x1003` BP_HIT events arrive per hit (one per paused thread).
- `CONTINUE_ALL` resumes all paused threads. Do not send it with no paused threads, the server closes the connection.
- `0x100C` fires immediately before `0x1003` as a BP registration confirmation and hit counter.
