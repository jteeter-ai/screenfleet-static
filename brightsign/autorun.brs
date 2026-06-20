' ScreenFleet Native BrightSign Package - autorun.brs
' v31b + Activation — Zero-touch provisioning for new players
' Generated: see config.json
'
' BOOT MODES:
'   A) Normal boot  — config.json has screenToken + screenId → plays content
'   B) First boot   — config.json missing or empty screenToken → activation flow:
'        1. Call registerPlayerDevice → get activation code
'        2. Load activate.html → show QR + code
'        3. Call InjectJavascript("sfSetActivationCode(...)") → page renders QR
'        4. Poll pollPlayerActivation every 12s
'        5. On claimed → write config.json to SD card → navigate to index.html
'
' BANNED OS 9.x APIs (all crash with runtime error &hf4):
'   roVideoMode.SetMode(), roVideoMode.GetHdmiInputStatus()
'   SetVideoZOrder(), roDeviceInfo.GetDisplayMode()
'   roVideoPlayer / roVideoInput
'   roAssetFetcher.Download()
'   String.Tokenize() on primitive strings

Function ReadConfig() As Object
    xfer = CreateObject("roUrlTransfer")
    xfer.SetUrl("file:///config.json")
    raw = xfer.GetToString()
    If raw = "" Or raw = Invalid Then Return Invalid
    cfg = ParseJson(raw)
    If cfg = Invalid Then Return Invalid
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
                        hasUrl  = item.file_url  <> Invalid And item.file_url  <> ""
                        hasName = item.local_name <> Invalid And item.local_name <> ""
                        If hasUrl And hasName Then
                            total = total + 1
                            localPath = "sd:/media/" + item.local_name
                            existXfer = CreateObject("roUrlTransfer")
                            existXfer.SetUrl("file:///" + localPath)
                            existing = existXfer.GetToString()
                            If existing <> "" And existing <> Invalid Then
                                Print "[SF-MEDIA] Exists, skip: " + item.local_name
                            Else
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

' ── WriteConfig ───────────────────────────────────────────────────────────────
' Writes config.json to SD card after successful activation.
' Called when pollPlayerActivation returns status=claimed.
Sub WriteConfig(apiOrigin As String, screenToken As String, screenId As String, scrW As Integer, scrH As Integer)
    q = Chr(34)
    cfgJson = "{" + Chr(10)
    cfgJson = cfgJson + "  " + q + "apiOrigin" + q + ": " + q + apiOrigin + q + "," + Chr(10)
    cfgJson = cfgJson + "  " + q + "screenToken" + q + ": " + q + screenToken + q + "," + Chr(10)
    cfgJson = cfgJson + "  " + q + "screenId" + q + ": " + q + screenId + q + "," + Chr(10)
    cfgJson = cfgJson + "  " + q + "screenWidth" + q + ": " + Str(scrW) + "," + Chr(10)
    cfgJson = cfgJson + "  " + q + "screenHeight" + q + ": " + Str(scrH) + "," + Chr(10)
    cfgJson = cfgJson + "  " + q + "pollIntervalMs" + q + ": 60000," + Chr(10)
    cfgJson = cfgJson + "  " + q + "packageVersion" + q + ": " + q + "v31b" + q + Chr(10)
    cfgJson = cfgJson + "}"
    If WriteAsciiFile("sd:/config.json", cfgJson) Then
        Print "[SF-ACTIVATE] config.json written to SD card"
    Else
        Print "[SF-ACTIVATE] ERROR: WriteAsciiFile failed for config.json"
    End If
End Sub

