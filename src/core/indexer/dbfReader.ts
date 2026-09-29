import * as fs from "fs";
import { decodeWindows1252 } from "../../shared/utils";

export interface DbfField {
  name: string;
  type: string; // 'C', 'N', 'D', 'L', 'M', etc.
  length: number;
}

export interface DbfHeader {
  recordCount: number;
  headerSize: number;
  recordSize: number;
  fields: DbfField[];
}

export function readDbfHeader(buf: Buffer): DbfHeader | null {
  if (buf.length < 32) return null;
  const recordCount = buf.readUInt32LE(4);
  const headerSize = buf.readUInt16LE(8);
  const recordSize = buf.readUInt16LE(10);

  if (recordSize === 0 || headerSize < 32) return null;

  const fields: DbfField[] = [];
  let offset = 32;
  while (
    offset + 32 <= buf.length &&
    offset < headerSize - 1 &&
    buf[offset] !== 0x0d
  ) {
    const name = buf
      .subarray(offset, offset + 11)
      .toString("binary")
      .replace(/\0/g, "")
      .trim();
    const type = String.fromCharCode(buf[offset + 11]);
    const length = buf[offset + 16];
    if (name) fields.push({ name, type, length });
    offset += 32;
  }

  return { recordCount, headerSize, recordSize, fields };
}

/**
 * Parse a DBF file and return all non-deleted records as plain objects.
 * Field values are trimmed strings, decoded as cp1252. Field names are
 * uppercased for consistency.
 */
export function parseDbf(filePath: string): Record<string, string>[] {
  return readRecords(filePath, false) ?? [];
}

/** Like parseDbf, but undefined when the file cannot be read or is cut
 *  short (e.g. while it is being rewritten), so a caller can keep what it
 *  read before. */
export function readDbfStrict(
  filePath: string,
): Record<string, string>[] | undefined {
  return readRecords(filePath, true);
}

function readRecords(
  filePath: string,
  strict: boolean,
): Record<string, string>[] | undefined {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return undefined;
  }

  const header = readDbfHeader(buf);
  if (!header) return strict ? undefined : [];

  const { recordCount, headerSize, recordSize, fields } = header;
  if (strict && headerSize + recordCount * recordSize > buf.length) {
    return undefined;
  }

  // Compute byte offset of each field within a record (byte 0 = deletion flag)
  const offsets: number[] = [];
  let pos = 1;
  for (const f of fields) {
    offsets.push(pos);
    pos += f.length;
  }

  const records: Record<string, string>[] = [];
  for (let i = 0; i < recordCount; i++) {
    const recStart = headerSize + i * recordSize;
    if (recStart + recordSize > buf.length) break;
    if (buf[recStart] === 0x2a) continue; // deleted record

    const record: Record<string, string> = {};
    for (let fi = 0; fi < fields.length; fi++) {
      const f = fields[fi];
      // Tables are in the ANSI code page like the source files, and the
      // compiler compares names from both by their bytes (ignoring only the
      // case of ASCII letters), so both are decoded alike.
      record[f.name.toUpperCase()] = decodeWindows1252(
        buf.subarray(recStart + offsets[fi], recStart + offsets[fi] + f.length),
      )
        .replace(/\0/g, "")
        .trim();
    }
    records.push(record);
  }
  return records;
}
