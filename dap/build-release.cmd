@echo off
:: Build cicode-debug-adapter.exe using the .NET Framework 4.x x86 compiler.
:: /platform:x86 is mandatory - string.GetHashCode() must match CtCicode.exe (x86 .NET 4.x).
:: Release build: no VERBOSE define, so only WRN entries are logged. No log file is created.
setlocal
cd /d "%~dp0"
set CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe
set OUT=cicode-debug-adapter.exe

%CSC% ^
  /target:exe ^
  /platform:x86 ^
  /optimize ^
  /r:System.Web.Extensions.dll ^
  /out:%OUT% ^
  Logger.cs ^
  Program.cs ^
  Dap\State.cs ^
  Dap\Json.cs ^
  Dap\Transport.cs ^
  Dap\Handlers.cs ^
  Ipc\ScadaVersion.cs ^
  Ipc\PaClient.cs ^
  Ipc\CtApiClient.cs ^
  Ipc\DebugClient.cs ^
  Ipc\RuntimeClient.cs 2>&1

if %ERRORLEVEL% == 0 (
    echo.
    echo Build succeeded: %~dp0%OUT%
) else (
    echo.
    echo Build FAILED.
    exit /b 1
)
