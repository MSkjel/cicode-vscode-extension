export interface BuiltinFunction {
  name: string;
  returnType: string;
  params: string[];
  doc: string;
  returns?: string;
  paramDocs?: Record<string, string>;
  /** Local Flare help filename, e.g. "AlarmAckRec.html" (2020/Flare installs). */
  helpPath?: string;
  /** Author-it portal topic id, e.g. "1033446" (2023 R2). */
  helpId?: string;
}
