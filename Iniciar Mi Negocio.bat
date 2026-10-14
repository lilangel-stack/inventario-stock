@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo No se encontro Node.js. Instala Node.js 22.5 o posterior desde https://nodejs.org/
  pause
  exit /b 1
)

echo Iniciando Mi negocio...
echo Abre en tu navegador la direccion que aparezca abajo.
echo Para detener el servidor, presiona Ctrl+C.
echo.
npm start
if errorlevel 1 (
  echo.
  echo No se pudo iniciar la aplicacion. Verifica que tengas Node.js 22.5 o posterior.
  pause
)