' ── GenerateDeviceId ──────────────────────────────────────────────────────────
' Generates a stable device ID from the BrightSign serial number.
' Serial number is hardware-stable and survives reboots and app updates.
Function GenerateDeviceId() As String
    ' Do NOT use roDeviceInfo — GetDeviceUniqueId() and GetModel() crash on OS 9.x Strata.
    ' Instead: read a saved device ID file from SD card.
    ' If none exists, generate a random one and save it.
    ' This ID survives reboots and app updates as long as the SD card is present.
    idPath = "sd:/sf-device-id.txt"
    xfer = CreateObject("roUrlTransfer")
    xfer.SetUrl("file:///" + idPath)
    existing = xfer.GetToString()
    If existing <> "" And existing <> Invalid Then
        existing = existing.Trim()
        If Len(existing) > 4 Then
            Print "[SF-ACTIVATE] Device ID (from file): " + existing
            Return existing
        End If
    End If
    ' Generate new random ID
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    newId = "bs-"
    For i = 1 To 16
        idx = Int(Rnd(0) * Len(chars)) + 1
        newId = newId + Mid(chars, idx, 1)
    Next i
    WriteAsciiFile(idPath, newId)
    Print "[SF-ACTIVATE] Device ID (new): " + newId
    Return newId
End Function

