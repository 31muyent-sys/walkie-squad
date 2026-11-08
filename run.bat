@echo off
cd /d "%~dp0"
start "" http://127.0.0.1:8220
python -m http.server 8220 --bind 127.0.0.1
