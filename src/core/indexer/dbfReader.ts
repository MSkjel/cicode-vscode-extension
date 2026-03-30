import * as fs from "fs";

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
 * Field values are trimmed strings. Field names are uppercased for consistency.
 */
export function parseDbf(filePath: string): Record<string, string>[] {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return [];
  }

  const header = readDbfHeader(buf);
  if (!header) return [];

  const { recordCount, headerSize, recordSize, fields } = header;

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
      record[f.name.toUpperCase()] = buf
        .subarray(recStart + offsets[fi], recStart + offsets[fi] + f.length)
        .toString("binary")
        .replace(/\0/g, "")
        .trim();
    }
    records.push(record);
  }
  return records;
}
