@echo off
REM ============================================================
REM Inicia o tunel ngrok (Redmine) e o worker (Claude Code +
REM Lovable) juntos, cada um na sua propria janela.
REM
REM AJUSTE AQUI se o dominio do ngrok ou o caminho do worker
REM mudarem no futuro.
REM ============================================================

set NGROK_DOMAIN=SEU-DOMINIO.ngrok-free.dev
set WORKER_DIR=%~dp0..\worker

echo Iniciando tunel ngrok (%NGROK_DOMAIN%)...
start "ngrok - Tunel Redmine" cmd /k "ngrok http --domain=%NGROK_DOMAIN% 8080"

echo Iniciando worker (Claude Code + Lovable)...
start "Lovable Worker" cmd /k "cd /d %WORKER_DIR% && npm start"

echo.
echo Duas janelas novas devem ter aberto: uma do ngrok, outra do worker.
echo Deixe as duas abertas enquanto for usar o sistema.
echo.
echo Esta janela pode ser fechada.
pause
