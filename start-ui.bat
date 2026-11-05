@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 (
  echo Unable to open the application directory.
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 18 or later is required. Install Node.js and try again.
  exit /b 1
)

for /f "delims=" %%V in ('node --version 2^>nul') do set "NODE_VERSION=%%V"
node -e "process.exit(parseInt(process.versions.node, 10) >= 18 ? 0 : 1)" >nul 2>&1
if errorlevel 1 (
  echo Node.js 18 or later is required. Detected %NODE_VERSION%.
  exit /b 1
)

node src\adapters\cli.mjs ui %*
set "EXIT_CODE=%ERRORLEVEL%"
exit /b %EXIT_CODE%
