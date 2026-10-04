' ============================================================================
'  ScreenFleet BrightSign Player — autorun.brs  (v32, Node-native launcher)
' ----------------------------------------------------------------------------
'  This file does ONE job: launch the Node server and point the HTML widget at
'  it over http://localhost. All content logic (config, manifest polling, media
'  caching, rendering) lives in Node (server.js) + the browser (player.js).
'
'  There is deliberately NO config injection and NO fetch workaround. The only
'  hardware API used is roVideoMode, and ONLY to receive the roHdmiInputChanged
'  hotplug event (SetPort) — its crashing mode-setting calls (SetMode, etc.)
'  are never used. Every other OS 9.x video/display/device call is a known
'  crash source (&hf4 / &he0) and is avoided. The widget loads from the local
'  server, so fetch() works normally in the page.
'
'  Launch pattern: BrightSign dev-cookbook roNodeJs + roHtmlWidget.
' ============================================================================

Sub Main()
    Print "[SF] autorun v32 — Node-native launcher starting"
    CreateDirectory("sd:/brightsign-dumps")   ' crash dumps land here if OS panics

    msgPort = CreateObject("roMessagePort")

    ' ── Read screen size from config.json (fallback 1920x1080) ───────────────
    w% = 1920 : h% = 1080
    cfg = ParseConfig("sd:/config.json")
    If Type(cfg) = "roAssociativeArray" Then
        If cfg.screenWidth  <> Invalid Then w% = cfg.screenWidth
        If cfg.screenHeight <> Invalid Then h% = cfg.screenHeight
    End If
    Print "[SF] canvas " + Stri(w%) + "x" + Stri(h%)

    ' ── Launch Node 18 (serves SD root + /api/* on http://localhost:13131) ────
    ' Keep the reference on the global AA so it is not garbage-collected.
    gaa = GetGlobalAA()
    gaa.node = CreateObject("roNodeJs", "server.js", { message_port: msgPort })
    If gaa.node = Invalid Then
        Print "[SF] FATAL: roNodeJs could not be created"
    Else
        Print "[SF] Node launching (server.js)"
    End If

    ' ── Launch the HTML widget pointed at the LOCAL SERVER (never file://) ────
    r = CreateObject("roRectangle", 0, 0, w%, h%)
    hCfg = {
        url: "http://localhost:13131/index.html",
        javascript_enabled: true,
        nodejs_enabled: true,
        brightsign_js_objects_enabled: true,
        storage_path: "sd:/",
        security_params: { websecurity: false }
    }
    h = CreateObject("roHtmlWidget", r, hCfg)
    h.SetPort(msgPort)
    h.Show()
    Print "[SF] widget shown — waiting for localhost page to load"

    ' ── HDMI hotplug: roVideoMode emits roHdmiInputChanged on replug ─────────
    ' IMPORTANT: roVideoMode is created ONLY to receive the hotplug event.
    ' SetMode() is NEVER called here — that is the banned call that crashes
    ' OS 9.x (&hf4). SetPort() just routes events to our message port.
    gaa.videomode = CreateObject("roVideoMode")
    If gaa.videomode <> Invalid Then
        gaa.videomode.SetPort(msgPort)
        Print "[SF-HDMI] roVideoMode listening for HDMI hotplug events"
    Else
        Print "[SF-HDMI] roVideoMode unavailable — hotplug reload disabled"
    End If

    ' ── Event loop: retry the load + handle HDMI hotplug ─────────────────────
    attempt = 0
    While true
        msg = Wait(5000, msgPort)
        mt = Type(msg)
        If mt = "roHtmlWidgetEvent" Then
            data = msg.GetData()
            If Type(data) = "roAssociativeArray" Then
                If data.reason = "load-complete" Then
                    Print "[SF] load-complete — player running from localhost"
                    attempt = 0
                    ' Kick the HDMI element once the page is up.
                    h.InjectJavascript("if(window.sfReloadHdmi){sfReloadHdmi();}")
                Else If data.reason = "load-error" Then
                    attempt = attempt + 1
                    Print "[SF] load-error #" + Stri(attempt) + " — server not ready, retrying"
                    If attempt <= 20 Then
                        Sleep(3000)
                        h.SetUrl("http://localhost:13131/index.html")
                    End If
                End If
            End If
        Else If mt = "roHdmiInputChanged" Then
            Print "[SF-HDMI] roHdmiInputChanged — reloading HDMI video element"
            h.InjectJavascript("if(window.sfReloadHdmi){sfReloadHdmi();}")
        End If
    End While
End Sub

' ---------------------------------------------------------------------------
'  ParseConfig — read + JSON-parse a file, returning Invalid on any failure.
'  ParseJson is safe on OS 9.x; the banned calls are the display/video/device
'  APIs, which this launcher never touches.
' ---------------------------------------------------------------------------
Function ParseConfig(filePath As String) As Object
    txt = ReadAsciiFile(filePath)
    If txt = "" Then Return Invalid
    aa = ParseJson(txt)
    Return aa
End Function
