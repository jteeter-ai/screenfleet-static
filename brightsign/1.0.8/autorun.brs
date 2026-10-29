' ============================================================================
'  ScreenFleet BrightSign Player — autorun.brs  (launcher 1.0.0)
' ----------------------------------------------------------------------------
'  The launcher is the ONE file that is never updated remotely. Everything else
'  (server.js, player.js, index.html, sf-agent.js) can be, because this file
'  guarantees a bad update is rolled back:
'
'   * sf-update.json { pending:true, version, previous, files:[...], attempts }
'     is written by server.js just before it swaps in a new version (the old
'     files are kept in sd:/sf-prev/). server.js clears "pending" once the new
'     version has run healthily (heartbeat OK + page loaded + 90 s up).
'   * If a pending update has booted more than 3 times, or is still unconfirmed
'     10 minutes after boot, this launcher copies sd:/sf-prev/* back and reboots.
'
'  It also launches the NovaStar controller agent (sf-agent.js) as a SEPARATE
'  Node process so it can never freeze playback, and stops launching it if it
'  is associated with 3 unhealthy boots in a row (sf-boot.json).
'
'  OS 9.x/10.x safety (unchanged from v32): the only hardware API used is
'  roVideoMode, created after the page loads, ONLY for the roHdmiInputChanged
'  hotplug event. SetMode()/roDeviceInfo/LTrim/RTrim are never used.
'  Launch pattern: BrightSign dev-cookbook roNodeJs + roHtmlWidget.
' ============================================================================

Sub Main()
    Print "[SF] launcher 1.0.0 starting"
    CreateDirectory("sd:/brightsign-dumps")   ' crash dumps land here if OS panics
    WriteAsciiFile("sd:/sf-launcher.json", FormatJson({ version: "1.0.0" }))

    ' ── 1. Update guard: roll back a pending update that keeps failing ────────
    pendingUpdate = false
    upd = ParseConfig("sd:/sf-update.json")
    If Type(upd) = "roAssociativeArray" Then
        If IsTrue(upd.pending) Then
            att = 0
            If upd.attempts <> Invalid Then att = upd.attempts
            att = att + 1
            If att > 3 Then
                Print "[SF-UPD] pending update failed to confirm after 3 boots — rolling back"
                RollBack(upd)
                RebootSystem()
            End If
            upd.attempts = att
            WriteAsciiFile("sd:/sf-update.json", FormatJson(upd))
            pendingUpdate = true
            Print "[SF-UPD] pending update — boot attempt recorded"
        End If
    End If

    ' ── 2. Agent guard: skip the controller agent after 3 unhealthy boots ─────
    boot = ParseConfig("sd:/sf-boot.json")
    If Type(boot) <> "roAssociativeArray" Then boot = { unhealthy: 0 }
    If boot.unhealthy = Invalid Then boot.unhealthy = 0
    agentAllowed = (boot.unhealthy < 3)
    boot.unhealthy = boot.unhealthy + 1     ' server.js resets this to 0 once the boot is healthy
    WriteAsciiFile("sd:/sf-boot.json", FormatJson(boot))

    msgPort = CreateObject("roMessagePort")

    ' ── Read screen size + options from config.json ──────────────────────────
    w% = 1920 : h% = 1080
    agentEnabled = true
    cfg = ParseConfig("sd:/config.json")
    If Type(cfg) = "roAssociativeArray" Then
        If cfg.screenWidth  <> Invalid Then w% = cfg.screenWidth
        If cfg.screenHeight <> Invalid Then h% = cfg.screenHeight
        If IsFalse(cfg.agentEnabled) Then agentEnabled = false
    End If
    Print "[SF] canvas " + Stri(w%) + "x" + Stri(h%)

    ' ── Launch Node (serves SD root + /api/* on http://localhost:13131) ──────
    ' Keep references on the global AA so they are not garbage-collected.
    gaa = GetGlobalAA()
    gaa.node = CreateObject("roNodeJs", "server.js", { message_port: msgPort })
    If gaa.node = Invalid Then
        Print "[SF] FATAL: roNodeJs could not be created"
    Else
        Print "[SF] Node launching (server.js)"
    End If

    ' ── Launch the controller agent as its own Node process ──────────────────
    gaa.agent = Invalid
    If agentEnabled And agentAllowed Then
        If CreateObject("roReadFile", "sd:/sf-agent.js") <> Invalid Then
            gaa.agent = CreateObject("roNodeJs", "sf-agent.js", { message_port: msgPort })
            If gaa.agent = Invalid Then
                Print "[SF-AGENT] could not start a second Node process — agent disabled this boot"
            Else
                Print "[SF-AGENT] controller agent launching (sf-agent.js)"
            End If
        End If
    Else
        Print "[SF-AGENT] controller agent not started (disabled or 3 unhealthy boots)"
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

    ' ── HDMI hotplug: roVideoMode is created LAZILY, only AFTER the page has
    ' loaded (first load-complete). Creating it during the boot window — while
    ' the Chromium compositor is still bringing up the hardware video plane AND
    ' a live HDMI-In signal is already present — races the HDMI-input bring-up.
    ' SetMode() is NEVER called — that is the banned call that crashes (&hf4).
    gaa.videomode = Invalid

    ' ── Event loop: retry the load, HDMI hotplug, reboot requests, watchdog ───
    attempt = 0
    quietWaits = 0      ' 5-second waits that ended with no event (a time measure that events cannot inflate)
    While true
        msg = Wait(5000, msgPort)
        If msg = Invalid Then quietWaits = quietWaits + 1
        mt = Type(msg)
        If mt = "roHtmlWidgetEvent" Then
            data = msg.GetData()
            If Type(data) = "roAssociativeArray" Then
                If data.reason = "load-complete" Then
                    Print "[SF] load-complete — player running from localhost"
                    attempt = 0
                    If gaa.videomode = Invalid Then
                        gaa.videomode = CreateObject("roVideoMode")
                        If gaa.videomode <> Invalid Then
                            gaa.videomode.SetPort(msgPort)
                            Print "[SF-HDMI] roVideoMode listening (post-load) for HDMI hotplug"
                        Else
                            Print "[SF-HDMI] roVideoMode unavailable — hotplug reload disabled"
                        End If
                    End If
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

        ' server.js asks for a reboot after installing an update (or on request).
        If CreateObject("roReadFile", "sd:/sf-reboot-request") <> Invalid Then
            Print "[SF] reboot requested by server.js"
            DeleteFile("sd:/sf-reboot-request")
            RebootSystem()
        End If

        ' Pending update watchdog: check about once a minute; give up after at
        ' least 10 minutes (120 quiet waits — events only make this slower).
        If pendingUpdate And msg = Invalid And (quietWaits Mod 12) = 0 Then
            cur = ParseConfig("sd:/sf-update.json")
            If Type(cur) = "roAssociativeArray" Then
                If Not IsTrue(cur.pending) Then
                    pendingUpdate = false
                    Print "[SF-UPD] update confirmed healthy"
                Else If quietWaits >= 120 Then
                    Print "[SF-UPD] update not confirmed within 10 minutes — rolling back"
                    RollBack(cur)
                    RebootSystem()
                End If
            End If
        End If
    End While
