' ScreenFleet BSN.cloud Partner App Bootstrap — autozip.brs
' ─────────────────────────────────────────────────────────────────────────────
' This file is the BSN.cloud Partner App entry point.
' App URL submitted to BrightSign: https://files.screenfleet.io/brightsign/autozip.brs
'
' WHAT THIS FILE DOES:
'   1. Downloads all ScreenFleet player files from files.screenfleet.io
'   2. Writes a blank config.json (empty screenToken triggers activation flow)
'   3. Launches autorun.brs — player shows QR code activation screen
'   4. Operator scans QR → signs in/creates ScreenFleet account → player activates
'
' FLOW AFTER THIS RUNS:
'   autorun.brs detects empty screenToken → shows QR + activation code
'   Operator scans → app.screenfleet.io/activate → picks/creates asset
'   Player auto-reboots → starts playing content
'
' TO UPDATE THE PLAYER:
'   Push updated files to files.screenfleet.io/brightsign/
'   BSN.cloud re-runs this bootstrap on next player provision

Function DownloadFile(url As String, localPath As String) As Boolean
    xfer = CreateObject("roUrlTransfer")
    If xfer = Invalid Then
        Print "[SF-BOOT] ERROR: roUrlTransfer unavailable"
        Return false
    End If
    xfer.SetUrl(url)
    ' Use sync GetToFile — simpler and reliable for bootstrap
    result = xfer.GetToFile(localPath)
    If result = 200 Or result = 0 Then
        Print "[SF-BOOT] OK: " + localPath
        Return true
    Else
        Print "[SF-BOOT] FAIL (" + Str(result) + "): " + url
        Return false
    End If
End Function

Sub Main()
    Print "[SF-BOOT] ScreenFleet BSN.cloud bootstrap starting"
    Print "[SF-BOOT] Downloading player files from files.screenfleet.io..."

    base = "https://files.screenfleet.io/brightsign/"

    ' ── Download all player files ─────────────────────────────────────────────
    ' These are the versioned files hosted at files.screenfleet.io/brightsign/
    ' Updating those files automatically updates all future BSN.cloud provisions.
    files = CreateObject("roArray", 6, false)
    files.Push("autorun.brs")
    files.Push("index.html")
    files.Push("activate.html")
    files.Push("player.js")
    files.Push("sw.js")
    files.Push("autozip.brs")

    failed = 0
    For Each f In files
        ok = DownloadFile(base + f, "sd:/" + f)
        If Not ok Then failed = failed + 1
    Next f

    If failed > 0 Then
        Print "[SF-BOOT] WARNING: " + Str(failed) + " file(s) failed to download"
        Print "[SF-BOOT] Will attempt to continue with any files that downloaded"
    Else
        Print "[SF-BOOT] All files downloaded successfully"
    End If

    ' ── Write blank config.json ───────────────────────────────────────────────
    ' Empty screenToken triggers the activation flow in autorun.brs.
    ' Operator will scan the QR code to connect this player to their account.
    ' screenToken and screenId are written to config.json after activation.
    q = Chr(34)
    cfg = "{" + Chr(10)
    cfg = cfg + "  " + q + "apiOrigin" + q + ": " + q + "https://app.screenfleet.io" + q + "," + Chr(10)
    cfg = cfg + "  " + q + "screenToken" + q + ": " + q + q + "," + Chr(10)
    cfg = cfg + "  " + q + "screenId" + q + ": " + q + q + "," + Chr(10)
    cfg = cfg + "  " + q + "screenWidth" + q + ": 1920," + Chr(10)
    cfg = cfg + "  " + q + "screenHeight" + q + ": 1080," + Chr(10)
    cfg = cfg + "  " + q + "pollIntervalMs" + q + ": 60000," + Chr(10)
    cfg = cfg + "  " + q + "packageVersion" + q + ": " + q + "v31b" + q + Chr(10)
    cfg = cfg + "}"
    If WriteAsciiFile("sd:/config.json", cfg) Then
        Print "[SF-BOOT] config.json written (blank — activation required)"
    Else
        Print "[SF-BOOT] ERROR: WriteAsciiFile failed for config.json"
    End If

    ' ── Launch autorun.brs ────────────────────────────────────────────────────
    ' autorun.brs reads config.json, detects empty screenToken,
    ' and shows the activation screen with QR code.
    Print "[SF-BOOT] Launching autorun.brs..."

    ' Check autorun.brs was downloaded before trying to run it
    xfer = CreateObject("roUrlTransfer")
    xfer.SetUrl("file:///autorun.brs")
    check = xfer.GetToString()
    If check = "" Or check = Invalid Then
        Print "[SF-BOOT] FATAL: autorun.brs not found on SD card — cannot launch"
        Print "[SF-BOOT] Check network connection and try provisioning again"
        ' Show error on screen using a simple HTML widget
        msgPort = CreateObject("roMessagePort")
        r = CreateObject("roRectangle", 0, 0, 1920, 1080)
        hCfg = { url: "data:text/html,<body style='background:%2313224D;color:%23FACC16;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'><div style='text-align:center'><div style='font-size:48px;font-weight:800'>ScreenFleet</div><div style='font-size:20px;color:%238794AE;margin-top:16px'>Network error during setup.<br>Please check connection and re-provision.</div></div>", javascript_enabled: true }
        h = CreateObject("roHtmlWidget", r, hCfg)
        h.SetPort(msgPort)
        h.Show()
        ' Wait 60 seconds then reboot to retry
        Wait(60000, msgPort)
        RebootSystem()
        Return
    End If

    RunScript("sd:/autorun.brs")
End Sub
