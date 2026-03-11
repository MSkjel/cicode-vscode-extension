import { parseDbf } from "./dbfReader";

export interface LabelRecord {
  name: string;
  expr: string;
  comment: string;
  file: string;
}

export function parseLabelsDbf(filePath: string): LabelRecord[] {
  const rows = parseDbf(filePath);
  const records: LabelRecord[] = [];
  for (const row of rows) {
    const name = row["NAME"] ?? "";
    const expr = row["EXPR"] ?? "";
    if (!name) continue;
    records.push({ name, expr, comment: row["COMMENT"] ?? "", file: filePath });
  }
  return records;
}
