import { parseDbf } from "./dbfReader";

export interface LocvarRecord {
  name: string;
  type: string;
  comment: string;
  file: string;
}

export function parseLocvarDbf(filePath: string): LocvarRecord[] {
  const rows = parseDbf(filePath);
  const records: LocvarRecord[] = [];
  for (const row of rows) {
    const name = (row["NAME"] ?? "").trim();
    const type = (row["TYPE"] ?? "").trim();
    if (!name) continue;
    records.push({ name, type, comment: row["COMMENT"] ?? "", file: filePath });
  }
  return records;
}