End Sub

' ---------------------------------------------------------------------------
'  RollBack — restore the previous version's files from sd:/sf-prev/ and mark
'  the update as rolled back so it is not retried until a newer version ships.
' ---------------------------------------------------------------------------
Sub RollBack(upd As Object)
    If Type(upd.files) = "roArray" Then
        For Each name In upd.files
            src = "sd:/sf-prev/" + name
            If CreateObject("roReadFile", src) <> Invalid Then
                DeleteFile("sd:/" + name)
                CopyFile(src, "sd:/" + name)
                Print "[SF-UPD] restored " + name
            End If
        Next
    End If
    state = { pending: false, rolled_back: true, failed_version: upd.version, version: upd.previous }
    WriteAsciiFile("sd:/sf-update.json", FormatJson(state))
End Sub

' ---------------------------------------------------------------------------
'  IsTrue / IsFalse — type-safe boolean tests. Comparing Invalid (missing key)
'  or a non-boolean to true/false can raise a type-mismatch runtime error and
'  stop the launcher, so never compare JSON values to booleans directly.
' ---------------------------------------------------------------------------
Function IsTrue(v As Dynamic) As Boolean
    If v = Invalid Then Return false
    t = Type(v)
    If t = "roBoolean" Or t = "Boolean" Then Return v
    Return false
End Function

Function IsFalse(v As Dynamic) As Boolean
    If v = Invalid Then Return false
    t = Type(v)
    If t = "roBoolean" Or t = "Boolean" Then Return Not v
    Return false
End Function

' ---------------------------------------------------------------------------
'  ParseConfig — read + JSON-parse a file, returning Invalid on any failure.
' ---------------------------------------------------------------------------
Function ParseConfig(filePath As String) As Object
    txt = ReadAsciiFile(filePath)
    If txt = "" Then Return Invalid
    aa = ParseJson(txt)
    Return aa
End Function
