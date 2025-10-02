export interface BuiltinFunction {
  name: string;
  returnType: string;
  params: string[];
  doc: string;
  helpPath?: string;
}
