using System;
using System.IO;
using System.Reflection;

namespace CicodeDebugAdapter
{
    /// <summary>
    /// Reads the installed SCADA assembly version at startup and exposes the
    /// version-dependent PacketAdapter type names and their hashes.
    ///
    /// Falls back to AVEVA Plant SCADA 2023 (v8.40) defaults if the DLL is
    /// not found
    /// </summary>
    static class ScadaVersion
    {
        // Defaults to AVEVA Plant SCADA 2023, overwritten by Init() when or if the DLL is found
        public static short MsgVersion = unchecked((short)0x20D0); // 8400 = v8.40
        public static uint HashHb = 0x074EC4CFu;
        public static uint HashAck = 0xB8C1265Fu;
        public static uint HashTran = 0x74F6C524u;
        public static uint HashTranLegacy = 0xAF2648BBu;
        public static string TnHb =
            "Citect.Platform.Net.Message.HeartbeatMessage, Citect.Platform.Net.Message, Version=8.40.0.0, Culture=neutral, PublicKeyToken=13aaee2494f61799";
        public static string TnAck =
            "Citect.Platform.Net.Message.AcknowledgementMessage, Citect.Platform.Net.Message, Version=8.40.0.0, Culture=neutral, PublicKeyToken=13aaee2494f61799";
        public static string TnTran =
            "Citect.Platform.Net.Message.TranEncapsulationMessage, Citect.Platform.Net.Message, Version=8.40.0.0, Culture=neutral, PublicKeyToken=13aaee2494f61799";

        // RuntimeManager pipe message types (in Citect.CitectSCADA.PlatformMessages.dll)
        // Hashes are computed in Init() from the type name strings below.
        public static uint HashProcessInfoChanged;
        public static string TnProcessInfoChanged =
            "Citect.CitectSCADA.PlatformMessages.ProcessInfoChangedMessage, "
            + "Citect.CitectSCADA.PlatformMessages, Version=8.40.0.0, Culture=neutral, PublicKeyToken=13aaee2494f61799";

        public static string BinFolder;

        public static uint HashRtMsg;
        public static string TnRtMsg =
            "Citect.CitectSCADA.PlatformMessages.RuntimeManagerTimestampedMessage, "
            + "Citect.CitectSCADA.PlatformMessages, Version=8.40.0.0, Culture=neutral, PublicKeyToken=13aaee2494f61799";

        public static void Init()
        {
            string dllPath = FindDll();
            if (dllPath == null)
            {
                // I dont think they actually change anyways. It will probably break if they do
                Logger.Scada("Citect.Platform.Net.Message.dll not found. using v8.40 defaults");
            }
            else
            {
                try
                {
                    Assembly asm = Assembly.ReflectionOnlyLoadFrom(dllPath);
                    Version ver = asm.GetName().Version;

                    // MSG_VERSION encoding used in IdentifyMessage: major*1000 + minor*10
                    MsgVersion = (short)(ver.Major * 1000 + ver.Minor * 10);

                    ScanTypes(asm, primary: true);

                    // Legacy companion assembly lives in the same bin folder.
                    string legacyPath = Path.Combine(
                        Path.GetDirectoryName(dllPath),
                        "Citect.CitectSCADA.PlatformMessages.dll"
                    );
                    if (File.Exists(legacyPath))
                        ScanTypes(Assembly.ReflectionOnlyLoadFrom(legacyPath), primary: false);

                    Logger.Scada(
                        string.Format(
                            "Detected v{0}.{1}. MSG_VERSION=0x{2:X4}  HASH_HB=0x{3:X8}",
                            ver.Major,
                            ver.Minor,
                            (ushort)MsgVersion,
                            HashHb
                        )
                    );
                }
                catch (Exception ex)
                {
                    Logger.Scada("Failed to reflect DLL, using v8.40 defaults: " + ex.Message);
                }
            }

            // Compute RuntimeManager type hashes from current type name strings.
            // ScanTypes() may have updated TnProcessInfoChanged/TnRtMsg when the DLL was
            // found; otherwise they remain at the v8.40 defaults above.
            HashProcessInfoChanged = (uint)TnProcessInfoChanged.GetHashCode();
            HashRtMsg = (uint)TnRtMsg.GetHashCode();
        }

        /// <summary>
        /// Scans the types in an assembly and updates hashes for known message type names.
        /// This binary is compiled /platform:x86 targeting net48, matching CtCicode.exe.
        /// </summary>
        static void ScanTypes(Assembly asm, bool primary)
        {
            Type[] types;
            try
            {
                types = asm.GetTypes();
            }
            catch (ReflectionTypeLoadException ex)
            {
                types = ex.Types;
            }

            foreach (Type t in types)
            {
                if (t == null)
                    continue;
                string aqn = t.AssemblyQualifiedName;
                if (aqn == null)
                    continue;

                if (primary)
                {
                    switch (t.Name)
                    {
                        case "HeartbeatMessage":
                            TnHb = aqn;
                            HashHb = (uint)aqn.GetHashCode();
                            break;
                        case "AcknowledgementMessage":
                            TnAck = aqn;
                            HashAck = (uint)aqn.GetHashCode();
                            break;
                        case "TranEncapsulationMessage":
                            TnTran = aqn;
                            HashTran = (uint)aqn.GetHashCode();
                            break;
                    }
                }
                else
                {
                    switch (t.Name)
                    {
                        case "TranEncapsulationMessage":
                            HashTranLegacy = (uint)aqn.GetHashCode();
                            break;
                        case "ProcessInfoChangedMessage":
                            TnProcessInfoChanged = aqn;
                            break;
                        case "RuntimeManagerTimestampedMessage":
                            TnRtMsg = aqn;
                            break;
                    }
                }
            }
        }

        static string FindDll()
        {
            // HKLM\SOFTWARE\WOW6432Node\Citect\SCADA Installs\{version}\BinFolder
            try
            {
                using (
                    var installs = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(
                        @"SOFTWARE\WOW6432Node\Citect\SCADA Installs"
                    )
                )
                {
                    if (installs != null)
                    {
                        foreach (string ver in installs.GetSubKeyNames())
                        {
                            using (var verKey = installs.OpenSubKey(ver))
                            {
                                if (verKey == null)
                                    continue;
                                string binFolder = verKey.GetValue("BinFolder") as string;
                                if (binFolder == null)
                                    continue;
                                string p = Path.Combine(
                                    binFolder,
                                    "Citect.Platform.Net.Message.dll"
                                );
                                if (File.Exists(p))
                                {
                                    BinFolder = binFolder;
                                    return p;
                                }
                            }
                        }
                    }
                }
            }
            catch { }

            return null;
        }
    }
}
