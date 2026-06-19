' ScreenFleet Native BrightSign Package - autorun.brs
' v31b — Fix: removed GetHdmiInputStatus() which crashes on OS 9.x Strata (&hf4)
' Asset: XT1145 Spare | Resolution: 1920x1080
'
' BANNED OS 9.x APIs (never call these — all crash with &hf4):
'   roVideoMode.SetMode()
'   roVideoMode.GetHdmiInputStatus()   ← THIS was the reboot cause
'   SetVideoZOrder()
'   roDeviceInfo.GetDisplayMode()
'   roVideoPlayer / roVideoInput       ← replaced by tv:brightsign.biz/hdmi in HTML
'
' HDMI: <video src="tv:brightsign.biz/hdmi"> in index.html
' On roHdmiInputChanged: call h.InjectJavascript("sfReloadHdmi();") directly — no status check

Function ReadConfig() As Object
    xfer = CreateObject("roUrlTransfer")
    xfer.SetUrl("file:///config.json")
    raw = xfer.GetToString()
    If raw = "" Or raw = Invalid Then
        Print "[SF] FATAL: config.json not found"
        Return Invalid
    End If
    cfg = ParseJson(raw)
    If cfg = Invalid Then
        Print "[SF] FATAL: config.json parse failed"
        Return Invalid
    End If
    Print "[SF] Config loaded. screenToken=" + cfg.screenToken
    Return cfg
End Function

Function HttpPost(url As String, body As String) As String
    xfer = CreateObject("roUrlTransfer")
    xfer.SetUrl(url)
    xfer.AddHeader("Content-Type", "application/json")
    port = CreateObject("roMessagePort")
    xfer.SetPort(port)
    xfer.AsyncPostFromString(body)
    msg = Wait(15000, port)
    If Type(msg) = "roUrlEvent" Then
        result = msg.GetString()
        If result = Invalid Then Return ""
        Return result
    End If
    Print "[SF] HTTP timeout: " + url
    Return ""
End Function

Function NewTimer() As Object
    Return CreateObject("roTimeSpan")
End Function

Function GetElapsedSecs(ts As Object) As Integer
    Return ts.TotalSeconds()
End Function

Function FetchPayload(apiOrigin As String, screenId As String) As Object
    Print "[SF] Fetching payload for screenId=" + screenId
    q = Chr(34)
    body = "{" + q + "screenId" + q + ":" + q + screenId + q + "," + q + "native_mode" + q + ":true}"
    resp = HttpPost(apiOrigin + "/functions/screenPayload", body)
    If resp = "" Then
        Print "[SF] Payload fetch failed (offline?)"
        Return Invalid
    End If
    payload = ParseJson(resp)
    If payload = Invalid Or payload.status <> "ok" Then
        Print "[SF] Payload parse failed or status not ok"
        Return Invalid
    End If
    zones = 0
    If payload.zones <> Invalid Then zones = payload.zones.Count()
    Print "[SF] Payload OK. zones=" + Str(zones) + " version=" + payload.content_version
    Return payload
End Function

Sub SaveManifest(payload As Object)
    json = FormatJson(payload)
    If json = "" Or json = Invalid Then Return
    If WriteAsciiFile("sd:/sf-manifest.json", json) Then
        Print "[SF] Manifest saved"
    Else
        Print "[SF] ERROR: manifest save failed"
    End If
End Sub

Function CheckVersion(apiOrigin As String, screenId As String, currentVersion As String) As Boolean
    q = Chr(34)
    body = "{" + q + "screenId" + q + ":" + q + screenId + q + "}"
    resp = HttpPost(apiOrigin + "/functions/screenVersionCheck", body)
    If resp = "" Then Return false
    data = ParseJson(resp)
    If data = Invalid Then Return false
    newVer = data.content_version
    If newVer <> Invalid And newVer <> "" And newVer <> currentVersion Then
        Print "[SF] New version: " + newVer
        Return true
    End If
    Return false
End Function

