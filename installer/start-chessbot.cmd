@echo off
REM Chessbot launcher — installed as {app}\start-chessbot.cmd
pushd "%~dp0backend"
node server.js
popd
