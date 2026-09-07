@echo off
title Dhurta Connection - Offline Server Launcher
echo ======================================================================
echo           Dhurta Connection - Offline P2P Local Server
echo ======================================================================
echo.
echo [1] Checking for Python installation...
python --version >nul 2>&1
if %errorlevel% equ 0 (
    echo Python detected! Starting high-speed local HTTP server on port 8080...
    echo.
    echo Open your browser to: http://localhost:8080
    echo (Or your Hotspot IP, e.g., http://192.168.43.1:8080 on your phone)
    echo.
    python -m http.server 8080
    goto end
)

echo [2] Python not found. Falling back to PowerShell HTTP Server...
powershell -Command "$listener = New-Object System.Net.HttpListener; $listener.Prefixes.Add('http://*:8080/'); $listener.Start(); Write-Host 'Server running on http://localhost:8080'; while($true){ $context = $listener.GetContext(); $path = '.' + $context.Request.Url.LocalPath; if(-not (Test-Path $path) -or (Get-Item $path).PSIsContainer){ $path = './index.html' }; $bytes = [System.IO.File]::ReadAllBytes($path); $context.Response.OutputStream.Write($bytes, 0, $bytes.Length); $context.Response.Close() }"

:end
pause