' ── RunActivationFlow ─────────────────────────────────────────────────────────
' Called when no valid config.json exists on the SD card.
' Shows the activation screen, registers with backend, polls for claim,
' writes config.json on success, returns to caller to boot normally.
' Returns true if activation succeeded, false if it should keep waiting.
Sub RunActivationFlow(h As Object, msgPort As Object, apiOrigin As String)
    Print "[SF-ACTIVATE] Starting activation flow"

    deviceId = GenerateDeviceId()
    q = Chr(34)

    ' ── Step 1: Register with backend ────────────────────────────────────────
    regBody = "{" + q + "device_id" + q + ":" + q + deviceId + q + "," + q + "player_type" + q + ":" + q + "brightsign" + q + "," + q + "player_version" + q + ":" + q + "v31b" + q + "}"
    regResp = HttpPost(apiOrigin + "/functions/registerPlayerDevice", regBody)

    If regResp = "" Then
        Print "[SF-ACTIVATE] registerPlayerDevice failed — no network?"
        h.InjectJavascript("document.getElementById('statusText').textContent='No network — retrying...'")
        Wait(10000, msgPort)
        Return
    End If

    regData = ParseJson(regResp)
    If regData = Invalid Then
        Print "[SF-ACTIVATE] registerPlayerDevice parse failed"
        Return
    End If

    ' ── Already claimed (re-boot of previously activated player) ─────────────
    If regData.status = "claimed" Then
        Print "[SF-ACTIVATE] Device already claimed. screenToken=" + regData.screen_public_token
        If regData.screen_public_token <> Invalid And regData.screen_id <> Invalid Then
            WriteConfig(apiOrigin, regData.screen_public_token, regData.screen_id, 1920, 1080)
            Print "[SF-ACTIVATE] Config written from existing claim. Rebooting."
            RebootSystem()
        End If
        Return
    End If

    ' ── Pending: show activation screen ──────────────────────────────────────
    activationCode = regData.activation_code
    activateUrl = regData.activate_url
    If activationCode = Invalid Or activationCode = "" Then
        Print "[SF-ACTIVATE] No activation_code in response"
        Return
    End If

    Print "[SF-ACTIVATE] Code: " + activationCode + " URL: " + activateUrl

    ' Tell the HTML page to render the QR + code
    ' sfSetActivationCode(code, activateUrl, deviceId) is defined in activate.html
    jsCall = "sfSetActivationCode(" + q + activationCode + q + "," + q + activateUrl + q + "," + q + deviceId + q + ")"
    h.InjectJavascript(jsCall)

    ' ── Step 2: Poll for activation ───────────────────────────────────────────
    pollTimer = NewTimer()
    pollCount = 0
    pollBody = "{" + q + "device_id" + q + ":" + q + deviceId + q + "}"

    While true
        ' Use Wait instead of Sleep so the message port stays alive.
        ' Sleep blocks all BrightScript events including roHtmlWidgetEvent.
        waitMsg = Wait(12000, msgPort)
        If Type(waitMsg) = "roHtmlWidgetEvent" Then
            waitData = waitMsg.GetData()
            If Type(waitData) = "roAssociativeArray" Then
                If waitData.reason = "load-complete" Then
                    Print "[SF-ACTIVATE] activate.html load-complete — re-injecting code"
                    h.InjectJavascript(jsCall)
                End If
            End If
        End If
        pollCount = pollCount + 1
        Print "[SF-ACTIVATE] Poll #" + Str(pollCount)

        pollResp = HttpPost(apiOrigin + "/functions/pollPlayerActivation", pollBody)
        If pollResp = "" Then
            Print "[SF-ACTIVATE] Poll failed (offline?)"
        Else
            pollData = ParseJson(pollResp)
            If pollData <> Invalid Then
                If pollData.status = "claimed" Then


                    safeToken = ""
                    safeId = ""
                    If pollData.screen_public_token <> Invalid Then safeToken = pollData.screen_public_token
                    If pollData.screen_id <> Invalid Then safeId = pollData.screen_id
                    Print "[SF-ACTIVATE] CLAIMED! screenToken=" + safeToken
                    Print "[SF-ACTIVATE] screenId=" + safeId

                    ' Show success overlay in HTML
                    h.InjectJavascript("document.getElementById('claimedOverlay').className='claimed-overlay show'")
                    Wait(2000, msgPort)

                    ' Write config.json to SD card.
                    ' screen_id may be missing if pollPlayerActivation backend not yet updated.
                    ' Write what we have — player will fetch screenId from payload on next boot.
                    If safeToken <> "" Then
                        WriteConfig(apiOrigin, safeToken, safeId, 1920, 1080)
                        Print "[SF-ACTIVATE] Config written. Rebooting to play content."
                        Wait(1500, msgPort)
                        RebootSystem()
                    Else
                        Print "[SF-ACTIVATE] ERROR: claimed but missing screen_public_token"
                    End If
                    Return

                Else If pollData.status = "upgrade_required" Then
                    Print "[SF-ACTIVATE] Upgrade required"
                    h.InjectJavascript("document.getElementById('statusText').textContent='Subscription upgrade required — visit app.screenfleet.io'")

                Else
                    ' Still pending
                    Print "[SF-ACTIVATE] Still pending"
                End If
            End If
        End If

        ' Every 5 minutes, re-register to refresh the code expiry
        If GetElapsedSecs(pollTimer) > 300 Then
            pollTimer = NewTimer()
            Print "[SF-ACTIVATE] Refreshing activation code"
            reregResp = HttpPost(apiOrigin + "/functions/registerPlayerDevice", regBody)
            If reregResp <> "" Then
                reregData = ParseJson(reregResp)
                If reregData <> Invalid And reregData.activation_code <> Invalid Then
                    If reregData.activation_code <> activationCode Then
                        activationCode = reregData.activation_code
                        activateUrl = reregData.activate_url
                        jsCall2 = "sfSetActivationCode(" + q + activationCode + q + "," + q + activateUrl + q + "," + q + deviceId + q + ")"
                        h.InjectJavascript(jsCall2)
                        Print "[SF-ACTIVATE] Code refreshed: " + activationCode
                    End If
                End If
            End If
        End If

    End While
End Sub

