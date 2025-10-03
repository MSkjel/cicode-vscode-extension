export interface BuiltinFunction {
  name: string;
  returnType: string;
  params: string[];
  doc: string;
  returns?: string;
  paramDocs?: Record<string, string>;
  helpPath?: string;
}
