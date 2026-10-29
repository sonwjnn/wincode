@echo off
setlocal
set "POWERSHELL_EXE=powershell.exe"
where %POWERSHELL_EXE% >nul 2>nul
if errorlevel 1 (
	>&2 echo powershell.exe not found. Install PowerShell or run test.ps1 directly.
	exit /b 127
)

%POWERSHELL_EXE% -NoProfile -ExecutionPolicy Bypass -File "%~dp0test.ps1" %*
exit /b %ERRORLEVEL%