' ── Main ──────────────────────────────────────────────────────────────────────
Sub Main()
    Print "[SF] ScreenFleet v31b starting"

    ' Default API origin — overridden by config.json if present
    apiOrigin = "https://app.screenfleet.io"

    ' ── Determine screen resolution ──────────────────────────────────────────
    scrW = 1920
    scrH = 1080

    ' ── Set up message port and roVideoMode ──────────────────────────────────
    msgPort = CreateObject("roMessagePort")
    gaa = GetGlobalAA()
    gaa.vm = CreateObject("roVideoMode")
    If gaa.vm <> Invalid Then
        gaa.vm.SetPort(msgPort)
        Print "[SF] roVideoMode.SetPort() called."
    End If

    ' ── Read config.json ────────────────────────────────────────────────────
    cfg = ReadConfig()

    ' ── Check if this is a first boot (no config / no screenToken) ──────────
    isFirstBoot = false
    If cfg = Invalid Then
        isFirstBoot = true
        Print "[SF] No config.json found — first boot activation flow"
    Else If cfg.screenToken = Invalid Or cfg.screenToken = "" Then
        isFirstBoot = true
        Print "[SF] config.json has no screenToken — activation required"
    Else
        ' Use values from config
        apiOrigin = cfg.apiOrigin
        If cfg.screenWidth  <> Invalid And cfg.screenWidth  > 0 Then scrW = cfg.screenWidth
        If cfg.screenHeight <> Invalid And cfg.screenHeight > 0 Then scrH = cfg.screenHeight
    End If

    ' ── Launch roHtmlWidget ───────────────────────────────────────────────────
    r = CreateObject("roRectangle", 0, 0, scrW, scrH)
    hCfg = {
        url: "file:///activate.html",
        javascript_enabled: true,
        nodejs_enabled: true,
        brightsign_js_objects_enabled: true,
        security_params: { websecurity: false },
        inspector_server: { port: 2999 }
    }
    h = CreateObject("roHtmlWidget", r, hCfg)
    h.SetPort(msgPort)
    h.Show()

    ' ── First boot: run activation flow ─────────────────────────────────────
    If isFirstBoot Then
        Print "[SF] Running activation flow..."
        ' RunActivationFlow blocks until claimed + reboots, or keeps polling
        RunActivationFlow(h, msgPort, apiOrigin)
        ' If we get here, something went wrong — retry in 30s
        Print "[SF] Activation loop exited unexpectedly — retrying in 30s"
        Wait(30000, msgPort)
        RebootSystem()
        Return
    End If

    ' ── Normal boot: navigate to player ─────────────────────────────────────

    bootScreenId = ""
    If cfg.screenId <> Invalid Then bootScreenId = cfg.screenId
    Print "[SF] Normal boot. screenId=" + bootScreenId
    h.SetUrl("file:///index.html")

    ' Fetch payload from network in background.
    ' Use screenId if available, fall back to screenToken.
    currentVersion = ""

    fetchId = bootScreenId
    If fetchId = "" And cfg.screenToken <> Invalid Then fetchId = cfg.screenToken
    payload = FetchPayload(apiOrigin, fetchId)
    If payload <> Invalid Then
        currentVersion = payload.content_version
        SaveManifest(payload)
        If payload.zones <> Invalid Then DownloadMedia(payload.zones)
        h.InjectJavascript("sfLoadManifest();")
        Print "[SF] Payload fetched. sfLoadManifest() called."
    Else
        Print "[SF] No network payload — using saved manifest"
    End If

    Print "[SF] Entering event loop."

    versionTimer = NewTimer()
    checkInterval = 60

    While true
        msg = Wait(0, msgPort)

        If GetElapsedSecs(versionTimer) >= checkInterval Then
            versionTimer = NewTimer()
            If currentVersion <> "" Then
                If CheckVersion(apiOrigin, fetchId, currentVersion) Then
                    Print "[SF] Version changed — fetching new payload"
                    newPayload = FetchPayload(apiOrigin, fetchId)
                    If newPayload <> Invalid Then
                        SaveManifest(newPayload)
                        If newPayload.zones <> Invalid Then DownloadMedia(newPayload.zones)
                        currentVersion = newPayload.content_version
                        h.InjectJavascript("sfLoadManifest();")
                    End If
                End If
            End If
        End If

        If Type(msg) = "roHdmiInputChanged" Then
            Print "[SF-HDMI] Signal changed — calling sfReloadHdmi()"
            h.InjectJavascript("sfReloadHdmi();")
        End If

        If Type(msg) = "roHtmlWidgetEvent" Then
            data = msg.GetData()
            If Type(data) = "roAssociativeArray" Then
                If data.reason = "load-complete" Then
                    Print "[SF] load-complete - calling sfReloadHdmi()"
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