' ── DownloadMedia ─────────────────────────────────────────────────────────────
' Downloads all media files from the payload to sd:/media/ for offline playback.
' Uses roUrlTransfer.AsyncGetToFile() — the correct and confirmed-working method
' for saving remote files to SD card on BrightSign OS 9.x.
' roAssetFetcher.Download() was removed — it does not exist on OS 9.x (&hf4).
' Files are saved as sd:/media/[local_name] and served by player.js as
' file:///SD:/media/[local_name] (BrightSign HTML widget local file path).
' Skips files that already exist on SD card (avoids re-downloading unchanged media).
Sub DownloadMedia(zones As Object)
    CreateDirectory("sd:/media")
    Print "[SF-MEDIA] Checking media for download..."
    total = 0
    saved = 0

    For Each zone In zones
        If zone.content_source_type = "playlist" Then
            If zone.playback_track <> Invalid Then
                items = zone.playback_track.items
                If items <> Invalid Then
                    For Each item In items
                        hasUrl  = item.file_url   <> Invalid And item.file_url   <> ""
                        hasName = item.local_name  <> Invalid And item.local_name  <> ""
                        If hasUrl And hasName Then
                            total = total + 1
                            localPath = "sd:/media/" + item.local_name

                            ' Check if file already exists — skip if so
                            existXfer = CreateObject("roUrlTransfer")
                            existXfer.SetUrl("file:///" + localPath)
                            existing = existXfer.GetToString()
                            If existing <> "" And existing <> Invalid Then
                                Print "[SF-MEDIA] Exists, skip: " + item.local_name
                            Else
                                ' Download file using AsyncGetToFile
                                dlPort = CreateObject("roMessagePort")
                                xfer = CreateObject("roUrlTransfer")
                                xfer.SetUrl(item.file_url)
                                xfer.SetPort(dlPort)
                                Print "[SF-MEDIA] Downloading: " + item.local_name
                                If xfer.AsyncGetToFile(localPath) Then
                                    dlTimer = NewTimer()
                                    While true
                                        dlMsg = Wait(5000, dlPort)
                                        If GetElapsedSecs(dlTimer) > 60 Then
                                            Print "[SF-MEDIA] Timeout: " + item.local_name
                                            Exit While
                                        End If
                                        If Type(dlMsg) = "roUrlEvent" Then
                                            code = dlMsg.GetResponseCode()
                                            If code = 200 Then
                                                Print "[SF-MEDIA] Saved: " + item.local_name
                                                saved = saved + 1
                                            Else
                                                Print "[SF-MEDIA] Failed (" + Str(code) + "): " + item.local_name
                                            End If
                                            Exit While
                                        End If
                                    End While
                                Else
                                    Print "[SF-MEDIA] AsyncGetToFile rejected: " + item.local_name
                                End If
                            End If
                        End If
                    Next
                End If
            End If
        End If
    Next
    Print "[SF-MEDIA] Done. " + Str(saved) + "/" + Str(total) + " file(s) downloaded."
End Sub

