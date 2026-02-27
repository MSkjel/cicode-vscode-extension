using System;
using System.Collections;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace CicodeDebugAdapter
{
    /// <summary>
    /// JSON helpers backed by JavaScriptSerializer (System.Web.Extensions.dll).
    /// Parse() deserialises incoming DAP JSON; Str() escapes strings for outgoing
    /// hand-built JSON literals; extension methods pull typed values from dicts.
    /// I use this because we have a relatively simple and flat JSOn structure,
    /// there is no point dragging in external dependencies :)
    /// </summary>
    static class Json
    {
        static readonly JavaScriptSerializer _ser = new JavaScriptSerializer
        {
            MaxJsonLength = int.MaxValue,
        };

        public static Dictionary<string, object> Parse(string json)
        {
            try
            {
                return _ser.Deserialize<Dictionary<string, object>>(json);
            }
            catch (Exception ex)
            {
                Logger.Warn("JSON parse failed: " + ex.Message);
                return new Dictionary<string, object>();
            }
        }

        public static string Serialize(object obj)
        {
            return _ser.Serialize(obj);
        }

        public static string Str(string s)
        {
            if (s == null)
                return "null";
            var sb = new System.Text.StringBuilder(s.Length + 2);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '\\':
                        sb.Append("\\\\");
                        break;
                    case '"':
                        sb.Append("\\\"");
                        break;
                    case '\n':
                        sb.Append("\\n");
                        break;
                    case '\r':
                        sb.Append("\\r");
                        break;
                    case '\t':
                        sb.Append("\\t");
                        break;
                    default:
                        if (c < 0x20)
                            sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else
                            sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        public static string GetStr(this Dictionary<string, object> d, string key)
        {
            if (d == null)
                return null;
            object v;
            if (!d.TryGetValue(key, out v) || v == null)
                return null;
            return v.ToString();
        }

        public static int GetInt(this Dictionary<string, object> d, string key, int def = 0)
        {
            if (d == null)
                return def;
            object v;
            if (!d.TryGetValue(key, out v) || v == null)
                return def;
            if (v is int)
                return (int)v;
            int r;
            return int.TryParse(v.ToString(), out r) ? r : def;
        }

        public static Dictionary<string, object> GetObj(
            this Dictionary<string, object> d,
            string key
        )
        {
            if (d == null)
                return null;
            object v;
            if (!d.TryGetValue(key, out v))
                return null;
            return v as Dictionary<string, object>;
        }

        /// <summary>One breakpoint as received in a DAP setBreakpoints request.</summary>
        public class BpSpec
        {
            public int Line;
            public string Condition; // null = unconditional
            public bool Enabled; // false = user unchecked the BP
        }

        /// <summary>
        /// Extract line + optional condition from a "breakpoints":[{line:N,condition:"..."},...] array.
        /// Preserves array order.
        /// </summary>
        public static List<BpSpec> GetBpSpecs(this Dictionary<string, object> d)
        {
            var result = new List<BpSpec>();
            if (d == null)
                return result;
            object v;
            if (!d.TryGetValue("breakpoints", out v))
                return result;
            var arr = v as ArrayList;
            if (arr == null)
                return result;
            foreach (object item in arr)
            {
                var bp = item as Dictionary<string, object>;
                if (bp == null)
                    continue;
                object lineVal;
                if (!bp.TryGetValue("line", out lineVal) || lineVal == null)
                    continue;
                int line;
                if (lineVal is int)
                    line = (int)lineVal;
                else if (!int.TryParse(lineVal.ToString(), out line))
                    continue;

                string condition = null;
                object condVal;
                if (bp.TryGetValue("condition", out condVal) && condVal != null)
                {
                    condition = condVal.ToString().Trim();
                    if (condition.Length == 0)
                        condition = null;
                }
                bool enabled = true;
                object enVal;
                if (bp.TryGetValue("enabled", out enVal) && enVal is bool)
                    enabled = (bool)enVal;

                result.Add(
                    new BpSpec
                    {
                        Line = line,
                        Condition = condition,
                        Enabled = enabled,
                    }
                );
            }
            return result;
        }

        /// <summary>Extract line numbers from a "breakpoints":[{line:N,...},...] array.</summary>
        public static List<int> GetBpLines(this Dictionary<string, object> d)
        {
            var result = new List<int>();
            if (d == null)
                return result;
            object v;
            if (!d.TryGetValue("breakpoints", out v))
                return result;
            var arr = v as ArrayList;
            if (arr == null)
                return result;
            foreach (object item in arr)
            {
                var bp = item as Dictionary<string, object>;
                if (bp == null)
                    continue;
                object lineVal;
                if (!bp.TryGetValue("line", out lineVal) || lineVal == null)
                    continue;
                if (lineVal is int)
                {
                    result.Add((int)lineVal);
                    continue;
                }
                int line;
                if (int.TryParse(lineVal.ToString(), out line))
                    result.Add(line);
            }
            return result;
        }

        public static List<int> GetIntList(this Dictionary<string, object> d, string key)
        {
            var result = new List<int>();
            if (d == null)
                return result;
            object v;
            if (!d.TryGetValue(key, out v))
                return result;
            var arr = v as ArrayList;
            if (arr == null)
                return result;
            foreach (object item in arr)
            {
                if (item == null)
                    continue;
                if (item is int)
                {
                    result.Add((int)item);
                    continue;
                }
                int n;
                if (int.TryParse(item.ToString(), out n))
                    result.Add(n);
            }
            return result;
        }
    }
}
