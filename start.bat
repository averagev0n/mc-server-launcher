@echo off
chcp 65001 >nul
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if not exist node_modules\electron\dist\electron.exe (
  echo Первый запуск: устанавливаю Electron, это займёт пару минут...
  call npm install
  if not errorlevel 1 node node_modules\electron\install.js
  if not exist node_modules\electron\dist\electron.exe (
    echo Не удалось установить зависимости. Проверьте интернет и что установлен Node.js.
    pause
    exit /b 1
  )
)
start "" node_modules\electron\dist\electron.exe .