Sub Main()
    Print "[SF] ScreenFleet v31b starting"
    Print "[SF] Fix: GetHdmiInputStatus removed — was crashing OS 9.x with &hf4"

    cfg = ReadConfig()
    If cfg = Invalid Then Return

    screenId  = cfg.screenId
    apiOrigin = cfg.apiOrigin

    If screenId = Invalid Or screenId = "" Then
        Print "[SF] FATAL: no screenId in config.json"
        Return
    End If

    Print "[SF] screenId=" + screenId
    Print "[SF] apiOrigin=" + apiOrigin

    ' roVideoMode for HDMI hotplug events only.
    ' SetPort() so roHdmiInputChanged arrives on msgPort.
    ' NEVER call SetMode() or GetHdmiInputStatus() — both crash on OS 9.x.
    msgPort = CreateObject("roMessagePort")
    gaa = GetGlobalAA()
    gaa.vm = CreateObject("roVideoMode")
    If gaa.vm <> Invalid Then
        gaa.vm.SetPort(msgPort)
        Print "[SF] roVideoMode.SetPort() called. Hotplug events active."
    Else
        Print "[SF] WARNING: roVideoMode unavailable"
    End If

    ' Launch widget with local index.html immediately.
    ' nodejs_enabled + websecurity:false required for tv:brightsign.biz/hdmi URI.
    scrW = 1920
    scrH = 1080
    If cfg.screenWidth  <> Invalid And cfg.screenWidth  > 0 Then scrW = cfg.screenWidth
    If cfg.screenHeight <> Invalid And cfg.screenHeight > 0 Then scrH = cfg.screenHeight

    r = CreateObject("roRectangle", 0, 0, scrW, scrH)
    hCfg = {
        url: "file:///index.html",
        javascript_enabled: true,
        nodejs_enabled: true,
        brightsign_js_objects_enabled: true,
        security_params: { websecurity: false },
        inspector_server: { port: 2999 }
    }
    h = CreateObject("roHtmlWidget", r, hCfg)
    h.SetPort(msgPort)
    h.Show()
    Print "[SF] Widget shown. Splash running. HDMI via tv: URI in HTML."

    ' Background network fetch — runs after widget is already showing.
    currentVersion = ""
    payload = FetchPayload(apiOrigin, screenId)
    If payload <> Invalid Then
        currentVersion = payload.content_version
        SaveManifest(payload)
        If payload.zones <> Invalid Then DownloadMedia(payload.zones)
        h.InjectJavascript("sfLoadManifest();")
        Print "[SF] Payload fetched and saved. sfLoadManifest() called."
    Else
        Print "[SF] No network payload — player.js using sd:/sf-manifest.json"
    End If

    Print "[SF] Entering event loop."

    versionTimer = NewTimer()
    checkInterval = 60

    While true
        msg = Wait(0, msgPort)

        ' Version check every 60 seconds
        If GetElapsedSecs(versionTimer) >= checkInterval Then
            versionTimer = NewTimer()
            If currentVersion <> "" Then
                If CheckVersion(apiOrigin, screenId, currentVersion) Then
                    Print "[SF] Version changed — fetching new payload"
                    newPayload = FetchPayload(apiOrigin, screenId)
                    If newPayload <> Invalid Then
                        SaveManifest(newPayload)
                        If newPayload.zones <> Invalid Then DownloadMedia(newPayload.zones)
                        currentVersion = newPayload.content_version
                        h.InjectJavascript("sfLoadManifest();")
                        Print "[SF] Content updated. sfLoadManifest() called."
                    End If
                End If
            End If
        End If

        ' roHdmiInputChanged: HDMI source connected or signal changed.
        ' FIX v31b: Do NOT call GetHdmiInputStatus() — crashes on OS 9.x with &hf4.
        ' Simply call sfReloadHdmi() unconditionally. If the event fired, reload.
        ' The HTML <video> element handles its own error state if signal not present.
        If Type(msg) = "roHdmiInputChanged" Then
            Print "[SF-HDMI] Signal changed — calling sfReloadHdmi()"
            h.InjectJavascript("sfReloadHdmi();")
        End If

        ' roHtmlWidgetEvent: page lifecycle events
        If Type(msg) = "roHtmlWidgetEvent" Then
            data = msg.GetData()
            If Type(data) = "roAssociativeArray" Then
                If data.reason = "load-complete" Then
                    ' Call sfReloadHdmi() unconditionally on every page load.
                    ' HDMI signal often locks BEFORE the player starts (T+3.8s
                    ' in logs, player starts at T+56s). The roHdmiInputChanged
                    ' event fires and is lost before msgPort exists. This ensures
                    ' the video element always gets load()+play() after the page
                    ' is ready regardless of signal lock timing.
                    Print "[SF] load-complete - calling sfReloadHdmi() for pre-boot signal"
                    h.InjectJavascript("sfReloadHdmi();")
                Else If data.reason = "load-error" Then
                    Print "[SF] load-error — retrying in 15s"
                    Sleep(15000)
                    h.SetUrl("file:///index.html")
                End If
            End If
        End If

    End While
End Sub
